/**
 * LeverageExecutorV4 calls: open and close a loop on an Aave v4 spoke, swap its collateral or its debt (refinance
 * lives in refinance.ts). The contract acts through Aave's Giver and
 * Taker position managers, which the user makes managers of their account once per spoke (with the collateral flag,
 * in one `multicall` of the spoke), then within an allowance of the Taker given for each operation:
 *   - a wallet that sends atomic batches: setup when missing, exact capital approval, approveBorrow / approveWithdraw,
 *     the call, allowances back, all or nothing;
 *   - otherwise the setup transaction when missing, the capital approval when needed, then one EIP-712 permit of the
 *     Taker (20 minutes) handed to the call, which renounces what is left of it.
 * An allowance already in place is served with an empty permit. An account with code (a smart account, an EIP-7702
 * delegation) cannot sign the Taker's permit as an EOA: without batches it approves by transaction instead
 * (`permit: false`), and takes a withdraw allowance back after the close.
 */
import { decodeEventLog, encodeFunctionData, maxUint256, type Address, type Hash, type Hex, type Log } from 'viem'
import { waitForTransactionReceipt } from '@wagmi/core'
import { walletSendTransaction, walletSignTypedData } from '../../chain/wallet'
import { wagmiConfig } from '../../chain/wagmi'
import { erc20Abi, v4ExecutorAbi, v4SpokeAbi, v4TakerAbi } from '../../chain/abi'
import type { V4Net } from '../../config'
import { quoteSteps, type Quote } from '../../services/quotes/quotes'
import { allowanceCalls, type BatchCall } from '../../chain/batch'
import { receiptLogs, sendBatchTx, sendExecutorCall, userTx as sendUserTx, type ContractCall } from '../../chain/send'
import { withInterestMargin } from '../morpho/execute'
import { deadlineFromNow, guardOf as guard, hfText as hf, liveQuote as live, sameAddress as same, type Step } from '../common'
import type { Progress } from '../../chain/tx'
import type { TokenInfo } from '../../chain/outcome'
import { fmtAmount } from '../../ui/format'

/** What the once-per-spoke setup still lacks for this user. */
export type V4Setup = { giver: boolean; taker: boolean; collateral: boolean }

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

/**
 * « Changer de collatéral »: the new collateral is flash-borrowed and supplied first, then the old one is withdrawn
 * and sold for it; the debt does not move. `collateralId` / `collateralToken` are the new collateral (the setup
 * flags it), `fromId` / `fromToken` the old one.
 */
export type V4SwapCollateralPlan = V4Tx & {
  fromId: number
  fromToken: Address
  /** all the old collateral (the contract withdraws what is supplied at inclusion) */
  full: boolean
  /** old collateral sold; for a full switch, what is supplied when quoted */
  fromAmount: bigint
  /** old → new collateral, selling `fromAmount` */
  quote?: Quote
  /** new collateral flash-borrowed and supplied first (at most the quote's minimum) */
  toAmount: bigint
  withdrawAllowance: bigint
}

/**
 * « Changer de dette »: the new debt is flash-borrowed, sold for the old debt asset, the old debt repaid, then the new
 * one borrowed. `debtId` / `debtToken` are the new debt (borrowed through the Taker), `fromId` / `fromToken` the old.
 */
export type V4SwapDebtPlan = V4Tx & {
  fromId: number
  fromToken: Address
  /** all the old debt (the contract reads it at inclusion and requires it all repaid) */
  full: boolean
  /** new debt borrowed and sold */
  newDebtAmount: bigint
  /** old debt repaid at least (ignored when `full`) */
  minRepaid: bigint
  /** new → old debt asset, selling `newDebtAmount` */
  quote?: Quote
  borrowAllowance: bigint
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

export function v4SwapCollateralArgs(p: V4SwapCollateralPlan) {
  if (same(p.fromToken, p.collateralToken)) throw new Error('Ancien et nouveau collatéral identiques')
  const q = live(p.quote, 'du swap')
  if (q.sellAmount !== p.fromAmount) throw new Error('Devis pour un autre montant que le collatéral retiré')
  if (p.toAmount === 0n || p.toAmount > q.minOut) throw new Error('Montant du flash loan incohérent avec le devis')
  return {
    spoke: p.spoke,
    fromId: BigInt(p.fromId),
    toId: BigInt(p.collateralId),
    fromAmount: p.full ? maxUint256 : p.fromAmount,
    toAmount: p.toAmount,
    steps: quoteSteps(q, p.collateralToken),
    guard: guard(p.minHealthFactor),
  }
}

export function v4SwapDebtArgs(p: V4SwapDebtPlan) {
  if (same(p.fromToken, p.debtToken)) throw new Error('Ancienne et nouvelle dette identiques')
  const q = live(p.quote, 'du swap')
  if (q.sellAmount !== p.newDebtAmount) throw new Error('Devis pour un autre montant que la nouvelle dette')
  if (!p.full && (p.minRepaid === 0n || p.minRepaid > q.minOut)) throw new Error('Remboursement minimum incohérent avec le devis')
  return {
    spoke: p.spoke,
    fromId: BigInt(p.fromId),
    toId: BigInt(p.debtId),
    newDebtAmount: p.newDebtAmount,
    minRepaid: p.full ? maxUint256 : p.minRepaid,
    steps: quoteSteps(q, p.fromToken),
    guard: guard(p.minHealthFactor),
  }
}

type Action =
  | { name: 'open'; args: ReturnType<typeof v4OpenArgs> }
  | { name: 'close'; args: ReturnType<typeof v4CloseArgs> }
  | { name: 'swapCollateral'; args: ReturnType<typeof v4SwapCollateralArgs> }
  | { name: 'swapDebt'; args: ReturnType<typeof v4SwapDebtArgs> }
export const v4OpenAction = (p: V4OpenPlan): Action => ({ name: 'open', args: v4OpenArgs(p) })
export const v4CloseAction = (p: V4ClosePlan): Action => ({ name: 'close', args: v4CloseArgs(p) })
export const v4SwapCollateralAction = (p: V4SwapCollateralPlan): Action => ({ name: 'swapCollateral', args: v4SwapCollateralArgs(p) })
export const v4SwapDebtAction = (p: V4SwapDebtPlan): Action => ({ name: 'swapDebt', args: v4SwapDebtArgs(p) })

export type V4Permit = { amount: bigint; nonce: bigint; deadline: bigint; signature: Hex }
/** No signed allowance: the contract uses the one in place. */
export const NO_PERMIT: V4Permit = { amount: 0n, nonce: 0n, deadline: 0n, signature: '0x' }

/** Calldata of the action, with the Taker permit or an empty one. */
export function encodeV4Action(a: Action, permit: V4Permit = NO_PERMIT): Hex {
  return encodeFunctionData({ abi: v4ExecutorAbi, functionName: a.name, args: [a.args, permit] as never })
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

export async function signPermit(
  tx: Pick<V4Tx, 'net' | 'spoke' | 'user' | 'executor'>,
  kind: 'BorrowPermit' | 'WithdrawPermit',
  reserveId: number,
  amount: bigint,
  nonce: bigint,
): Promise<V4Permit> {
  const deadline = deadlineFromNow()
  const data = takerPermitTypedData(kind, tx.net.chain.id, tx.net.taker, {
    spoke: tx.spoke,
    reserveId: BigInt(reserveId),
    owner: tx.user,
    spender: tx.executor,
    amount,
    nonce,
    deadline,
  })
  const signature = await walletSignTypedData({ chainId: tx.net.chain.id, account: tx.user, ...data } as never)
  return { amount, nonce, deadline, signature }
}

/** The user's own setup calls on the spoke: position managers and the collateral flag, only what is missing. */
export function setupCalls(tx: Pick<V4Tx, 'net' | 'spoke' | 'user' | 'collateralId' | 'setup'>): BatchCall[] {
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

const LABELS: Record<Action['name'], string> = {
  open: 'Ouvrir : flash loan Morpho, swap, dépôt et emprunt sur Aave v4',
  close: 'Fermer : flash loan Morpho, remboursement, retrait et swap',
  swapCollateral: 'Changer de collatéral : flash loan Morpho, dépôt du nouveau, retrait et swap de l’ancien',
  swapDebt: 'Changer de dette : flash loan Morpho, swap, remboursement de l’ancienne dette, emprunt de la nouvelle',
}

/** An allowance of the Taker an action spends: borrow or withdraw, on one reserve of the spoke. */
export type TakerNeed = { kind: 'borrow' | 'withdraw'; reserveId: number; amount: bigint; current: bigint }

/** Before / after the call: the Taker allowance at `need`, then back to its value. Pure, tested. */
export function takerAllowanceCalls(
  tx: Pick<V4Tx, 'net' | 'spoke' | 'executor'>,
  { kind, reserveId, amount: need, current }: TakerNeed,
): { before: BatchCall[]; after: BatchCall[] } {
  if (need === 0n || current >= need) return { before: [], after: [] }
  const call = (amount: bigint, label: string): BatchCall => ({
    to: tx.net.taker,
    data: encodeFunctionData({
      abi: v4TakerAbi,
      functionName: kind === 'borrow' ? 'approveBorrow' : 'approveWithdraw',
      args: [tx.spoke, BigInt(reserveId), tx.executor, amount],
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
  const borrow = takerAllowanceCalls(p, openNeed(p))
  return [
    ...setupCalls(p),
    ...cap.before,
    ...borrow.before,
    { to: p.executor, data: encodeV4Action(v4OpenAction(p)), label: LABELS.open },
    ...borrow.after,
    ...cap.after,
  ]
}

const openNeed = (p: V4OpenPlan): TakerNeed => ({ kind: 'borrow', reserveId: p.debtId, amount: p.debtAmount, current: p.borrowAllowance })

/** What the executor must be allowed to withdraw for a close. */
export const withdrawNeed = (p: Pick<V4ClosePlan, 'collateralToWithdraw'>) => p.collateralToWithdraw
const closeNeed = (p: V4ClosePlan): TakerNeed => ({ kind: 'withdraw', reserveId: p.collateralId, amount: withdrawNeed(p), current: p.withdrawAllowance })

/** Old collateral the executor must be allowed to withdraw: a full switch takes what is there at inclusion (+0.1 %). */
export const swapWithdrawNeed = (p: Pick<V4SwapCollateralPlan, 'full' | 'fromAmount'>) => (p.full ? withInterestMargin(p.fromAmount) : p.fromAmount)
const swapCollateralNeed = (p: V4SwapCollateralPlan): TakerNeed => ({
  kind: 'withdraw',
  reserveId: p.fromId,
  amount: swapWithdrawNeed(p),
  current: p.withdrawAllowance,
})
const swapDebtNeed = (p: V4SwapDebtPlan): TakerNeed => ({ kind: 'borrow', reserveId: p.debtId, amount: p.newDebtAmount, current: p.borrowAllowance })

/** Managers and flag when missing, the Taker allowance, the call, the allowance back. */
function actionBatch(tx: V4Tx, a: Action, need: TakerNeed, flag: boolean): BatchCall[] {
  const allowance = takerAllowanceCalls(tx, need)
  return [
    ...setupCalls({ ...tx, setup: { ...tx.setup, collateral: flag && tx.setup.collateral } }),
    ...allowance.before,
    { to: tx.executor, data: encodeV4Action(a), label: LABELS[a.name] },
    ...allowance.after,
  ]
}

/** The close batch: managers when missing, withdraw allowance, the call, allowance back. Pure, tested. */
export const v4CloseBatch = (p: V4ClosePlan): BatchCall[] => actionBatch(p, v4CloseAction(p), closeNeed(p), false)

/** The collateral switch batch: managers and the new collateral's flag when missing, withdraw allowance, the call. Pure, tested. */
export const v4SwapCollateralBatch = (p: V4SwapCollateralPlan): BatchCall[] => actionBatch(p, v4SwapCollateralAction(p), swapCollateralNeed(p), true)

/** The debt switch batch: managers when missing, borrow allowance of the new debt, the call. Pure, tested. */
export const v4SwapDebtBatch = (p: V4SwapDebtPlan): BatchCall[] => actionBatch(p, v4SwapDebtAction(p), swapDebtNeed(p), false)

const sender = (tx: Pick<V4Tx, 'net' | 'user'>) => ({ chainId: tx.net.chain.id, user: tx.user })
const userTx = (tx: Pick<V4Tx, 'net' | 'user'>, call: ContractCall, what: string, onStep: Progress) => sendUserTx(sender(tx), call, what, onStep)

/** The setup in one transaction of the user: a `multicall` of the spoke (the caller stays the user), or the single call. */
export async function sendSetup(tx: Pick<V4Tx, 'net' | 'spoke' | 'user' | 'collateralId' | 'setup'>, onStep: Progress) {
  const calls = setupCalls(tx)
  if (calls.length === 0) return
  const what = 'Activation du spoke'
  if (calls.length === 1) {
    onStep(`${what} (transaction)…`)
    const hash = await walletSendTransaction({ chainId: tx.net.chain.id, account: tx.user, to: calls[0].to, data: calls[0].data })
    const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: tx.net.chain.id, hash })
    if (receipt.status !== 'success') throw new Error(`${what} : la transaction a échoué`)
    return
  }
  await userTx(tx, { address: tx.spoke, abi: v4SpokeAbi, functionName: 'multicall', args: [calls.map((c) => c.data)] }, what, onStep)
}

/** Simulates then sends the executor call, waits for it. */
const sendAction = (tx: V4Tx, a: Action, onStep: Progress, permit: V4Permit = NO_PERMIT): Promise<Hash> =>
  sendExecutorCall(sender(tx), { address: tx.executor, abi: v4ExecutorAbi, functionName: a.name, args: [a.args, permit] as never }, onStep)

const batch = (tx: V4Tx, calls: BatchCall[], onStep: Progress): Promise<Hash> => sendBatchTx(sender(tx), calls, onStep, tx.executor)

/**
 * Opens. `batch`: one atomic confirmation. Otherwise: the setup (transaction) when missing, the capital approval
 * (transaction) when needed, the borrow permit (signature) unless an allowance covers it, then the call.
 */
export type V4SendOptions = { batch: boolean; nonce: bigint; /** false: the account has code, allowances go by transaction */ permit?: boolean }

/** The Taker allowance by a transaction of the user (accounts that cannot sign the permit). */
export const approveTaker = (
  tx: Pick<V4Tx, 'net' | 'spoke' | 'user' | 'executor'>,
  need: Pick<TakerNeed, 'kind' | 'reserveId'>,
  amount: bigint,
  what: string,
  onStep: Progress,
) =>
  userTx(
    tx,
    {
      address: tx.net.taker,
      abi: v4TakerAbi,
      functionName: need.kind === 'borrow' ? 'approveBorrow' : 'approveWithdraw',
      args: [tx.spoke, BigInt(need.reserveId), tx.executor, amount],
    },
    what,
    onStep,
  )

const PERMIT_TEXT = {
  borrow: ['Autorisation d’emprunt', 'Signature : autoriser le contrat à emprunter ce montant pour cette transaction…'],
  withdraw: ['Autorisation de retrait', 'Signature : autoriser le contrat à retirer le collatéral pour cette transaction…'],
} as const

/**
 * Without batches: the allowance `need` of the Taker, then the call. A permit (signature) unless an allowance covers
 * it; an account that cannot sign approves by transaction, and a withdraw allowance is taken back after the call.
 */
async function sendWithTaker(tx: V4Tx, a: Action, need: TakerNeed, opts: V4SendOptions, onStep: Progress): Promise<Hash> {
  if (need.amount === 0n || need.current >= need.amount) return sendAction(tx, a, onStep)
  const [what, sign] = PERMIT_TEXT[need.kind]
  if (opts.permit === false) {
    await approveTaker(tx, need, need.amount, what, onStep)
    if (need.kind === 'borrow') return sendAction(tx, a, onStep)
    // whatever the call does, the withdraw allowance does not stay in place
    try {
      return await sendAction(tx, a, onStep)
    } finally {
      await approveTaker(tx, need, need.current, 'Retrait de l’autorisation', onStep)
    }
  }
  onStep(sign)
  const permit = await signPermit(tx, need.kind === 'borrow' ? 'BorrowPermit' : 'WithdrawPermit', need.reserveId, need.amount, opts.nonce)
  return sendAction(tx, a, onStep, permit)
}

export async function executeV4Open(p: V4OpenPlan, opts: V4SendOptions, onStep: Progress): Promise<Hash> {
  const a = v4OpenAction(p) // checks the plan before anything is signed
  if (opts.batch) return batch(p, v4OpenBatch(p), onStep)
  await sendSetup(p, onStep)
  if (p.capitalAmount > 0n && p.capitalAllowance < p.capitalAmount)
    await userTx(p, { address: p.capitalToken, abi: erc20Abi, functionName: 'approve', args: [p.executor, p.capitalAmount] }, 'Approbation du capital', onStep)
  return sendWithTaker(p, a, openNeed(p), opts, onStep)
}

/**
 * Closes. `batch`: one atomic confirmation. Otherwise: the position managers (transaction) when the position was
 * opened elsewhere, the withdraw permit (signature) unless an allowance covers it, then the call.
 */
export async function executeV4Close(p: V4ClosePlan, opts: V4SendOptions, onStep: Progress): Promise<Hash> {
  const a = v4CloseAction(p)
  if (opts.batch) return batch(p, v4CloseBatch(p), onStep)
  await sendSetup({ ...p, setup: { ...p.setup, collateral: false } }, onStep)
  return sendWithTaker(p, a, closeNeed(p), opts, onStep)
}

/**
 * Switches the collateral. `batch`: one atomic confirmation. Otherwise: the setup (transaction) when the new
 * collateral is not flagged yet, the withdraw permit of the old one (signature), then the call.
 */
export async function executeV4SwapCollateral(p: V4SwapCollateralPlan, opts: V4SendOptions, onStep: Progress): Promise<Hash> {
  const a = v4SwapCollateralAction(p)
  if (opts.batch) return batch(p, v4SwapCollateralBatch(p), onStep)
  await sendSetup(p, onStep)
  return sendWithTaker(p, a, swapCollateralNeed(p), opts, onStep)
}

/** Switches the debt. `batch`: one atomic confirmation. Otherwise: the borrow permit of the new debt (signature), then the call. */
export async function executeV4SwapDebt(p: V4SwapDebtPlan, opts: V4SendOptions, onStep: Progress): Promise<Hash> {
  const a = v4SwapDebtAction(p)
  if (opts.batch) return batch(p, v4SwapDebtBatch(p), onStep)
  await sendSetup({ ...p, setup: { ...p.setup, collateral: false } }, onStep)
  return sendWithTaker(p, a, swapDebtNeed(p), opts, onStep)
}

// ---------------------------------------------------------------------------------------------------------------------
// What the transaction really did (contract events)
// ---------------------------------------------------------------------------------------------------------------------

export type V4Outcome =
  | { kind: 'open'; supplied: bigint; borrowed: bigint; healthFactor: bigint }
  | { kind: 'close'; debtRepaid: bigint; collateralWithdrawn: bigint; collateralReturned: bigint; debtAssetReturned: bigint; healthFactor: bigint }
  | { kind: 'swapCollateral'; withdrawn: bigint; supplied: bigint; healthFactor: bigint }
  | { kind: 'swapDebt'; repaid: bigint; borrowed: bigint; returned: bigint; healthFactor: bigint }
  | { kind: 'refinance'; debtMoved: bigint; collateralMoved: bigint; healthFactor: bigint }

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
      if (e.eventName === 'CollateralSwapped') return { kind: 'swapCollateral', ...e.args.result }
      if (e.eventName === 'DebtSwapped') return { kind: 'swapDebt', ...e.args.result }
      if (e.eventName === 'Refinanced') return { kind: 'refinance', ...e.args.result }
    } catch {
      // another event of the executor (Swapped)
    }
  }
  return undefined
}

export async function readV4Outcome(chainId: number, hash: Hash, executor: Address, user: Address): Promise<V4Outcome | undefined> {
  const logs = await receiptLogs(chainId, hash)
  return logs && decodeV4Outcome(logs, executor, user)
}

/**
 * The outcome in words. `collateral` / `debt`: the pair; for a switch, `from` is the old collateral (or old debt) and
 * the pair's side the new one.
 */
export function v4OutcomeLines(o: V4Outcome, collateral: TokenInfo, debt: TokenInfo, from?: TokenInfo): string[] {
  const t = (x: bigint, k: TokenInfo) => `${fmtAmount(x, k.decimals)} ${k.symbol}`
  const c = (x: bigint) => t(x, collateral)
  const d = (x: bigint) => t(x, debt)
  if (o.kind === 'swapCollateral')
    return [`Retiré : ${from ? t(o.withdrawn, from) : String(o.withdrawn)}`, `Déposé : ${c(o.supplied)}`, `Health factor : ${hf(o.healthFactor)}`]
  if (o.kind === 'swapDebt')
    return [
      `Remboursé : ${from ? t(o.repaid, from) : String(o.repaid)}`,
      `Emprunté : ${d(o.borrowed)}`,
      ...(o.returned > 0n ? [`Rendu : ${from ? t(o.returned, from) : String(o.returned)}`] : []),
      `Health factor : ${hf(o.healthFactor)}`,
    ]
  if (o.kind === 'refinance')
    return [`Dette déplacée : ${d(o.debtMoved)}`, `Collatéral déplacé : ${c(o.collateralMoved)}`, `Health factor : ${hf(o.healthFactor)}`]
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
