/**
 * What a loop really earns once its one-off costs are paid: entry swap, exit (flash loan premium + swap back) and
 * gas, spread over how long the position is held. Values are in oracle base units (USD, 8 decimals) or fractions.
 */
import { toBase, type Side } from './math'

const BPS = 10_000n

/** Gas used by the executor, measured on a Base fork (2026-10-18 e2e: ~733k to open, ~1.7M to close), rounded up. */
export const GAS_UNITS = { open: 800_000n, close: 1_700_000n }

export const HORIZONS = [30, 90, 180, 365] as const
export type Horizon = (typeof HORIZONS)[number]

/** Value lost in a swap at oracle prices (price impact + route fees), never negative. */
export function swapCostBase(sellAmount: bigint, sell: Side, buyAmount: bigint, buy: Side): bigint {
  const lost = toBase(sellAmount, sell) - toBase(buyAmount, buy)
  return lost > 0n ? lost : 0n
}

export type Costs = {
  entrySwap: bigint
  /** flash loan premium paid on the debt at close */
  exitPremium: bigint
  /** swap back at close, assumed to cost the same share of value as the entry swap */
  exitSwap: bigint
  /** open + close, undefined when the gas or native token price is unknown */
  gas?: bigint
  total: bigint
}

export function loopCosts(p: {
  /** value sold in the entry swap and what it lost */
  entrySoldBase: bigint
  entrySwapBase: bigint
  /** debt to repay at close */
  debtBase: bigint
  premiumBps: bigint
  gasPriceWei?: bigint
  /** price of the chain's native token, base units */
  nativePriceBase?: bigint
}): Costs {
  const exitPremium = (p.debtBase * p.premiumBps) / BPS
  const exitSwap = p.entrySoldBase > 0n ? (p.debtBase * p.entrySwapBase) / p.entrySoldBase : 0n
  const gas =
    p.gasPriceWei !== undefined && p.nativePriceBase !== undefined
      ? ((GAS_UNITS.open + GAS_UNITS.close) * p.gasPriceWei * p.nativePriceBase) / 10n ** 18n
      : undefined
  return { entrySwap: p.entrySwapBase, exitPremium, exitSwap, gas, total: p.entrySwapBase + exitPremium + exitSwap + (gas ?? 0n) }
}

/**
 * Annualised return on equity over `days`, all costs paid: rates are prorated linearly, rewards only count until
 * `rewardDaysLeft` (campaign end), costs are taken once.
 */
export function horizonApy(p: { equityBase: bigint; ratesApy: number; rewardsApy: number; rewardDaysLeft?: number; costsBase: bigint; days: number }): number {
  if (p.equityBase <= 0n || p.days <= 0) return NaN
  const rewardDays = Math.min(p.days, Math.max(0, p.rewardDaysLeft ?? p.days))
  const gain = (p.ratesApy * p.days + p.rewardsApy * rewardDays) / 365
  return (gain - Number(p.costsBase) / Number(p.equityBase)) * (365 / p.days)
}

/**
 * Days of holding needed for the yield to pay back the costs (Infinity if it never does). `rewards` lists reward
 * yields with the days they still run: the cumulative gain is piecewise linear, flattening as campaigns end.
 */
export function breakEvenDays(equityBase: bigint, ratesApy: number, costsBase: bigint, rewards: { apy: number; days: number }[] = []): number {
  if (costsBase <= 0n) return 0
  if (equityBase <= 0n) return Infinity
  const target = Number(costsBase) / Number(equityBase)
  const ends = [...new Set(rewards.map((r) => r.days).filter((d) => Number.isFinite(d) && d > 0))].sort((a, b) => a - b)
  let t = 0
  let gained = 0
  for (const end of [...ends, Infinity]) {
    const slope = (ratesApy + rewards.filter((r) => r.days > t).reduce((s, r) => s + r.apy, 0)) / 365
    if (slope > 0) {
      const reach = t + (target - gained) / slope
      if (reach <= end) return reach
    }
    if (!Number.isFinite(end)) return Infinity
    gained += slope * (end - t)
    t = end
  }
  return Infinity
}
