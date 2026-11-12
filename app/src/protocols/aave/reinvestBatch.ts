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
import { encodeFunctionData, getAddress, parseAbi, type Address } from 'viem'
import type { Token } from '../../config'
import { getQuote, QuoteError, type Quote, type QuoteRequest } from '../../services/quotes/quotes'
import { distributorAbi, MERKL_DISTRIBUTOR, type Claimable } from './reinvest'
import { walletSwapProblem, swapTerms } from '../../services/quotes/swapCalldata'
import { encodeCall, openCall, type OpenPlan } from './execute'
import { allowanceCalls, type BatchCall } from '../../chain/batch'

const withdrawAbi = parseAbi(['function withdraw(address asset, uint256 amount, address to) returns (uint256)'])

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
