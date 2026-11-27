/**
 * "Réclamer et réinvestir": claim the account's Merkl rewards on a chain, turn each one into the loop's collateral,
 * then hand the collateral to the "Augmenter" flow, which levers the position back to its target.
 *
 * Every step is a transaction the user signs from their wallet; no contract of ours is involved before the last one:
 *   1. claim on Merkl's Distributor (one transaction for every token of the chain);
 *   2. per reward: aToken of the collateral → already deposited; the collateral itself → capital for step 3;
 *      aToken of another Aave reserve → withdrawn, then swapped; any other token → swapped into the collateral with
 *      the aggregator, from the wallet (exact approval, router checked like every quote);
 *   3. "Augmenter la position" with that capital, at the leverage the position had before.
 */
import { erc20Abi, parseAbi, type Address, type Hash, type Hex } from 'viem'
import { readContract, simulateContract, waitForTransactionReceipt } from '@wagmi/core'
import { useQuery } from '@tanstack/react-query'
import { useReadContracts } from 'wagmi'
import { wagmiConfig } from '../../chain/wagmi'
import { distributorAbi, poolAbi } from '../../chain/abi'
import { walletSendTransaction, walletWriteContract } from '../../chain/wallet'
import { DEMO, MERKL_DISTRIBUTOR } from '../../config'
import { userRewardsQuery, type MerklUserRewards } from '../../features/positions/positions'
import type { Quote } from '../../services/quotes/quotes'
import type { SnapReserve } from './snapshot'
import type { Progress } from '../../chain/tx'

/** Merkl's PullTokenWrapper: a reward token the Distributor pays out as `token()`, its underlying. */
const wrapperAbi = parseAbi(['function token() view returns (address)', 'function distributor() view returns (address)'])

/**
 * Underlying paid out for each Merkl wrapper among `tokens` (lower-cased keys). A token counts as a wrapper only when
 * it answers both `token()` and `distributor()` with the Distributor: any other token keeps its own address.
 */
export function wrapperUnderlyings(tokens: Address[], results: ({ result?: unknown } | undefined)[]): Map<string, Address> {
  const out = new Map<string, Address>()
  tokens.forEach((t, i) => {
    const underlying = results[2 * i]?.result
    const distributor = results[2 * i + 1]?.result
    if (typeof underlying !== 'string' || typeof distributor !== 'string') return
    if (distributor.toLowerCase() !== MERKL_DISTRIBUTOR.toLowerCase() || /^0x0{40}$/i.test(underlying)) return
    out.set(t.toLowerCase(), underlying as Address)
  })
  return out
}

/** A reward the Distributor will pay now: the Merkle tree's cumulative amount minus what was already claimed on-chain. */
export type Claimable = {
  /** token of the Merkle tree, what `claim` takes */
  token: Address
  /**
   * token the wallet receives: `token` itself, or the underlying of a Merkl wrapper (PullTokenWrapper, e.g. Monad's
   * "WMON" rewards), which the Distributor pays out unwrapped
   */
  paid: Address
  symbol: string
  decimals: number
  /** cumulative amount in the tree, what `claim` takes */
  cumulative: bigint
  /** paid by this claim */
  amount: bigint
  proofs: Hex[]
  /** USD per token from Merkl, 0 when unknown */
  price: number
}

/** Merkl's answer with the proofs the claim needs (same endpoint as the Positions screen). */
export type MerklClaimData = (MerklUserRewards[number] & {
  rewards: (MerklUserRewards[number]['rewards'][number] & { proofs?: string[]; token: { address: string } })[]
})[]

/**
 * Rewards claimable on `chainId`. `claimedOnChain` (by lower-cased token) wins over Merkl's own "claimed", which
 * lags the chain by hours: right after a claim the API still shows it as claimable.
 */
export function claimables(
  data: MerklClaimData | undefined,
  chainId: number,
  claimedOnChain: Map<string, bigint>,
  unwrapped: Map<string, Address> = new Map(),
): Claimable[] {
  return (data ?? [])
    .filter((c) => c.chain.id === chainId)
    .flatMap((c) => c.rewards)
    .flatMap((r) => {
      const token = r.token.address as Address
      const cumulative = BigInt(r.amount)
      const claimed = claimedOnChain.get(token.toLowerCase()) ?? BigInt(r.claimed)
      const amount = cumulative - claimed
      if (amount <= 0n || !r.proofs?.length) return []
      const paid = unwrapped.get(token.toLowerCase()) ?? token
      return [{ token, paid, symbol: r.token.symbol, decimals: r.token.decimals, cumulative, amount, proofs: r.proofs as Hex[], price: r.token.price ?? 0 }]
    })
}

export const usdValue = (c: Pick<Claimable, 'amount' | 'decimals' | 'price'>) => (Number(c.amount) / 10 ** c.decimals) * c.price

/** Under this a swap costs more in gas and slippage than it brings: the token stays in the wallet. */
export const MIN_SWAP_USD = 1

export type RewardAction =
  /** an aToken of the collateral: the claim deposits it */
  | { kind: 'deposited' }
  /** the collateral itself: capital for "Augmenter" */
  | { kind: 'capital' }
  /** an aToken of another reserve: withdrawn to its underlying, then swapped */
  | { kind: 'withdraw'; reserve: SnapReserve; swap: boolean }
  /** any other token: swapped into the collateral */
  | { kind: 'swap' }
  /** worth less than MIN_SWAP_USD, or of unknown value: left in the wallet */
  | { kind: 'keep' }

/** What happens to each claimed reward, given the market's reserves and the loop's collateral. */
export function rewardAction(c: Claimable, reserves: SnapReserve[], collateral: Address): RewardAction {
  // judged on what the wallet receives: a wrapper's underlying
  const token = c.paid.toLowerCase()
  const col = collateral.toLowerCase()
  if (token === col) return { kind: 'capital' }
  const reserve = reserves.find((r) => r.aToken.toLowerCase() === token)
  if (reserve && reserve.token.address.toLowerCase() === col) return { kind: 'deposited' }
  // value of an aToken: its underlying's oracle price when Merkl gives none
  const usd = c.price > 0 ? usdValue(c) : reserve ? (Number(c.amount) / 10 ** c.decimals) * (Number(reserve.price) / 1e8) : 0
  const swap = usd >= MIN_SWAP_USD
  if (reserve) {
    // the underlying of a collateral aToken would be capital directly, handled above; withdraw only what will be swapped
    return swap ? { kind: 'withdraw', reserve, swap } : { kind: 'keep' }
  }
  return swap ? { kind: 'swap' } : { kind: 'keep' }
}

/** One transaction claims every reward of the chain. */
export async function claimRewards(chainId: number, user: Address, rewards: Claimable[], onStep: Progress): Promise<Hash> {
  onStep('Simulation de la réclamation…')
  const { request } = await simulateContract(wagmiConfig, {
    chainId,
    account: user,
    address: MERKL_DISTRIBUTOR,
    abi: distributorAbi,
    functionName: 'claim',
    args: [rewards.map(() => user), rewards.map((r) => r.token), rewards.map((r) => r.cumulative), rewards.map((r) => r.proofs)],
  })
  onStep('Confirmation dans le portefeuille…')
  const hash = await walletWriteContract(request)
  return confirmed(chainId, hash, onStep, 'La réclamation a échoué')
}

/** Withdraws an aToken received as a reward to its underlying, in the user's wallet. */
export async function withdrawReward(chainId: number, pool: Address, user: Address, asset: Address, amount: bigint, onStep: Progress): Promise<Hash> {
  onStep('Simulation du retrait…')
  const { request } = await simulateContract(wagmiConfig, {
    chainId,
    account: user,
    address: pool,
    abi: poolAbi,
    functionName: 'withdraw',
    args: [asset, amount, user],
  })
  onStep('Confirmation dans le portefeuille…')
  const hash = await walletWriteContract(request)
  return confirmed(chainId, hash, onStep, 'Le retrait a échoué')
}

/**
 * Swaps a reward from the wallet with an aggregator quote made for the wallet (taker = user). The approval is for
 * this amount only, so no allowance is left behind. Returns the transaction and what the wallet received, checked
 * against the minimum.
 */
export async function swapFromWallet(
  chainId: number,
  user: Address,
  sell: Address,
  buy: Address,
  quote: Quote,
  onStep: Progress,
): Promise<{ hash: Hash; received: bigint }> {
  if (quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
  const allowance = await readContract(wagmiConfig, { chainId, address: sell, abi: erc20Abi, functionName: 'allowance', args: [user, quote.router] })
  if (allowance < quote.sellAmount) {
    onStep('Approbation du token (transaction)…')
    const { request } = await simulateContract(wagmiConfig, {
      chainId,
      account: user,
      address: sell,
      abi: erc20Abi,
      functionName: 'approve',
      args: [quote.router, quote.sellAmount],
    })
    await confirmed(chainId, await walletWriteContract(request), onStep, 'L’approbation a échoué')
  }
  const before = await readContract(wagmiConfig, { chainId, address: buy, abi: erc20Abi, functionName: 'balanceOf', args: [user] })
  // the wallet estimates gas first: a route that would revert is refused before anything is spent
  onStep('Confirmation de l’échange dans le portefeuille…')
  const hash = await walletSendTransaction({ chainId, account: user, to: quote.router, data: quote.data })
  await confirmed(chainId, hash, onStep, 'L’échange a échoué')
  const after = await readContract(wagmiConfig, { chainId, address: buy, abi: erc20Abi, functionName: 'balanceOf', args: [user] })
  const received = after - before
  if (received < quote.minOut) throw new Error('L’échange a rendu moins que le minimum du devis.')
  return { hash, received }
}

async function confirmed(chainId: number, hash: Hash, onStep: Progress, failure: string): Promise<Hash> {
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId, hash })
  if (receipt.status !== 'success') throw new Error(failure)
  return hash
}

/** Claimable rewards of the account on the chain, with the Distributor's on-chain "claimed" as the source of truth. */
export function useClaimables(chainId: number, account: Address | undefined) {
  const api = useQuery({ ...userRewardsQuery(chainId, DEMO ? undefined : account), refetchInterval: 60_000 })
  const data = api.data as MerklClaimData | undefined
  const tokens = (data ?? []).filter((c) => c.chain.id === chainId).flatMap((c) => c.rewards.map((r) => r.token.address as Address))
  const onChain = useReadContracts({
    contracts: tokens.map((token) => ({ chainId, address: MERKL_DISTRIBUTOR, abi: distributorAbi, functionName: 'claimed', args: [account!, token] }) as const),
    allowFailure: true,
    query: { enabled: !!account && tokens.length > 0, refetchInterval: 30_000 },
  })
  // a wrapper's underlying is what lands in the wallet, the token to swap after the claim (read once, it never changes)
  const wrappers = useReadContracts({
    contracts: tokens.flatMap((token) => [
      { chainId, address: token, abi: wrapperAbi, functionName: 'token' } as const,
      { chainId, address: token, abi: wrapperAbi, functionName: 'distributor' } as const,
    ]),
    allowFailure: true,
    query: { enabled: tokens.length > 0, staleTime: Infinity },
  })
  const claimedOnChain = new Map<string, bigint>()
  tokens.forEach((t, i) => {
    const r = onChain.data?.[i]?.result as readonly [bigint, number, Hex] | undefined
    if (r) claimedOnChain.set(t.toLowerCase(), r[0])
  })
  const refetch = () => {
    void api.refetch()
    void onChain.refetch()
  }
  // before the on-chain read answers, nothing is offered: the API alone can show an already claimed reward
  const ready = !!data && (tokens.length === 0 || (!!onChain.data && !!wrappers.data))
  const unwrapped = wrapperUnderlyings(tokens, wrappers.data ?? [])
  return { claimables: ready ? claimables(data, chainId, claimedOnChain, unwrapped) : [], ready, error: api.error, refetch }
}
