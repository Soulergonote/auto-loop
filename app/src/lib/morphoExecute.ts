/**
 * LeverageExecutorMorpho calls: open, close and roll (market to market), sent with the Morpho authorization the
 * contract needs (to borrow and withdraw for the user) granted and revoked inside the same transaction:
 *   - a wallet that sends atomic batches: setAuthorization(executor, true), the call, setAuthorization(executor,
 *     false), all or nothing, plus the exact capital approval and its reset;
 *   - otherwise two EIP-712 signatures (grant with nonce n, revoke with nonce n + 1, 20 minutes) handed to the
 *     contract's `*WithAuth` function, which reverts if the authorization is still there at the end.
 * An account that already authorized the executor for good is served with the plain call.
 */
import { decodeEventLog, encodeFunctionData, hexToSignature, maxUint256, type Address, type Hash, type Hex, type Log } from 'viem'
import { signTypedData, simulateContract, waitForTransactionReceipt, writeContract, getPublicClient } from '@wagmi/core'
import { wagmiConfig } from '../wagmi'
import { erc20Abi, morphoAbi, morphoExecutorAbi } from '../abi'
import type { MorphoNet } from '../config'
import { quoteSteps, type Quote } from './quotes'
import { authorizationTypedData, type MarketParams } from './morpho'
import { allowanceCalls, sendBatch, type BatchCall } from './oneClick'
import type { Progress } from './execute'
import type { TokenInfo } from './outcome'
import { fmtAmount } from './format'

export const MORPHO_DEADLINE_SECONDS = 20 * 60

type Step = { router: Address; tokenOut: Address; data: Hex; minOut: bigint }
type Guard = { minHealthFactor: bigint; deadline: bigint }

/** What every Morpho action needs to be sent. */
export type MorphoTx = {
  net: MorphoNet
  executor: Address
  user: Address
  /** the executor is authorized on Morpho for good already: no grant / revoke */
  authorized: boolean
  /** 1e18 = 1.00 */
  minHealthFactor: bigint
}

export type MorphoOpenPlan = MorphoTx & {
  market: MarketParams
  capitalToken: Address
  capitalAmount: bigint
  /** capital → collateral, when the capital is neither the collateral nor the loan token */
  capitalQuote?: Quote
  debtAmount: bigint
  /** loan token (borrowed + capital in loan token) → collateral */
  quote?: Quote
  capitalAllowance: bigint
}

export type MorphoClosePlan = MorphoTx & {
  market: MarketParams
  /** maxUint256 = everything, repaid by shares */
  repayAmount: bigint
  collateralToWithdraw: bigint
  collateralToSell: bigint
  quote?: Quote
}

export type MorphoRollPlan = MorphoTx & {
  from: MarketParams
  to: MarketParams
  repayAmount: bigint
  collateralToMove: bigint
  /** from.collateral → to.collateral; none when both markets share the collateral */
  quote?: Quote
}

const guard = (minHealthFactor: bigint): Guard => ({ minHealthFactor, deadline: BigInt(Math.floor(Date.now() / 1000) + MORPHO_DEADLINE_SECONDS) })
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

function live(q: Quote | undefined, what: string): Quote {
  if (!q) throw new Error(`Devis ${what} manquant`)
  if (q.simulated) throw new Error('Devis simulé : impossible à exécuter')
  return q
}

export function morphoOpenArgs(p: MorphoOpenPlan) {
  const m = p.market
  const capIsColl = same(p.capitalToken, m.collateralToken)
  const capIsLoan = same(p.capitalToken, m.loanToken)
  let capitalSteps: Step[] = []
  if (p.capitalAmount > 0n && !capIsColl && !capIsLoan) {
    const cq = live(p.capitalQuote, 'du capital')
    if (cq.sellAmount !== p.capitalAmount) throw new Error('Devis du capital pour un autre montant')
    capitalSteps = quoteSteps(cq, m.collateralToken)
  }
  const sold = p.debtAmount + (capIsLoan ? p.capitalAmount : 0n)
  let steps: Step[] = []
  if (sold > 0n) {
    const q = live(p.quote, 'de l’emprunt')
    if (q.sellAmount !== sold) throw new Error('Devis pour un autre montant que l’emprunt')
    steps = quoteSteps(q, m.collateralToken)
  }
  return {
    market: m,
    capitalToken: p.capitalAmount > 0n ? p.capitalToken : m.collateralToken,
    capitalAmount: p.capitalAmount,
    capitalSteps,
    debtAmount: p.debtAmount,
    steps,
    guard: guard(p.minHealthFactor),
  }
}

export function morphoCloseArgs(p: MorphoClosePlan) {
  let steps: Step[] = []
  if (p.collateralToSell > 0n) {
    const q = live(p.quote, 'de la vente')
    if (q.sellAmount !== p.collateralToSell) throw new Error('Devis pour un autre montant que le collatéral vendu')
    steps = quoteSteps(q, p.market.loanToken)
  }
  return {
    market: p.market,
    repayAmount: p.repayAmount,
    collateralToWithdraw: p.collateralToWithdraw,
    collateralToSell: p.collateralToSell,
    steps,
    guard: guard(p.minHealthFactor),
  }
}

export function morphoRollArgs(p: MorphoRollPlan) {
  if (!same(p.from.loanToken, p.to.loanToken)) throw new Error('Les deux marchés doivent prêter le même token')
  let steps: Step[] = []
  if (!same(p.from.collateralToken, p.to.collateralToken)) {
    const q = live(p.quote, 'du changement de collatéral')
    if (q.sellAmount !== p.collateralToMove) throw new Error('Devis pour un autre montant que le collatéral déplacé')
    steps = quoteSteps(q, p.to.collateralToken)
  }
  return { from: p.from, to: p.to, repayAmount: p.repayAmount, collateralToMove: p.collateralToMove, steps, guard: guard(p.minHealthFactor) }
}

type Action =
  | { name: 'open'; args: ReturnType<typeof morphoOpenArgs> }
  | { name: 'close'; args: ReturnType<typeof morphoCloseArgs> }
  | { name: 'roll'; args: ReturnType<typeof morphoRollArgs> }

export const openAction = (p: MorphoOpenPlan): Action => ({ name: 'open', args: morphoOpenArgs(p) })
export const closeAction = (p: MorphoClosePlan): Action => ({ name: 'close', args: morphoCloseArgs(p) })
export const rollAction = (p: MorphoRollPlan): Action => ({ name: 'roll', args: morphoRollArgs(p) })

export type AuthSigs = { nonce: bigint; deadline: bigint; grant: { v: number; r: Hex; s: Hex }; revoke: { v: number; r: Hex; s: Hex } }

/** Calldata of the action, plain or with the two authorization signatures. */
export function encodeAction(a: Action, auth?: AuthSigs): Hex {
  const fn = (auth ? `${a.name}WithAuth` : a.name) as 'open'
  return encodeFunctionData({ abi: morphoExecutorAbi, functionName: fn, args: (auth ? [a.args, auth] : [a.args]) as never })
}

function split(sig: Hex) {
  const { r, s, v, yParity } = hexToSignature(sig)
  return { v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s }
}

/** Grant (nonce n) and revoke (nonce n + 1) signatures for the executor, valid 20 minutes. */
export async function signAuthorizations(tx: MorphoTx, nonce: bigint, onStep: Progress): Promise<AuthSigs> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + MORPHO_DEADLINE_SECONDS)
  const base = { authorizer: tx.user, authorized: tx.executor, deadline }
  onStep('Signature 1/2 : autoriser le contrat sur Morpho pour cette transaction…')
  const grant = await signTypedData(wagmiConfig, {
    account: tx.user,
    ...authorizationTypedData(tx.net.chain.id, tx.net.morpho, { ...base, isAuthorized: true, nonce }),
  })
  onStep('Signature 2/2 : retirer cette autorisation à la fin de la transaction…')
  const revoke = await signTypedData(wagmiConfig, {
    account: tx.user,
    ...authorizationTypedData(tx.net.chain.id, tx.net.morpho, { ...base, isAuthorized: false, nonce: nonce + 1n }),
  })
  return { nonce, deadline, grant: split(grant), revoke: split(revoke) }
}

const LABELS = {
  open: 'Ouvrir : flash loan Morpho, swap, dépôt et emprunt',
  close: 'Fermer : flash loan Morpho, remboursement, retrait et swap',
  roll: 'Changer de marché : flash loan, remboursement, retrait, swap, dépôt et emprunt',
}

/** The batch: exact capital approval, grant, the call, revoke, approval back. */
export function morphoBatchCalls(tx: MorphoTx, a: Action, capital?: { token: Address; amount: bigint; allowance: bigint }): BatchCall[] {
  const auth = (on: boolean): BatchCall => ({
    to: tx.net.morpho,
    data: encodeFunctionData({ abi: morphoAbi, functionName: 'setAuthorization', args: [tx.executor, on] }),
    label: on ? 'Autoriser le contrat sur Morpho (le temps du lot)' : 'Retirer l’autorisation du contrat sur Morpho',
  })
  const cap = capital
    ? allowanceCalls('erc20', capital.token, tx.executor, capital.amount, capital.allowance, {
        set: 'Autoriser le contrat à prendre le capital (montant exact)',
        reset: 'Remettre l’autorisation du capital à sa valeur',
      })
    : { before: [], after: [] }
  return [
    ...cap.before,
    ...(tx.authorized ? [] : [auth(true)]),
    { to: tx.executor, data: encodeAction(a), label: LABELS[a.name] },
    ...(tx.authorized ? [] : [auth(false)]),
    ...cap.after,
  ]
}

async function approveTx(tx: MorphoTx, token: Address, amount: bigint, onStep: Progress) {
  onStep('Approbation du capital (transaction)…')
  const { request } = await simulateContract(wagmiConfig, {
    chainId: tx.net.chain.id,
    account: tx.user,
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [tx.executor, amount],
  })
  const hash = await writeContract(wagmiConfig, request)
  await waitForTransactionReceipt(wagmiConfig, { chainId: tx.net.chain.id, hash })
}

/**
 * Sends the action. `batch`: one atomic confirmation. Otherwise: capital approval (transaction) when needed, the two
 * signatures unless the executor is already authorized, then the call, simulated first.
 */
export async function executeMorpho(
  tx: MorphoTx,
  a: Action,
  opts: { batch: boolean; nonce: bigint; capital?: { token: Address; amount: bigint; allowance: bigint } },
  onStep: Progress,
): Promise<Hash> {
  const chainId = tx.net.chain.id
  if (opts.batch) {
    const hash = await sendBatch(chainId, tx.user, morphoBatchCalls(tx, a, opts.capital), onStep, tx.executor)
    if (!hash) throw new Error('Lot envoyé, transaction introuvable')
    return hash
  }
  if (opts.capital && opts.capital.amount > 0n && opts.capital.allowance < opts.capital.amount)
    await approveTx(tx, opts.capital.token, opts.capital.amount, onStep)
  const auth = tx.authorized ? undefined : await signAuthorizations(tx, opts.nonce, onStep)
  onStep('Simulation…')
  const fn = (auth ? `${a.name}WithAuth` : a.name) as 'open'
  const { request } = await simulateContract(wagmiConfig, {
    chainId,
    account: tx.user,
    address: tx.executor,
    abi: morphoExecutorAbi,
    functionName: fn,
    args: (auth ? [a.args, auth] : [a.args]) as never,
  })
  onStep('Confirmation de la transaction dans le portefeuille…')
  const hash = await writeContract(wagmiConfig, request as never)
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId, hash })
  if (receipt.status !== 'success') throw new Error('La transaction a échoué')
  return hash
}

/** Removes a permanent authorization of the executor (one transaction). */
export async function revokeMorphoAuthorization(net: MorphoNet, user: Address, executor: Address): Promise<Hash> {
  const { request } = await simulateContract(wagmiConfig, {
    chainId: net.chain.id,
    account: user,
    address: net.morpho,
    abi: morphoAbi,
    functionName: 'setAuthorization',
    args: [executor, false],
  })
  const hash = await writeContract(wagmiConfig, request)
  await waitForTransactionReceipt(wagmiConfig, { chainId: net.chain.id, hash })
  return hash
}

// ---------------------------------------------------------------------------------------------------------------------
// What the transaction really did (contract events)
// ---------------------------------------------------------------------------------------------------------------------

export type MorphoOutcome =
  | { kind: 'open'; supplied: bigint; borrowed: bigint; healthFactor: bigint }
  | { kind: 'close'; debtRepaid: bigint; collateralWithdrawn: bigint; collateralReturned: bigint; loanReturned: bigint; healthFactor: bigint }
  | { kind: 'roll'; debtRepaid: bigint; collateralWithdrawn: bigint; collateralSupplied: bigint; debtBorrowed: bigint; healthFactor: bigint }

/** The executor's own event for `user` in these logs. */
export function decodeMorphoOutcome(logs: Log[], executor: Address, user: Address): MorphoOutcome | undefined {
  for (const l of logs) {
    if (!same(l.address, executor)) continue
    try {
      const e = decodeEventLog({ abi: morphoExecutorAbi, data: l.data, topics: l.topics })
      if (!('user' in e.args) || !same(e.args.user as Address, user)) continue
      if (e.eventName === 'PositionOpened')
        return { kind: 'open', supplied: e.args.collateralSupplied, borrowed: e.args.debtBorrowed, healthFactor: e.args.healthFactor }
      if (e.eventName === 'PositionClosed') return { kind: 'close', ...e.args.result }
      if (e.eventName === 'PositionRolled') return { kind: 'roll', ...e.args.result }
    } catch {
      // another event of the executor (Swapped)
    }
  }
  return undefined
}

export async function readMorphoOutcome(chainId: number, hash: Hash, executor: Address, user: Address): Promise<MorphoOutcome | undefined> {
  try {
    const receipt = await getPublicClient(wagmiConfig, { chainId })!.getTransactionReceipt({ hash })
    return decodeMorphoOutcome(receipt.logs, executor, user)
  } catch {
    return undefined
  }
}

const hf = (x: bigint) => (x >= maxUint256 / 2n ? '∞' : (Number(x / 10n ** 14n) / 10_000).toFixed(2).replace('.', ','))

export function morphoOutcomeLines(o: MorphoOutcome, collateral: TokenInfo, loan: TokenInfo, to?: TokenInfo): string[] {
  const c = (x: bigint, t = collateral) => `${fmtAmount(x, t.decimals)} ${t.symbol}`
  const l = (x: bigint) => `${fmtAmount(x, loan.decimals)} ${loan.symbol}`
  if (o.kind === 'open') return [`Déposé : ${c(o.supplied)}`, `Emprunté : ${l(o.borrowed)}`, `Health factor : ${hf(o.healthFactor)}`]
  if (o.kind === 'close')
    return [
      `Remboursé : ${l(o.debtRepaid)}`,
      `Collatéral retiré : ${c(o.collateralWithdrawn)}`,
      ...(o.collateralReturned > 0n ? [`Rendu : ${c(o.collateralReturned)}`] : []),
      ...(o.loanReturned > 0n ? [`Rendu : ${l(o.loanReturned)}`] : []),
      `Health factor : ${hf(o.healthFactor)}`,
    ]
  return [
    `Remboursé sur l’ancien marché : ${l(o.debtRepaid)}`,
    `Collatéral retiré : ${c(o.collateralWithdrawn)}`,
    `Déposé sur le nouveau marché : ${c(o.collateralSupplied, to ?? collateral)}`,
    `Emprunté sur le nouveau marché : ${l(o.debtBorrowed)}`,
    `Health factor : ${hf(o.healthFactor)}`,
  ]
}

export { maxUint256 as REPAY_ALL }
