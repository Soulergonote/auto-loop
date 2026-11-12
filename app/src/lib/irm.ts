/**
 * Rates after the user's own loop: borrowing raises the utilization of the debt asset (its borrow rate goes up),
 * supplying the collateral lowers that of the collateral (its supply rate goes down). Aave v3.2+ rate strategy
 * (piecewise linear, read from DefaultReserveInterestRateStrategyV2) and Morpho's AdaptiveCurveIRM (curve around 90 %
 * utilization; its rate at target drifts with time, which is left out: the figure is the rate right after the trade).
 */

/** Aave rate strategy of a reserve, fractions (getInterestRateDataBps / 1e4) and the reserve factor */
export type AaveIrm = { optimal: number; base: number; slope1: number; slope2: number; reserveFactor: number }

/** APR → APY, compounded every second like Aave and Morpho (≈ e^apr − 1) */
export const aprToApy = (apr: number) => Math.expm1(apr)
export const apyToApr = (apy: number) => Math.log1p(apy)

/** borrowed share once `debt` is out of `cash + debt` (both in the same unit); 0 without supply */
export const utilizationOf = (cash: number, debt: number) => (cash + debt > 0 ? Math.min(1, Math.max(0, debt / (cash + debt))) : 0)

export function aaveBorrowApr(m: AaveIrm, u: number): number {
  if (u <= m.optimal) return m.base + (m.optimal > 0 ? (m.slope1 * u) / m.optimal : 0)
  return m.base + m.slope1 + (m.slope2 * (u - m.optimal)) / (1 - m.optimal)
}

export const aaveSupplyApr = (m: AaveIrm, u: number) => aaveBorrowApr(m, u) * u * (1 - m.reserveFactor)

/** the model gives back today's on-chain rate (within 2 % of it, or 0.05 point): else it is not used */
export function aaveModelMatches(m: AaveIrm, cash: number, debt: number, borrowApyNow: number): boolean {
  const model = aprToApy(aaveBorrowApr(m, utilizationOf(cash, debt)))
  return Math.abs(model - borrowApyNow) <= Math.max(0.0005, 0.02 * borrowApyNow)
}

/**
 * Supply and borrow APY of an Aave reserve after `addCash` more is supplied and `addDebt` more is borrowed (same unit
 * as cash and debt). Borrowing more than the cash is impossible: undefined.
 */
export function aaveRatesAfter(m: AaveIrm, cash: number, debt: number, addCash: number, addDebt: number): { supplyApy: number; borrowApy: number } | undefined {
  const cash2 = cash + addCash - addDebt
  if (cash2 < 0) return undefined
  const u = utilizationOf(cash2, debt + addDebt)
  return { supplyApy: aprToApy(aaveSupplyApr(m, u)), borrowApy: aprToApy(aaveBorrowApr(m, u)) }
}

/* ---------- Morpho AdaptiveCurveIRM ---------- */

const TARGET_U = 0.9
const STEEPNESS = 4

/** the curve's factor on the rate at target, at utilization u */
export function morphoCurve(u: number): number {
  const err = u > TARGET_U ? (u - TARGET_U) / (1 - TARGET_U) : (u - TARGET_U) / TARGET_U
  return err < 0 ? (1 - 1 / STEEPNESS) * err + 1 : (STEEPNESS - 1) * err + 1
}

/**
 * Borrow APY of a Morpho market after `addDebt` more is borrowed, from today's APY and utilization: the rate at target
 * is today's rate over today's curve factor. `supplied` and `borrowed` in the same unit.
 */
export function morphoBorrowApyAfter(borrowApyNow: number, supplied: number, borrowed: number, addDebt: number): number | undefined {
  if (supplied <= 0 || borrowed + addDebt > supplied) return undefined
  const atTarget = apyToApr(borrowApyNow) / morphoCurve(borrowed / supplied)
  return aprToApy(atTarget * morphoCurve((borrowed + addDebt) / supplied))
}
