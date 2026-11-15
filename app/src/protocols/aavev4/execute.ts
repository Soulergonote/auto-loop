/**
 * LeverageExecutorV4 calls: open and close a loop on an Aave v4 spoke. The contract acts through Aave's Giver and
 * Taker position managers, which the user makes managers of their account once per spoke (with the collateral flag,
 * in one `multicall` of the spoke), then within an allowance of the Taker given for each operation:
 *   - a wallet that sends atomic batches: setup when missing, exact capital approval, approveBorrow / approveWithdraw,
 *     the call, allowances back, all or nothing;
 *   - otherwise the setup transaction when missing, the capital approval when needed, then one EIP-712 permit of the
 *     Taker (20 minutes) handed to the contract's `*WithPermit` function, which renounces what is left of it.
 * An allowance already in place is served with the plain call. An account with code (a smart account, an EIP-7702
 * delegation) cannot sign the Taker's permit as an EOA: without batches it approves by transaction instead
 * (`permit: false`), and takes a withdraw allowance back after the close.
 */
import { decodeEventLog, encodeFunctionData, maxUint256, type Address, type Hash, type Hex, type Log } from 'viem'
import { getPublicClient, sendTransaction, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from '@wagmi/core'
import { wagmiConfig } from '../../chain/wagmi'
import { erc20Abi, v4ExecutorAbi, v4SpokeAbi, v4TakerAbi } from '../../chain/abi'
import type { V4Net } from '../../config'
import { quoteSteps, type Quote } from '../../services/quotes/quotes'
import { allowanceCalls, sendBatch, type BatchCall } from '../../chain/batch'
import type { Progress } from '../../chain/tx'
import type { TokenInfo } from '../../chain/outcome'
import { fmtAmount } from '../../ui/format'

export const V4_DEADLINE_SECONDS = 20 * 60

type Step = { router: Address; tokenOut: Address; data: Hex; minOut: bigint }
type Guard = { minHealthFactor: bigint; deadline: bigint }

/** What the once-per-spoke setup still lacks for this user. */
export type V4Setup = { giver: boolean; taker: boolean; collateral: boolean }
export const setupMissing = (s: V4Setup) => s.giver || s.taker || s.collateral

/** What every v4 action needs to be sent. */
export type V4Tx = {
  net: V4Net
  executor: Address
  user: Address
  spoke: Address
  collateralId: number
  debtId: number
  collateralToken: Address
  debtToken: Address
  /** 1e18 = 1.00 */
  minHealthFactor: bigint
  /** what is missing of the setup (true = to do) */
  setup: V4Setup
}

export type V4OpenPlan = V4Tx & {
  capitalToken: Address
  capitalAmount: bigint
  capitalAllowance: bigint
  debtAmount: bigint
  /** debt asset (borrowed + capital in debt asset) → collateral */
  quote?: Quote
  /** what the executor may already borrow for the user */
  borrowAllowance: bigint
}

export type V4ClosePlan = V4Tx & {
  /** maxUint256 = the whole debt */
  repayAmount: bigint
  /** maxUint256 = everything supplied */
  collateralToWithdraw: bigint
  collateralToSell: bigint
  quote?: Quote
  withdrawAllowance: bigint
}

const guard = (minHealthFactor: bigint): Guard => ({ minHealthFactor, deadline: BigInt(Math.floor(Date.now() / 1000) + V4_DEADLINE_SECONDS) })
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

function live(q: Quote | undefined, what: string): Quote {
  if (!q) throw new Error(`Devis ${what} manquant`)
  if (q.simulated) throw new Error('Devis simulé : impossible à exécuter')
  return q
}

export function v4OpenArgs(p: V4OpenPlan) {
  if (same(p.collateralToken, p.debtToken)) throw new Error('Collatéral et dette identiques')
  const capIsColl = same(p.capitalToken, p.collateralToken)
  const capIsDebt = same(p.capitalToken, p.debtToken)
  if (p.capitalAmount > 0n && !capIsColl && !capIsDebt) throw new Error('Le capital doit être le collatéral ou l’actif emprunté')
  const sold = p.debtAmount + (capIsDebt ? p.capitalAmount : 0n)
  let steps: Step[] = []
  if (sold > 0n) {
    const q = live(p.quote, 'de l’emprunt')
    if (q.sellAmount !== sold) throw new Error('Devis pour un autre montant que l’emprunt')
    steps = quoteSteps(q, p.collateralToken)
  }
  return {
    spoke: p.spoke,
    collateralId: BigInt(p.collateralId),
    debtId: BigInt(p.debtId),
    capitalToken: p.capitalAmount > 0n ? p.capitalToken : p.collateralToken,
    capitalAmount: p.capitalAmount,
    capitalSteps: [] as Step[],
    debtAmount: p.debtAmount,
    steps,
    guard: guard(p.minHealthFactor),
  }
}

export function v4CloseArgs(p: V4ClosePlan) {
  let steps: Step[] = []
  if (p.collateralToSell > 0n) {
    const q = live(p.quote, 'de la vente')
    if (q.sellAmount !== p.collateralToSell) throw new Error('Devis pour un autre montant que le collatéral vendu')
    steps = quoteSteps(q, p.debtToken)
  }
  return {
    spoke: p.spoke,
    collateralId: BigInt(p.collateralId),
    debtId: BigInt(p.debtId),
    repayAmount: p.repayAmount,
    collateralToWithdraw: p.collateralToWithdraw,
    collateralToSell: p.collateralToSell,
    steps,
    guard: guard(p.minHealthFactor),
  }
}

type Action = { name: 'open'; args: ReturnType<typeof v4OpenArgs> } | { name: 'close'; args: ReturnType<typeof v4CloseArgs> }
export const v4OpenAction = (p: V4OpenPlan): Action => ({ name: 'open', args: v4OpenArgs(p) })
export const v4CloseAction = (p: V4ClosePlan): Action => ({ name: 'close', args: v4CloseArgs(p) })

export type V4Permit = { amount: bigint; nonce: bigint; deadline: bigint; signature: Hex }

/** Calldata of the action, plain or with the Taker permit. */
export function encodeV4Action(a: Action, permit?: V4Permit): Hex {
  const fn = (permit ? `${a.name}WithPermit` : a.name) as 'open'
  return encodeFunctionData({ abi: v4ExecutorAbi, functionName: fn, args: (permit ? [a.args, permit] : [a.args]) as never })
}

const PERMIT_FIELDS = [
  { name: 'spoke', type: 'address' },
  { name: 'reserveId', type: 'uint256' },
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] as const

/** EIP-712 data of a Taker permit: the executor may borrow (or withdraw) up to `amount` of one reserve. Pure, tested. */
export function takerPermitTypedData(
  kind: 'BorrowPermit' | 'WithdrawPermit',
  chainId: number,
  taker: Address,
  message: { spoke: Address; reserveId: bigint; owner: Address; spender: Address; amount: bigint; nonce: bigint; deadline: bigint },
) {
  return {
    domain: { name: 'TakerPositionManager', version: '1', chainId, verifyingContract: taker },
    types: { [kind]: PERMIT_FIELDS } as Record<typeof kind, typeof PERMIT_FIELDS>,
    primaryType: kind,
    message,
  }
}

async function signPermit(tx: V4Tx, kind: 'BorrowPermit' | 'WithdrawPermit', reserveId: number, amount: bigint, nonce: bigint): Promise<V4Permit> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + V4_DEADLINE_SECONDS)
  const data = takerPermitTypedData(kind, tx.net.chain.id, tx.net.taker, {
    spoke: tx.spoke,
    reserveId: BigInt(reserveId),
    owner: tx.user,
    spender: tx.executor,
    amount,
    nonce,
    deadline,
  })
  const signature = await signTypedData(wagmiConfig, { account: tx.user, ...data } as never)
  return { amount, nonce, deadline, signature }
}

/** The user's own setup calls on the spoke: position managers and the collateral flag, only what is missing. */
export function setupCalls(tx: V4Tx): BatchCall[] {
  const pm = (manager: Address, label: string): BatchCall => ({
    to: tx.spoke,
    data: encodeFunctionData({ abi: v4SpokeAbi, functionName: 'setUserPositionManager', args: [manager, true] }),
    label,
  })
  return [
    ...(tx.setup.giver ? [pm(tx.net.giver, 'Activer le gestionnaire de dépôt d’Aave (Giver) sur ce spoke')] : []),
    ...(tx.setup.taker ? [pm(tx.net.taker, 'Activer le gestionnaire d’emprunt d’Aave (Taker) sur ce spoke')] : []),
    ...(tx.setup.collateral
      ? [
          {
            to: tx.spoke,
            data: encodeFunctionData({ abi: v4SpokeAbi, functionName: 'setUsingAsCollateral', args: [BigInt(tx.collateralId), true, tx.user] }),
            label: 'Marquer la réserve comme collatéral',
          },
        ]
      : []),
  ]
}

const LABELS = {
  open: 'Ouvrir : flash loan Morpho, swap, dépôt et emprunt sur Aave v4',
  close: 'Fermer : flash loan Morpho, remboursement, retrait et swap',
}

function takerAllowanceCalls(tx: V4Tx, kind: 'borrow' | 'withdraw', need: bigint, current: bigint): { before: BatchCall[]; after: BatchCall[] } {
  if (need === 0n || current >= need) return { before: [], after: [] }
  const reserveId = BigInt(kind === 'borrow' ? tx.debtId : tx.collateralId)
  const call = (amount: bigint, label: string): BatchCall => ({
    to: tx.net.taker,
    data: encodeFunctionData({
      abi: v4TakerAbi,
      functionName: kind === 'borrow' ? 'approveBorrow' : 'approveWithdraw',
      args: [tx.spoke, reserveId, tx.executor, amount],
    }),
    label,
  })
  return kind === 'borrow'
    ? {
        before: [call(need, 'Autoriser le contrat à emprunter pour ce compte (montant exact)')],
        after: [call(current, 'Remettre l’autorisation d’emprunt à sa valeur')],
      }
    : {
        before: [call(need, 'Autoriser le contrat à retirer le collatéral (le temps du lot)')],
        after: [call(current, 'Remettre l’autorisation de retrait à sa valeur')],
      }
}

/** The open batch: setup, exact capital approval, borrow allowance, the call, allowances back. Pure, tested. */
export function v4OpenBatch(p: V4OpenPlan): BatchCall[] {
  const cap = allowanceCalls('erc20', p.capitalToken, p.executor, p.capitalAmount, p.capitalAllowance, {
    set: 'Autoriser le contrat à prendre le capital (montant exact)',
    reset: 'Remettre l’autorisation du capital à sa valeur',
  })
  const borrow = takerAllowanceCalls(p, 'borrow', p.debtAmount, p.borrowAllowance)
  return [
    ...setupCalls(p),
    ...cap.before,
    ...borrow.before,
    { to: p.executor, data: encodeV4Action(v4OpenAction(p)), label: LABELS.open },
    ...borrow.after,
    ...cap.after,
  ]
}

/** What the executor must be allowed to withdraw for a close. */
export const withdrawNeed = (p: Pick<V4ClosePlan, 'collateralToWithdraw'>) => p.collateralToWithdraw

/** The close batch: managers when missing, withdraw allowance, the call, allowance back. Pure, tested. */
export function v4CloseBatch(p: V4ClosePlan): BatchCall[] {
  const withdraw = takerAllowanceCalls(p, 'withdraw', withdrawNeed(p), p.withdrawAllowance)
  return [
    ...setupCalls({ ...p, setup: { ...p.setup, collateral: false } }),
    ...withdraw.before,
    { to: p.executor, data: encodeV4Action(v4CloseAction(p)), label: LABELS.close },
    ...withdraw.after,
  ]
}

/** A transaction of the user's own, simulated, sent and waited for. */
async function userTx(tx: V4Tx, request: { address: Address; abi: unknown; functionName: string; args: unknown[] }, what: string, onStep: Progress) {
  onStep(`${what} (transaction)…`)
  const sim = await simulateContract(wagmiConfig, { ...request, chainId: tx.net.chain.id, account: tx.user } as never)
  const hash = await writeContract(wagmiConfig, sim.request as never)
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: tx.net.chain.id, hash })
  if (receipt.status !== 'success') throw new Error(`${what} : la transaction a échoué`)
}

/** The setup in one transaction of the user: a `multicall` of the spoke (the caller stays the user), or the single call. */
async function sendSetup(tx: V4Tx, onStep: Progress) {
  const calls = setupCalls(tx)
  if (calls.length === 0) return
  const what = 'Activation du spoke'
  if (calls.length === 1) {
    onStep(`${what} (transaction)…`)
    const hash = await sendTransaction(wagmiConfig, { chainId: tx.net.chain.id, account: tx.user, to: calls[0].to, data: calls[0].data })
    const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: tx.net.chain.id, hash })
    if (receipt.status !== 'success') throw new Error(`${what} : la transaction a échoué`)
    return
  }
  await userTx(tx, { address: tx.spoke, abi: v4SpokeAbi, functionName: 'multicall', args: [calls.map((c) => c.data)] }, what, onStep)
}

/** Simulates then sends the executor call, waits for it. */
async function sendAction(tx: V4Tx, a: Action, onStep: Progress, permit?: V4Permit): Promise<Hash> {
  const chainId = tx.net.chain.id
  onStep('Simulation…')
  const { request } = await simulateContract(wagmiConfig, {
    chainId,
    account: tx.user,
    address: tx.executor,
    abi: v4ExecutorAbi,
    functionName: (permit ? `${a.name}WithPermit` : a.name) as 'open',
    args: (permit ? [a.args, permit] : [a.args]) as never,
  })
  onStep('Confirmation de la transaction dans le portefeuille…')
  const hash = await writeContract(wagmiConfig, request as never)
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId, hash })
  if (receipt.status !== 'success') throw new Error('La transaction a échoué')
  return hash
}

async function batch(tx: V4Tx, calls: BatchCall[], onStep: Progress): Promise<Hash> {
  const hash = await sendBatch(tx.net.chain.id, tx.user, calls, onStep, tx.executor)
  if (!hash) throw new Error('Lot envoyé, transaction introuvable')
  return hash
}

/**
 * Opens. `batch`: one atomic confirmation. Otherwise: the setup (transaction) when missing, the capital approval
 * (transaction) when needed, the borrow permit (signature) unless an allowance covers it, then the call.
 */
export type V4SendOptions = { batch: boolean; nonce: bigint; /** false: the account has code, allowances go by transaction */ permit?: boolean }

/** The Taker allowance by a transaction of the user (accounts that cannot sign the permit). */
const approveTaker = (tx: V4Tx, kind: 'borrow' | 'withdraw', amount: bigint, what: string, onStep: Progress) =>
  userTx(
    tx,
    {
      address: tx.net.taker,
      abi: v4TakerAbi,
      functionName: kind === 'borrow' ? 'approveBorrow' : 'approveWithdraw',
      args: [tx.spoke, BigInt(kind === 'borrow' ? tx.debtId : tx.collateralId), tx.executor, amount],
    },
    what,
    onStep,
  )

export async function executeV4Open(p: V4OpenPlan, opts: V4SendOptions, onStep: Progress): Promise<Hash> {
  const a = v4OpenAction(p) // checks the plan before anything is signed
  if (opts.batch) return batch(p, v4OpenBatch(p), onStep)
  await sendSetup(p, onStep)
  if (p.capitalAmount > 0n && p.capitalAllowance < p.capitalAmount)
    await userTx(p, { address: p.capitalToken, abi: erc20Abi, functionName: 'approve', args: [p.executor, p.capitalAmount] }, 'Approbation du capital', onStep)
  let permit: V4Permit | undefined
  if (p.debtAmount > 0n && p.borrowAllowance < p.debtAmount) {
    if (opts.permit === false) await approveTaker(p, 'borrow', p.debtAmount, 'Autorisation d’emprunt', onStep)
    else {
      onStep('Signature : autoriser le contrat à emprunter ce montant pour cette transaction…')
      permit = await signPermit(p, 'BorrowPermit', p.debtId, p.debtAmount, opts.nonce)
    }
  }
  return sendAction(p, a, onStep, permit)
}

/**
 * Closes. `batch`: one atomic confirmation. Otherwise: the position managers (transaction) when the position was
 * opened elsewhere, the withdraw permit (signature) unless an allowance covers it, then the call.
 */
export async function executeV4Close(p: V4ClosePlan, opts: V4SendOptions, onStep: Progress): Promise<Hash> {
  const a = v4CloseAction(p)
  if (opts.batch) return batch(p, v4CloseBatch(p), onStep)
  await sendSetup({ ...p, setup: { ...p.setup, collateral: false } }, onStep)
  let permit: V4Permit | undefined
  const need = withdrawNeed(p)
  if (need > 0n && p.withdrawAllowance < need) {
    if (opts.permit === false) {
      await approveTaker(p, 'withdraw', need, 'Autorisation de retrait', onStep)
      // whatever the close does, the allowance does not stay in place
      try {
        return await sendAction(p, a, onStep)
      } finally {
        await approveTaker(p, 'withdraw', p.withdrawAllowance, 'Retrait de l’autorisation', onStep)
      }
    }
    onStep('Signature : autoriser le contrat à retirer le collatéral pour cette transaction…')
    permit = await signPermit(p, 'WithdrawPermit', p.collateralId, need, opts.nonce)
  }
  return sendAction(p, a, onStep, permit)
}

// ---------------------------------------------------------------------------------------------------------------------
// What the transaction really did (contract events)
// ---------------------------------------------------------------------------------------------------------------------

export type V4Outcome =
  | { kind: 'open'; supplied: bigint; borrowed: bigint; healthFactor: bigint }
  | { kind: 'close'; debtRepaid: bigint; collateralWithdrawn: bigint; collateralReturned: bigint; debtAssetReturned: bigint; healthFactor: bigint }

/** The executor's own event for `user` in these logs. */
export function decodeV4Outcome(logs: Pick<Log, 'address' | 'data' | 'topics'>[], executor: Address, user: Address): V4Outcome | undefined {
  for (const l of logs) {
    if (!same(l.address, executor)) continue
    try {
      const e = decodeEventLog({ abi: v4ExecutorAbi, data: l.data, topics: l.topics })
      if (!('user' in e.args) || !same(e.args.user as Address, user)) continue
      if (e.eventName === 'PositionOpened')
        return { kind: 'open', supplied: e.args.collateralSupplied, borrowed: e.args.debtBorrowed, healthFactor: e.args.healthFactor }
      if (e.eventName === 'PositionClosed') return { kind: 'close', ...e.args.result }
    } catch {
      // another event of the executor (Swapped)
    }
  }
  return undefined
}

export async function readV4Outcome(chainId: number, hash: Hash, executor: Address, user: Address): Promise<V4Outcome | undefined> {
  try {
    const receipt = await getPublicClient(wagmiConfig, { chainId })!.getTransactionReceipt({ hash })
    return decodeV4Outcome(receipt.logs, executor, user)
  } catch {
    return undefined
  }
}

const hf = (x: bigint) => (x >= maxUint256 / 2n ? '∞' : (Number(x / 10n ** 14n) / 10_000).toFixed(2).replace('.', ','))

export function v4OutcomeLines(o: V4Outcome, collateral: TokenInfo, debt: TokenInfo): string[] {
  const c = (x: bigint) => `${fmtAmount(x, collateral.decimals)} ${collateral.symbol}`
  const d = (x: bigint) => `${fmtAmount(x, debt.decimals)} ${debt.symbol}`
  if (o.kind === 'open') return [`Déposé : ${c(o.supplied)}`, `Emprunté : ${d(o.borrowed)}`, `Health factor : ${hf(o.healthFactor)}`]
  return [
    `Remboursé : ${d(o.debtRepaid)}`,
    `Collatéral retiré : ${c(o.collateralWithdrawn)}`,
    ...(o.collateralReturned > 0n ? [`Rendu : ${c(o.collateralReturned)}`] : []),
    ...(o.debtAssetReturned > 0n ? [`Rendu : ${d(o.debtAssetReturned)}`] : []),
    `Health factor : ${hf(o.healthFactor)}`,
  ]
}

export { maxUint256 as V4_ALL }
