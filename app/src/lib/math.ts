/**
 * Leverage maths. Prices are Aave oracle prices (base currency, 8 decimals on Aave v3 = USD).
 * Token amounts are bigints in token units; ratios are plain numbers for display.
 */

export type Side = { price: bigint; decimals: number }

const BPS = 10_000n

/** Value of `amount` in oracle base units. */
export function toBase(amount: bigint, side: Side): bigint {
  return (amount * side.price) / 10n ** BigInt(side.decimals)
}

/** Amount of token worth `value` base units. */
export function fromBase(value: bigint, side: Side): bigint {
  return (value * 10n ** BigInt(side.decimals)) / side.price
}

/** Debt to flash-borrow so that equity `initial` (in collateral) ends up levered `leverageBps / 10000` times. */
export function debtForLeverage(initial: bigint, leverageBps: bigint, collat: Side, debt: Side): bigint {
  if (leverageBps <= BPS) return 0n
  const value = (toBase(initial, collat) * (leverageBps - BPS)) / BPS
  return fromBase(value, debt)
}

/** A position on the pair, in oracle base units. */
export type PairPosition = { collateralBase: bigint; debtBase: bigint }

export const NO_POSITION: PairPosition = { collateralBase: 0n, debtBase: 0n }

/** collateral / equity of a position, Infinity when the debt eats all of it, 1 without debt. */
export function positionLeverage(p: PairPosition): number {
  const equity = p.collateralBase - p.debtBase
  if (p.collateralBase === 0n) return 1
  return equity > 0n ? Number(p.collateralBase) / Number(equity) : Infinity
}

/**
 * Extra debt to flash-borrow so that the whole position on the pair (existing one + `addedBase` of new capital)
 * reaches `leverageBps / 10000`, before swap costs. 0 when the position is already at or above the target.
 */
export function extraDebtForTarget(position: PairPosition, addedBase: bigint, leverageBps: bigint, debt: Side): bigint {
  const equity = position.collateralBase - position.debtBase + addedBase
  if (equity <= 0n || leverageBps <= BPS) return 0n
  const targetDebt = (equity * (leverageBps - BPS)) / BPS
  return targetDebt > position.debtBase ? fromBase(targetDebt - position.debtBase, debt) : 0n
}

/**
 * Debt to repay (selling the same value of collateral) so that the position on the pair drops to
 * `leverageBps / 10000`, before swap costs: the equity stays, collateral and debt shrink together, so
 * repaid = debt - (target - 1) x equity. The whole debt at 1x or below, 0 when already at or below the target.
 */
export function repayForTarget(position: PairPosition, leverageBps: bigint, debt: Side): bigint {
  const equity = position.collateralBase - position.debtBase
  if (equity <= 0n || leverageBps <= BPS) return fromBase(position.debtBase, debt)
  const targetDebt = (equity * (leverageBps - BPS)) / BPS
  return targetDebt < position.debtBase ? fromBase(position.debtBase - targetDebt, debt) : 0n
}

/** Theoretical maximum leverage allowed by the borrow LTV: 1 / (1 - LTV). */
export function maxLeverage(ltvBps: number): number {
  return ltvBps >= 10_000 ? Infinity : 1 / (1 - ltvBps / 10_000)
}

/** Expected collateral out of a swap at oracle prices, minus `costBps` (fees + price impact estimate). */
export function oracleSwapOut(amountIn: bigint, from: Side, to: Side, costBps = 0n): bigint {
  return (fromBase(toBase(amountIn, from), to) * (BPS - costBps)) / BPS
}

export function applySlippage(amount: bigint, slippageBps: bigint): bigint {
  return (amount * (BPS - slippageBps)) / BPS
}

export type Account = {
  /** existing totals from getUserAccountData (base units) */
  collateralBase: bigint
  debtBase: bigint
  /** weighted liquidation threshold of existing collateral, bps */
  liquidationThresholdBps: bigint
}

export const EMPTY_ACCOUNT: Account = { collateralBase: 0n, debtBase: 0n, liquidationThresholdBps: 0n }

export type Projection = {
  collateralBase: bigint
  debtBase: bigint
  healthFactor: number
  /** debt / collateral, to compare with the asset LTV (Aave checks it when the debt is minted) */
  ltv: number
  /** price drop of the collateral (debt price fixed) that triggers liquidation, as a fraction */
  dropToLiquidation: number
  /** effective leverage on the equity added in this transaction */
  leverage: number
}

/**
 * Account state after adding `addCollat` collateral (liq. threshold `ltBps`) and `addDebt` debt,
 * merged with the user's existing Aave account.
 */
export function project(account: Account, addCollat: bigint, collat: Side, ltBps: number, addDebt: bigint, debt: Side): Projection {
  const addedCollatBase = toBase(addCollat, collat)
  const addedDebtBase = toBase(addDebt, debt)
  const collateralBase = account.collateralBase + addedCollatBase
  const debtBase = account.debtBase + addedDebtBase
  const weightedLt = account.collateralBase * account.liquidationThresholdBps + addedCollatBase * BigInt(ltBps)

  const healthFactor = debtBase === 0n ? Infinity : Number(weightedLt) / Number(BPS) / Number(debtBase)
  const ltv = collateralBase === 0n ? 0 : Number(debtBase) / Number(collateralBase)
  const equity = addedCollatBase - addedDebtBase
  return {
    collateralBase,
    debtBase,
    healthFactor,
    ltv,
    dropToLiquidation: Number.isFinite(healthFactor) ? Math.max(0, 1 - 1 / healthFactor) : 1,
    leverage: equity > 0n ? Number(addedCollatBase) / Number(equity) : Infinity,
  }
}

/** Net yield on equity: supply APY on the whole collateral minus borrow APY on the debt. */
export function netApy(leverage: number, supplyApy: number, borrowApy: number): number {
  return supplyApy * leverage - borrowApy * (leverage - 1)
}

/**
 * Collateral to sell (exact input) to repay `debtAmount` plus the flash loan premium,
 * with a margin for slippage and interest accrued before execution.
 */
export function collateralToSellForRepay(debtAmount: bigint, premiumBps: bigint, slippageBps: bigint, collat: Side, debt: Side, extraMarginBps = 30n): bigint {
  const owed = (debtAmount * (BPS + premiumBps)) / BPS
  const withMargin = (owed * BPS) / (BPS - slippageBps - extraMarginBps)
  return fromBase(toBase(withMargin, debt), collat) + 1n
}

/** Amount owed to the flash loan for a repayment of `debtAmount` (premium rounded up like Aave). */
export function flashLoanOwed(debtAmount: bigint, premiumBps: bigint): bigint {
  return debtAmount + (debtAmount * premiumBps + BPS / 2n) / BPS
}

/** `x` rounded down to `digits` significant digits (keeps quotes stable while a balance accrues interest). */
export function roundSignificant(x: bigint, digits: number): bigint {
  const len = x.toString().length
  if (len <= digits) return x
  const unit = 10n ** BigInt(len - digits)
  return (x / unit) * unit
}
