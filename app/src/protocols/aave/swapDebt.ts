/**
 * "Changer de dette" (contract v2, `swapDebt`): the new debt asset is flash-borrowed in debt mode (it becomes the
 * user's variable debt, no premium), swapped to the old one, which repays the old debt. The collateral does not move.
 * Pure helpers here; the execution lives in execute.ts (step by step) and batch.ts (one batch).
 */
import { maxUint256, type Address } from 'viem'
import { getQuote, quoteSteps, type Quote, type QuoteRequest } from '../../services/quotes/quotes'
import type { Account } from '../../domain/math'
import type { EModeCategory, Reserve } from './useMarket'

const BPS = 10_000n

export type SwapDebtPlan = {
  chainId: number
  executor: Address
  user: Address
  /** debt asset repaid */
  from: Address
  /** debt asset borrowed instead */
  to: Address
  /** variable debt token of `to`: the credit delegation is given on it */
  toDebtToken: Address
  /** the whole old debt (the contract then repays the debt at inclusion) */
  full: boolean
  /** new debt borrowed and sold */
  newDebtAmount: bigint
  /** new -> old debt asset, selling `newDebtAmount` */
  quote: Quote
  /** the call reverts if less old debt is repaid (ignored for a full switch: the whole debt must go) */
  minRepaid: bigint
  /** the call reverts if the account's health factor ends below this (1e18 = 1.00) */
  minHealthFactor: bigint
  /** current credit delegation of `to` to the executor */
  borrowAllowance: bigint
}

const callDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

export function swapDebtArgs(p: Pick<SwapDebtPlan, 'from' | 'to' | 'full' | 'newDebtAmount' | 'quote' | 'minRepaid' | 'minHealthFactor'>) {
  if (p.quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
  if (p.quote.sellAmount !== p.newDebtAmount) throw new Error('Devis pour un autre montant que la nouvelle dette')
  if (!p.full && (p.minRepaid === 0n || p.minRepaid > p.quote.minOut)) throw new Error('Remboursement minimum incohérent avec le devis')
  return {
    fromAsset: p.from,
    toAsset: p.to,
    newDebtAmount: p.newDebtAmount,
    minRepaid: p.full ? maxUint256 : p.minRepaid,
    steps: quoteSteps(p.quote, p.from),
    guard: { minHealthFactor: p.minHealthFactor, deadline: callDeadline() },
  } as const
}

/** Old debt the swap must be able to repay for a full switch: today's debt plus the interest of the next minutes. */
export const DEBT_MARGIN_BPS = 5n
export const fullDebtTarget = (debt: bigint) => debt + (debt * DEBT_MARGIN_BPS + BPS - 1n) / BPS

/**
 * New debt to sell so that the swap's guaranteed minimum covers `target`, from a first quote that sold `sold` for a
 * minimum of `minOut` (the rate is taken as linear over such a small change), rounded up with one more basis point.
 */
export function resizeNewDebt(sold: bigint, minOut: bigint, target: bigint): bigint {
  if (minOut === 0n) return 0n
  return (sold * target * (BPS + 1n)) / (minOut * BPS) + 1n
}

const hasBit = (bitmap: bigint, id: number) => ((bitmap >> BigInt(id)) & 1n) === 1n

/**
 * Debt assets the position can move to: borrowable (active, not frozen or paused, borrowing on), neither the current
 * debt nor the collateral, and, for an account in eMode, borrowable in its category.
 */
export function debtTargets(reserves: Reserve[], from: Address, collateral: Address, emode?: EModeCategory): Reserve[] {
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()
  return reserves.filter(
    (r) =>
      !same(r.token.address, from) &&
      !same(r.token.address, collateral) &&
      r.config.active &&
      !r.config.frozen &&
      !r.config.paused &&
      r.config.borrowingEnabled &&
      (!emode || hasBit(emode.borrowableBitmap, r.id)),
  )
}

/** Account after `repaidBase` of debt is replaced by `addedBase` of another debt, the collateral unchanged. */
export function projectDebtSwap(account: Account, repaidBase: bigint, addedBase: bigint) {
  const debtBase = account.debtBase - repaidBase + addedBase
  const weighted = account.collateralBase * account.liquidationThresholdBps
  const healthFactor = debtBase <= 0n ? Infinity : Number(weighted) / Number(BPS) / Number(debtBase)
  return {
    debtBase,
    healthFactor,
    /** drop of the collateral, against the debts, that triggers liquidation */
    dropToLiquidation: Number.isFinite(healthFactor) ? Math.max(0, 1 - 1 / healthFactor) : 1,
  }
}

/** Room left to borrow `amount` of a reserve: its cash, and its borrow cap (whole tokens, 0 = none) against its debt. */
export function borrowRoom(cash: bigint, totalDebt: bigint, borrowCapTokens: bigint, decimals: number): bigint {
  if (borrowCapTokens === 0n) return cash
  const cap = borrowCapTokens * 10n ** BigInt(decimals)
  const left = cap > totalDebt ? cap - totalDebt : 0n
  return left < cash ? left : cash
}

/** Yearly cost of a debt asset: Aave borrow rate plus the token's own yield, minus the headline Merkl borrow reward. */
export const borrowCost = (r: Reserve) => r.borrowApy + (r.native?.apy ?? 0) - r.borrowRewardApr

/**
 * Quote of the new debt to sell: first `firstAmount` (an oracle estimate); for a full switch (`target` set) the
 * amount is then rescaled so that the guaranteed minimum covers the target, and quoted again when it moved by more
 * than 0.05 %.
 */
export async function quoteDebtSwap(req: Omit<QuoteRequest, 'sellAmount'>, firstAmount: bigint, target?: bigint, signal?: AbortSignal): Promise<Quote> {
  const first = await getQuote({ ...req, sellAmount: firstAmount }, signal)
  if (target === undefined || first.simulated) return first
  const n = resizeNewDebt(firstAmount, first.minOut, target)
  const moved = n > firstAmount ? n - firstAmount : firstAmount - n
  if (moved * 2000n <= firstAmount && first.minOut >= target) return first
  return getQuote({ ...req, sellAmount: n }, signal)
}
