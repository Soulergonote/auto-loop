/**
 * « Ramener à HF cible » : the leverage that brings a position back to a chosen health factor, and whether it is far
 * enough from it to be worth a transaction. Works on the position's own figures (USD base units), whatever the
 * protocol: the effective liquidation threshold is read back from the health factor itself (HF = LT x C / D).
 */
import { hfThresholds } from '../ui/tone'

/** health factor targets offered on a position card */
export const HF_TARGETS = { correlated: [1.05, 1.08, 1.1, 1.15, 1.2, 1.3], uncorrelated: [1.25, 1.3, 1.4, 1.5, 1.75, 2] } as const

export const hfTargetsFor = (correlated: boolean): readonly number[] => HF_TARGETS[correlated ? 'correlated' : 'uncorrelated']

/**
 * Without a chosen target, a position is still brought back once it is in the amber or red zone: to the first
 * target above the green threshold.
 */
export const safetyTarget = (correlated: boolean) => hfTargetsFor(correlated).find((t) => t > hfThresholds(correlated).ok)!

/** how far from the target before a rebalance is offered: below it (risk) the band is tighter than above it (yield) */
const BAND = { correlated: { below: 0.01, above: 0.03 }, uncorrelated: { below: 0.03, above: 0.1 } } as const

export type Rebalance = {
  /** down: repay debt (health factor below the target); up: borrow more (above it) */
  direction: 'down' | 'up'
  target: number
  /** leverage (collateral / equity) at the target */
  leverage: number
  /** debt to repay (down) or to add (up), USD base units */
  debtChangeBase: bigint
}

/** Leverage at health factor `hf` with liquidation threshold `lt` (fraction): L = HF / (HF - LT). */
export const leverageAtHf = (hf: number, lt: number) => (hf > lt ? hf / (hf - lt) : Infinity)

/**
 * The move back to `target` for a position worth `collateralBase` with `debtBase` of debt at `healthFactor`, or
 * undefined when it is inside the band around the target (or has no debt).
 */
export function rebalanceTo(p: { collateralBase: bigint; debtBase: bigint; healthFactor: number; correlated: boolean }, target: number): Rebalance | undefined {
  const { collateralBase: C, debtBase: D, healthFactor: hf } = p
  if (D <= 0n || C <= D || !Number.isFinite(hf) || !(target > 1)) return undefined
  const band = BAND[p.correlated ? 'correlated' : 'uncorrelated']
  const direction = hf < target - band.below ? 'down' : hf > target + band.above ? 'up' : undefined
  if (!direction) return undefined
  const lt = (hf * Number(D)) / Number(C)
  const leverage = leverageAtHf(target, lt)
  if (!Number.isFinite(leverage)) return undefined
  const equity = Number(C - D)
  const newDebt = equity * (leverage - 1)
  const change = BigInt(Math.round(Math.abs(newDebt - Number(D))))
  return { direction, target, leverage, debtChangeBase: change }
}

/** The rebalance to show: toward the chosen target, else back to the safety target once below the green zone. */
export function rebalanceFor(
  p: { collateralBase: bigint; debtBase: bigint; healthFactor: number; correlated: boolean },
  chosen: number | undefined,
): Rebalance | undefined {
  if (chosen !== undefined) return rebalanceTo(p, chosen)
  if (p.healthFactor >= hfThresholds(p.correlated).ok) return undefined
  const r = rebalanceTo(p, safetyTarget(p.correlated))
  return r?.direction === 'down' ? r : undefined
}
