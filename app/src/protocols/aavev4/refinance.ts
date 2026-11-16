/**
 * Refinancing an Aave v4 position (LeverageExecutorV4.refinance): the same collateral and debt move, without a swap,
 * between an Aave v4 spoke and another spoke of the same position managers, an Aave v3 pool or a Morpho market, in
 * either direction. The debt is repaid at the source with a Morpho flash loan, the collateral taken out and supplied
 * at the target, where the debt is borrowed again.
 *
 * What the executor needs, given for this transaction only:
 *   - out of a spoke: a withdraw allowance of the Taker; out of Aave v3: the collateral's aTokens;
 *   - into a spoke: a borrow allowance of the Taker; into Aave v3: a credit delegation of the debt;
 *   - on Morpho, either way: Morpho's authorization, granted and revoked around the call.
 * A wallet that sends atomic batches gets them as calls of the user around the executor's, all or nothing; otherwise
 * as signatures relayed by the contract (Taker permits with nonces n and n + 1, the aToken permit or the delegation,
 * the two Morpho authorizations), or as transactions for an account with code, which cannot sign as an EOA.
 */
import { concat, encodeFunctionData, maxUint256, numberToHex, zeroAddress, type Address, type Hash, type Hex } from 'viem'
import { debtTokenAbi, erc20Abi, morphoAbi, poolAbi, v4ExecutorAbi } from '../../chain/abi'
import { allowanceCalls, type BatchCall } from '../../chain/batch'
import { sendBatchTx, sendExecutorCall, userTx } from '../../chain/send'
import type { Progress } from '../../chain/tx'
import type { V4Net } from '../../config'
import { guardOf as guard } from '../common'
import { signATokenPermit, signDelegation, type ExecutorSignature } from '../aave/signatures'
import { signAuthorizations, type AuthSigs } from '../morpho/execute'
import { marketId, type MarketParams } from '../morpho/markets'
import { approveTaker, NO_PERMIT, sendSetup, setupCalls, signPermit, takerAllowanceCalls, type V4Permit, type V4Setup } from './execute'

/** Where a position lives, for a refinance. */
export type V4Place =
  { venue: 'v4'; spoke: Address; collateralId: number; debtId: number } | { venue: 'aave'; pool: Address } | { venue: 'morpho'; market: MarketParams }

/** The contract's `Venue` enum. */
const VENUE = { v4: 0, aave: 1, morpho: 2 } as const
const NO_MARKET: MarketParams = { loanToken: zeroAddress, collateralToken: zeroAddress, oracle: zeroAddress, irm: zeroAddress, lltv: 0n }

/** The contract's `Place`. Pure, tested. */
export function placeArgs(p: V4Place) {
  return {
    venue: VENUE[p.venue],
    target: p.venue === 'v4' ? p.spoke : p.venue === 'aave' ? p.pool : zeroAddress,
    collateralId: BigInt(p.venue === 'v4' ? p.collateralId : 0),
    debtId: BigInt(p.venue === 'v4' ? p.debtId : 0),
    market: p.venue === 'morpho' ? p.market : NO_MARKET,
  }
}

const samePlace = (a: V4Place, b: V4Place) => {
  const x = placeArgs(a)
  const y = placeArgs(b)
  return (
    x.venue === y.venue &&
    x.target.toLowerCase() === y.target.toLowerCase() &&
    x.collateralId === y.collateralId &&
    x.debtId === y.debtId &&
    marketId(x.market) === marketId(y.market)
  )
}

export type V4RefinancePlan = {
  net: V4Net
  executor: Address
  user: Address
  /** 1e18 = 1.00, where the position lands */
  minHealthFactor: bigint
  from: V4Place
  to: V4Place
  /** once-per-spoke setup still missing on each v4 side (the collateral flag counts only where the position lands) */
  fromSetup?: V4Setup
  toSetup?: V4Setup
  /** to take the collateral out of `from`: Taker withdraw allowance (v4) or allowance of the collateral's aToken (Aave) */
  exit: { need: bigint; allowance: bigint; aToken?: Address }
  /** to borrow at `to`: Taker borrow allowance (v4) or credit delegation of the variable debt token (Aave) */
  enter: { need: bigint; allowance: bigint; debtToken?: Address }
  /** a Morpho side: the executor is authorized there for good already (no grant / revoke) */
  morphoAuthorized?: boolean
  /** eMode to switch an empty Aave v3 account to first */
  eModeTarget?: number
}

export type V4RefinanceOptions = {
  batch: boolean
  /** false: the account has code, allowances go by transaction */
  permit: boolean
  /** next nonce of the Taker's permits and of Morpho's authorizations */
  takerNonce: bigint
  morphoNonce: bigint
}

/** No Morpho authorization by signature (deadline 0). */
export const NO_AUTH: AuthSigs = {
  nonce: 0n,
  deadline: 0n,
  grant: { v: 0, r: `0x${'0'.repeat(64)}`, s: `0x${'0'.repeat(64)}` },
  revoke: { v: 0, r: `0x${'0'.repeat(64)}`, s: `0x${'0'.repeat(64)}` },
}

export type V4RefinanceAuth = { exit: V4Permit; enter: V4Permit; morpho: AuthSigs }
const NONE: V4RefinanceAuth = { exit: NO_PERMIT, enter: NO_PERMIT, morpho: NO_AUTH }

/** The whole position moves: the contract reads the debt and the collateral at inclusion. Pure, tested. */
export function v4RefinanceArgs(p: Pick<V4RefinancePlan, 'from' | 'to' | 'minHealthFactor'>) {
  if (p.from.venue !== 'v4' && p.to.venue !== 'v4') throw new Error('Un des deux côtés doit être un spoke Aave v4')
  if (samePlace(p.from, p.to)) throw new Error('Départ et arrivée identiques')
  return { from: placeArgs(p.from), to: placeArgs(p.to), debtAmount: maxUint256, collateralAmount: maxUint256, guard: guard(p.minHealthFactor) }
}

export function encodeV4Refinance(p: V4RefinancePlan, auth: V4RefinanceAuth = NONE): Hex {
  return encodeFunctionData({ abi: v4ExecutorAbi, functionName: 'refinance', args: [v4RefinanceArgs(p), auth] as never })
}

const hasMorpho = (p: Pick<V4RefinancePlan, 'from' | 'to'>) => p.from.venue === 'morpho' || p.to.venue === 'morpho'
const v4Tx = (p: V4RefinancePlan, spoke: Address) => ({ net: p.net, executor: p.executor, user: p.user, spoke })

/** Setup of each v4 side: the managers, and the collateral flag where the position lands. */
function setups(p: V4RefinancePlan) {
  const out: Parameters<typeof setupCalls>[0][] = []
  if (p.from.venue === 'v4' && p.fromSetup)
    out.push({ net: p.net, user: p.user, spoke: p.from.spoke, collateralId: p.from.collateralId, setup: { ...p.fromSetup, collateral: false } })
  if (p.to.venue === 'v4' && p.toSetup) out.push({ net: p.net, user: p.user, spoke: p.to.spoke, collateralId: p.to.collateralId, setup: p.toSetup })
  return out
}

function exitCalls(p: V4RefinancePlan) {
  if (p.from.venue === 'v4')
    return takerAllowanceCalls(v4Tx(p, p.from.spoke), { kind: 'withdraw', reserveId: p.from.collateralId, amount: p.exit.need, current: p.exit.allowance })
  if (p.from.venue === 'aave' && p.exit.aToken)
    return allowanceCalls('erc20', p.exit.aToken, p.executor, p.exit.need, p.exit.allowance, {
      set: 'Autoriser le contrat à prendre le collatéral déposé sur Aave',
      reset: 'Remettre l’autorisation du collatéral Aave à sa valeur',
    })
  return { before: [], after: [] }
}

function enterCalls(p: V4RefinancePlan) {
  if (p.to.venue === 'v4')
    return takerAllowanceCalls(v4Tx(p, p.to.spoke), { kind: 'borrow', reserveId: p.to.debtId, amount: p.enter.need, current: p.enter.allowance })
  if (p.to.venue === 'aave' && p.enter.debtToken)
    return allowanceCalls('delegation', p.enter.debtToken, p.executor, p.enter.need, p.enter.allowance, {
      set: 'Déléguer l’emprunt sur Aave au contrat (montant de la dette)',
      reset: 'Remettre la délégation d’emprunt à sa valeur',
    })
  return { before: [], after: [] }
}

const emodeCall = (p: V4RefinancePlan): BatchCall[] =>
  p.to.venue === 'aave' && p.eModeTarget !== undefined
    ? [{ to: p.to.pool, data: encodeFunctionData({ abi: poolAbi, functionName: 'setUserEMode', args: [p.eModeTarget] }), label: 'Activer l’eMode sur Aave' }]
    : []

const LABEL = 'Refinancer : flash loan Morpho, remboursement, déplacement du collatéral et emprunt'

/** The batch: setup, eMode, allowances, Morpho grant, the call, revoke, allowances back. Pure, tested. */
export function v4RefinanceBatch(p: V4RefinancePlan): BatchCall[] {
  const exit = exitCalls(p)
  const enter = enterCalls(p)
  const morpho = hasMorpho(p) && !p.morphoAuthorized
  const auth = (on: boolean): BatchCall => ({
    to: p.net.morpho,
    data: encodeFunctionData({ abi: morphoAbi, functionName: 'setAuthorization', args: [p.executor, on] }),
    label: on ? 'Autoriser le contrat sur Morpho (le temps du lot)' : 'Retirer l’autorisation du contrat sur Morpho',
  })
  return [
    ...setups(p).flatMap(setupCalls),
    ...emodeCall(p),
    ...exit.before,
    ...enter.before,
    ...(morpho ? [auth(true)] : []),
    { to: p.executor, data: encodeV4Refinance(p), label: LABEL },
    ...(morpho ? [auth(false)] : []),
    ...enter.after,
    ...exit.after,
  ]
}

/** An Aave v3 signature as the contract takes it: r, s, v packed. */
const packed = (s: ExecutorSignature): V4Permit => ({
  amount: s.value,
  nonce: 0n,
  deadline: s.deadline,
  signature: concat([s.r, s.s, numberToHex(s.v, { size: 1 })]),
})

/**
 * Refinances. `batch`: one atomic confirmation. Otherwise the setup and eMode by transaction when missing, then each
 * allowance by signature (by transaction for an account with code, taken back after the call), then the call.
 */
export async function executeV4Refinance(p: V4RefinancePlan, opts: V4RefinanceOptions, onStep: Progress): Promise<Hash> {
  v4RefinanceArgs(p) // checks the plan before anything is signed
  const from = { chainId: p.net.chain.id, user: p.user }
  if (opts.batch) return sendBatchTx(from, v4RefinanceBatch(p), onStep, p.executor)

  for (const s of setups(p)) await sendSetup(s, onStep)
  const em = emodeCall(p)[0]
  if (em && p.to.venue === 'aave')
    await userTx(from, { address: p.to.pool, abi: poolAbi, functionName: 'setUserEMode', args: [p.eModeTarget] }, 'Activation de l’eMode', onStep)

  const auth: V4RefinanceAuth = { ...NONE }
  /** what to take back after the call, for an account that gave its allowances by transaction */
  const undo: (() => Promise<unknown>)[] = []
  let nonce = opts.takerNonce

  if (p.exit.need > p.exit.allowance) {
    if (p.from.venue === 'v4') {
      const need = { kind: 'withdraw' as const, reserveId: p.from.collateralId }
      const tx = v4Tx(p, p.from.spoke)
      if (!opts.permit) {
        await approveTaker(tx, need, p.exit.need, 'Autorisation de retrait', onStep)
        undo.push(() => approveTaker(tx, need, p.exit.allowance, 'Retrait de l’autorisation de retrait', onStep))
      } else {
        onStep('Signature : autoriser le contrat à retirer le collatéral pour cette transaction…')
        auth.exit = await signPermit(tx, 'WithdrawPermit', p.from.collateralId, p.exit.need, nonce++)
      }
    } else if (p.from.venue === 'aave' && p.exit.aToken) {
      if (!opts.permit)
        await userTx(
          from,
          { address: p.exit.aToken, abi: erc20Abi, functionName: 'approve', args: [p.executor, p.exit.need] },
          'Approbation du collatéral Aave',
          onStep,
        )
      else {
        onStep('Signature : autoriser le contrat à prendre le collatéral sur Aave…')
        auth.exit = packed(await signATokenPermit(p.net.chain.id, p.user, p.exit.aToken, p.executor, p.exit.need))
      }
    }
  }

  if (p.enter.need > p.enter.allowance) {
    if (p.to.venue === 'v4') {
      const tx = v4Tx(p, p.to.spoke)
      if (!opts.permit) await approveTaker(tx, { kind: 'borrow', reserveId: p.to.debtId }, p.enter.need, 'Autorisation d’emprunt', onStep)
      else {
        onStep('Signature : autoriser le contrat à emprunter la dette pour cette transaction…')
        auth.enter = await signPermit(tx, 'BorrowPermit', p.to.debtId, p.enter.need, nonce++)
      }
    } else if (p.to.venue === 'aave' && p.enter.debtToken) {
      if (!opts.permit)
        await userTx(
          from,
          { address: p.enter.debtToken, abi: debtTokenAbi, functionName: 'approveDelegation', args: [p.executor, p.enter.need] },
          'Délégation d’emprunt Aave',
          onStep,
        )
      else {
        onStep('Signature : déléguer l’emprunt sur Aave au contrat…')
        auth.enter = packed(await signDelegation(p.net.chain.id, p.user, p.enter.debtToken, p.executor, p.enter.need))
      }
    }
  }

  if (hasMorpho(p) && !p.morphoAuthorized) {
    if (!opts.permit) {
      const set = (on: boolean) =>
        userTx(
          from,
          { address: p.net.morpho, abi: morphoAbi, functionName: 'setAuthorization', args: [p.executor, on] },
          on ? 'Autorisation du contrat sur Morpho' : 'Retrait de l’autorisation Morpho',
          onStep,
        )
      await set(true)
      undo.push(() => set(false))
    } else auth.morpho = await signAuthorizations(p, opts.morphoNonce, onStep)
  }

  try {
    return await sendExecutorCall(from, { address: p.executor, abi: v4ExecutorAbi, functionName: 'refinance', args: [v4RefinanceArgs(p), auth] }, onStep)
  } finally {
    // whatever the call did, no allowance given by transaction for it stays in place
    for (const u of undo.reverse()) await u()
  }
}
