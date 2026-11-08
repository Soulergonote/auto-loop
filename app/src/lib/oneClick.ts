/**
 * "Réclamer et réinvestir" in one confirmation: every step of the reinvest flow as one atomic batch of calls
 * (EIP-5792 `wallet_sendCalls`, with `forceAtomic`), sent from the user's own account. All calls pass or none does.
 *
 * Safety, in order of the batch:
 *   - claim: Merkl's Distributor pays the caller's own rewards;
 *   - aTokens of other reserves are withdrawn to the user;
 *   - each reward swap uses a calldata read before signing (swapCalldata.ts): same tokens, exact amount sold, output
 *     paid to the user, no fee, minimum ≥ the app's. The approval to the router is for that amount, and the
 *     allowance is put back to what it was right after the swap (0 most of the time);
 *   - the capital handed to the contract is the sum of those decoded minimums: if a swap returns less, the contract's
 *     pull of that capital fails and the whole batch reverts;
 *   - the contract's `open` checks its own swap's minimum on-chain (and, v2, the health factor and a deadline); the collateral approval and
 *     the credit delegation are for the exact amounts and are put back to their previous values after it.
 */
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hash, type Hex } from 'viem'
import { getPublicClient, readContract, sendCalls, waitForCallsStatus } from '@wagmi/core'
import { useCapabilities } from 'wagmi'
import { wagmiConfig } from '../wagmi'
import { debtTokenAbi, erc20Abi, poolAbi } from '../abi'
import type { Token } from '../config'
import { getQuote, QuoteError, type Quote, type QuoteRequest } from './quotes'
import { distributorAbi, MERKL_DISTRIBUTOR, type Claimable } from './reinvest'
import { walletSwapProblem, swapTerms } from './swapCalldata'
import { aTokensToApprove, type SwapCollateralPlan } from './swapCollateral'
import { capitalTokenOf, closeCall, encodeCall, openCall, swapCollateralCall, type ClosePlan, type OpenPlan, type Progress } from './execute'

const withdrawAbi = parseAbi(['function withdraw(address asset, uint256 amount, address to) returns (uint256)'])

export type BatchCall = { to: Address; data: Hex; label: string }

/** A quote for a swap made from the user's wallet, refused unless its calldata does what the quote says. */
export async function walletQuote(req: QuoteRequest & { taker: Address }, signal?: AbortSignal): Promise<Quote> {
  const q = await getQuote(req, signal)
  if (q.simulated) return q
  const problem = walletSwapProblem(q.aggregator, q.data, {
    sell: req.sell.address,
    buy: req.buy.address,
    amount: req.sellAmount,
    user: req.taker,
    minOut: q.minOut,
  })
  if (problem) throw new QuoteError(`Devis refusé : ${problem}`)
  return q
}

export type WalletSwap = { sell: Token; amount: bigint; quote: Quote; /** allowance of `sell` to the quote's router now */ allowance: bigint }

/** Collateral the swaps guarantee to the wallet: the minimum written in each calldata, checked again here. */
export function swapCapital(swaps: WalletSwap[], buy: Address, user: Address): bigint {
  let total = 0n
  for (const s of swaps) {
    if (s.quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
    const problem = walletSwapProblem(s.quote.aggregator, s.quote.data, { sell: s.sell.address, buy, amount: s.amount, user, minOut: s.quote.minOut })
    if (problem) throw new Error(`Devis ${s.sell.symbol} refusé : ${problem}`)
    total += swapTerms(s.quote.aggregator, s.quote.data, user)!.minOut
  }
  return total
}

/** Exact approval before a use and the previous value back after it; nothing when the allowance already covers it. */
function allowanceCalls(
  kind: 'erc20' | 'delegation',
  token: Address,
  spender: Address,
  need: bigint,
  current: bigint,
  label: { set: string; reset: string },
): { before: BatchCall[]; after: BatchCall[] } {
  if (need === 0n || current >= need) return { before: [], after: [] }
  const call = (amount: bigint, text: string): BatchCall => ({
    to: token,
    data:
      kind === 'erc20'
        ? encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
        : encodeFunctionData({ abi: debtTokenAbi, functionName: 'approveDelegation', args: [spender, amount] }),
    label: text,
  })
  // tokens like USDT refuse to change a non-zero allowance to another non-zero value
  const before = kind === 'erc20' && current > 0n ? [call(0n, label.reset), call(need, label.set)] : [call(need, label.set)]
  return { before, after: [call(current, label.reset)] }
}

export type ReinvestBatch = {
  user: Address
  rewards: Claimable[]
  pool: Address
  withdrawals: { token: Token; amount: bigint }[]
  swaps: WalletSwap[]
  /** rewards that are the collateral itself, already in the wallet once claimed */
  capitalDirect: bigint
  collateral: Token
  debt: Token
  variableDebtToken: Address
  executor: Address
  /** contract version of `executor` */
  version?: 1 | 2
  /** v2 guard on the account's health factor after the lever (0 = none) */
  minHealthFactor?: bigint
  collateralAllowance: bigint
  borrowAllowance: bigint
  /** debt the contract borrows to bring the position back to its leverage; 0 = nothing to lever */
  debtAmount: bigint
  leverQuote?: Quote
}

/** The calls of the batch, in order, with what each does; throws when a guard does not hold. */
export function buildReinvestBatch(p: ReinvestBatch): { calls: BatchCall[]; capital: bigint } {
  if (p.rewards.length === 0) throw new Error('Rien à réclamer')
  const user = getAddress(p.user)
  const calls: BatchCall[] = [
    {
      to: MERKL_DISTRIBUTOR,
      data: encodeFunctionData({
        abi: distributorAbi,
        functionName: 'claim',
        args: [p.rewards.map(() => user), p.rewards.map((r) => r.token), p.rewards.map((r) => r.cumulative), p.rewards.map((r) => r.proofs)],
      }),
      label: `Réclamer ${p.rewards.length} reward${p.rewards.length > 1 ? 's' : ''} sur Merkl`,
    },
  ]
  for (const w of p.withdrawals)
    calls.push({
      to: p.pool,
      data: encodeFunctionData({ abi: withdrawAbi, functionName: 'withdraw', args: [w.token.address, w.amount, user] }),
      label: `Retirer ${w.token.symbol} d’Aave`,
    })
  const capital = p.capitalDirect + swapCapital(p.swaps, p.collateral.address, user)
  for (const s of p.swaps) {
    const a = allowanceCalls('erc20', s.sell.address, s.quote.router, s.amount, s.allowance, {
      set: `Autoriser le routeur à prendre ce montant de ${s.sell.symbol}`,
      reset: `Remettre l’autorisation ${s.sell.symbol} du routeur à sa valeur`,
    })
    calls.push(...a.before, { to: s.quote.router, data: s.quote.data, label: `Échanger ${s.sell.symbol} en ${p.collateral.symbol}` }, ...a.after)
  }
  if (p.debtAmount > 0n) {
    const q = p.leverQuote
    if (!q || q.simulated) throw new Error('Pas de devis réel pour le levier')
    if (q.sellAmount !== p.debtAmount) throw new Error('Devis du levier pour un autre montant')
    const col = allowanceCalls('erc20', p.collateral.address, p.executor, capital, p.collateralAllowance, {
      set: `Autoriser le contrat à prendre ce capital en ${p.collateral.symbol}`,
      reset: `Remettre l’autorisation ${p.collateral.symbol} du contrat à sa valeur`,
    })
    const del = allowanceCalls('delegation', p.variableDebtToken, p.executor, p.debtAmount, p.borrowAllowance, {
      set: `Déléguer l’emprunt de ce montant de ${p.debt.symbol} au contrat`,
      reset: `Remettre la délégation ${p.debt.symbol} du contrat à sa valeur`,
    })
    const call = openCall({
      version: p.version,
      minHealthFactor: p.minHealthFactor,
      collateral: p.collateral.address,
      debt: p.debt.address,
      initialCollateral: capital,
      debtAmount: p.debtAmount,
      quote: q,
    } as OpenPlan)
    calls.push(
      ...col.before,
      ...del.before,
      {
        to: p.executor,
        data: encodeCall(call),
        label: 'Augmenter la position : flash loan, swap et dépôt',
      },
      ...del.after,
      ...col.after,
    )
  }
  return { calls, capital }
}

/** Whether the connected wallet can send this chain's calls as one atomic batch. */
export function useAtomicBatch(chainId: number, account: Address | undefined): boolean | undefined {
  const caps = useCapabilities({ account, chainId, query: { enabled: !!account, retry: false } })
  if (!account) return false
  if (caps.isPending) return undefined
  if (caps.isError) return false
  const c = caps.data as { atomic?: { status?: string } } | Record<number, { atomic?: { status?: string } }> | undefined
  const atomic = (c && 'atomic' in c ? c.atomic : (c as Record<number, { atomic?: { status?: string } }> | undefined)?.[chainId]?.atomic)?.status
  return atomic === 'supported' || atomic === 'ready'
}

/**
 * Sends the batch: a simulation of all the calls first when the RPC can (a failing call stops here), then one
 * confirmation in the wallet. Returns the transaction hash once included.
 */
export async function sendBatch(chainId: number, user: Address, calls: BatchCall[], onStep: Progress): Promise<Hash | undefined> {
  onStep('Simulation du lot…')
  const failure = await simulate(chainId, user, calls)
  if (failure) throw new Error(failure)
  onStep('Confirmation dans le portefeuille…')
  const { id } = await sendCalls(wagmiConfig, { chainId, account: user, forceAtomic: true, calls: calls.map(({ to, data }) => ({ to, data })) })
  onStep('En attente d’inclusion…')
  const status = await waitForCallsStatus(wagmiConfig, { id, timeout: 10 * 60_000 })
  if (status.status !== 'success')
    throw new Error(
      // forceAtomic: a wallet that cannot keep the batch atomic must refuse it; say so if one ran part of it anyway
      status.atomic === false
        ? 'Le lot a échoué en partie : vérifier les transactions dans le portefeuille.'
        : 'Le lot a échoué : aucune de ses opérations n’a eu lieu.',
    )
  return status.receipts?.at(-1)?.transactionHash
}

/**
 * "Ouvrir" as one batch: eMode switch if needed, exact collateral approval, exact credit delegation, `open`, then
 * the approval and the delegation back to their previous values. Same contract call as the step flow.
 */
export function openBatchCalls(p: OpenPlan, allowances: { collateral: bigint; borrow: bigint }): BatchCall[] {
  if (p.quote.simulated || p.capitalQuote?.simulated) throw new Error('Devis simulé : impossible à exécuter')
  const open = encodeCall(openCall(p)) // also checks the amounts of the quotes
  const col = allowanceCalls('erc20', capitalTokenOf(p), p.executor, p.initialCollateral, allowances.collateral, {
    set: 'Autoriser le contrat à prendre le capital (montant exact)',
    reset: 'Remettre l’autorisation du capital à sa valeur',
  })
  const del = allowanceCalls('delegation', p.variableDebtToken, p.executor, p.debtAmount, allowances.borrow, {
    set: 'Déléguer l’emprunt au contrat (montant exact)',
    reset: 'Remettre la délégation d’emprunt à sa valeur',
  })
  const emode: BatchCall[] =
    p.eModeTarget === undefined
      ? []
      : [
          {
            to: p.pool,
            data: encodeFunctionData({ abi: poolAbi, functionName: 'setUserEMode', args: [p.eModeTarget] }),
            label: p.eModeTarget === 0 ? 'Sortir de l’eMode sur le compte Aave' : 'Passer le compte Aave en eMode',
          },
        ]
  return [...emode, ...col.before, ...del.before, { to: p.executor, data: open, label: 'Ouvrir : flash loan, swap et dépôt' }, ...del.after, ...col.after]
}

/** "Fermer" as one batch: exact aToken approval (a little headroom on a full close), `close`, approval back after. */
export function closeBatchCalls(p: ClosePlan, aTokenAllowance: bigint): BatchCall[] {
  if (p.quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
  if (p.quote.sellAmount !== p.collateralToSell) throw new Error('Devis pour un autre montant que le collatéral vendu')
  // aToken balances grow every block: a full close pulls the balance at inclusion
  const need = p.full ? (p.aTokensNeeded * 1001n) / 1000n : p.aTokensNeeded
  const a = allowanceCalls('erc20', p.aToken, p.executor, need, aTokenAllowance, {
    set: 'Autoriser le contrat à prendre ces aTokens (montant exact)',
    reset: 'Remettre l’autorisation des aTokens à sa valeur',
  })
  return [
    ...a.before,
    {
      to: p.executor,
      data: encodeCall(closeCall(p)),
      label: 'Fermer : flash loan, remboursement, retrait et swap',
    },
    ...a.after,
  ]
}

/** "Changer de collatéral" as one batch: exact aToken approval, `swapCollateral`, approval back after. */
export function swapCollateralBatchCalls(p: SwapCollateralPlan, aTokenAllowance: bigint): BatchCall[] {
  const call = encodeCall(swapCollateralCall(p))
  const a = allowanceCalls('erc20', p.fromAToken, p.executor, aTokensToApprove(p), aTokenAllowance, {
    set: 'Autoriser le contrat à prendre ces aTokens (montant exact)',
    reset: 'Remettre l’autorisation des aTokens à sa valeur',
  })
  return [...a.before, { to: p.executor, data: call, label: 'Changer de collatéral : flash loan, dépôt, retrait et swap' }, ...a.after]
}

/** Changes the collateral in one confirmation, with the aToken allowance read now. */
export async function executeSwapCollateralBatch(p: SwapCollateralPlan, onStep: Progress): Promise<Hash | undefined> {
  onStep('Lecture des autorisations…')
  const allowance = await readContract(wagmiConfig, {
    chainId: p.chainId,
    address: p.fromAToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [p.user, p.executor],
  })
  return sendBatch(p.chainId, p.user, swapCollateralBatchCalls(p, allowance), onStep)
}

/** Opens in one confirmation, with the allowances read now (not the ones the screen last polled). */
export async function executeOpenBatch(p: OpenPlan, onStep: Progress): Promise<Hash | undefined> {
  onStep('Lecture des autorisations…')
  const [collateral, borrow] = await Promise.all([
    readContract(wagmiConfig, { chainId: p.chainId, address: capitalTokenOf(p), abi: erc20Abi, functionName: 'allowance', args: [p.user, p.executor] }),
    readContract(wagmiConfig, {
      chainId: p.chainId,
      address: p.variableDebtToken,
      abi: debtTokenAbi,
      functionName: 'borrowAllowance',
      args: [p.user, p.executor],
    }),
  ])
  return sendBatch(p.chainId, p.user, openBatchCalls(p, { collateral, borrow }), onStep)
}

/** Closes in one confirmation, with the aToken allowance read now. */
export async function executeCloseBatch(p: ClosePlan, onStep: Progress): Promise<Hash | undefined> {
  onStep('Lecture des autorisations…')
  const allowance = await readContract(wagmiConfig, {
    chainId: p.chainId,
    address: p.aToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [p.user, p.executor],
  })
  return sendBatch(p.chainId, p.user, closeBatchCalls(p, allowance), onStep)
}

/** First failing call of the batch, or undefined (also when the RPC cannot simulate a batch: the wallet still does). */
async function simulate(chainId: number, user: Address, calls: BatchCall[]): Promise<string | undefined> {
  let results: readonly { status: string; error?: Error }[]
  try {
    const client = getPublicClient(wagmiConfig, { chainId })!
    results = (await client.simulateCalls({ account: user, calls: calls.map(({ to, data }) => ({ to, data })) })).results
  } catch {
    return undefined
  }
  const i = results.findIndex((r) => r.status !== 'success')
  return i < 0 ? undefined : `La simulation échoue à l’étape « ${calls[i].label} » : rien n’a été envoyé.`
}
