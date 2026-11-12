/**
 * What a loop really earns once its one-off costs are paid: entry swap, exit (flash loan premium + swap back) and
 * gas, spread over how long the position is held. Values are in oracle base units (USD, 8 decimals) or fractions.
 */
import { toBase, type Side } from './math'
import { fmtPct } from '../ui/format'

const BPS = 10_000n

/** Gas used by the executor, measured on a Base fork (2026-10-18 e2e: ~733k to open, ~1.7M to close; 2026-11-08: ~1.14M to change the collateral), rounded up. */
export const GAS_UNITS = { open: 800_000n, close: 1_700_000n, swapCollateral: 1_200_000n }
/** A loop on a Pendle PT, measured on an Ethereum fork (2026-11-08: ~1.25M to open through an aggregator and Pendle, ~1.05M to close), rounded up. */
export const GAS_UNITS_PT = { open: 1_300_000n, close: 1_100_000n, swapCollateral: 1_400_000n }

export const HORIZONS = [30, 90, 180, 365] as const
export type Horizon = (typeof HORIZONS)[number]

/** Value lost in a swap at oracle prices (price impact + route fees), never negative. */
export function swapCostBase(sellAmount: bigint, sell: Side, buyAmount: bigint, buy: Side): bigint {
  const lost = toBase(sellAmount, sell) - toBase(buyAmount, buy)
  return lost > 0n ? lost : 0n
}

/** Share of value lost in a swap at oracle prices (price impact + fees), as a fraction; 0 when it gains. */
export function swapLoss(sellAmount: bigint, sell: Side, buyAmount: bigint, buy: Side): number {
  const sold = Number(toBase(sellAmount, sell))
  return sold > 0 ? Math.max(0, 1 - Number(toBase(buyAmount, buy)) / sold) : 0
}

/** Above this loss the swap is refused: the pool is too thin for the size (seen on Monad, USDe / AUSD, 2026-11-02). */
export const MAX_SWAP_LOSS = 0.03
/** Above this, a warning. */
export const WARN_SWAP_LOSS = 0.005

/** Message for a swap that loses too much value, or undefined; `block` above `maxLoss`. */
export function swapLossProblem(
  loss: number,
  sell: string,
  buy: string,
  simulated?: boolean,
  maxLoss = MAX_SWAP_LOSS,
): { block: boolean; text: string } | undefined {
  if (simulated || loss <= WARN_SWAP_LOSS) return undefined
  const pct = fmtPct(loss, 1)
  return loss > maxLoss
    ? {
        block: true,
        text: `Le swap ${sell} → ${buy} perd ${pct} de la valeur au prix de l’oracle : pas assez de liquidité pour ce montant. Réduire le montant ou le levier.`,
      }
    : { block: false, text: `Le swap ${sell} → ${buy} perd ${pct} de la valeur au prix de l’oracle (impact de prix).` }
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
  /** gas of the open and the close, when not the plain loop's (GAS_UNITS) */
  gasUnits?: bigint
  /** the exit needs no swap (a PT redeemed at maturity straight into the debt asset) */
  freeExit?: boolean
}): Costs {
  const exitPremium = (p.debtBase * p.premiumBps) / BPS
  const exitSwap = p.freeExit ? 0n : p.entrySoldBase > 0n ? (p.debtBase * p.entrySwapBase) / p.entrySoldBase : 0n
  const units = p.gasUnits ?? GAS_UNITS.open + GAS_UNITS.close
  const gas = p.gasPriceWei !== undefined && p.nativePriceBase !== undefined ? (units * p.gasPriceWei * p.nativePriceBase) / 10n ** 18n : undefined
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

/** Health factor if the collateral loses `drop` (fraction) against the debt asset. */
export function hfAfterDrop(healthFactor: number, drop: number): number {
  return healthFactor * (1 - drop)
}

/** Borrow APY at which the loop's yield falls to zero: L x supply + rewards = (L - 1) x borrow. */
export function breakEvenBorrowApy(leverage: number, supplyApy: number, rewardsApy = 0): number {
  return leverage <= 1 ? Infinity : (leverage * supplyApy + rewardsApy) / (leverage - 1)
}

/**
 * Health factor after `days` at today's rates, rewards left unclaimed: the debt grows at the borrow APY, the
 * collateral at the supply APY, prices unchanged.
 */
export function hfAfterDays(healthFactor: number, supplyApy: number, borrowApy: number, days: number): number {
  return healthFactor * Math.pow((1 + supplyApy) / (1 + borrowApy), days / 365)
}

/** Days until interest alone brings the health factor to 1 (Infinity if the collateral grows faster than the debt). */
export function daysToLiquidationByInterest(healthFactor: number, supplyApy: number, borrowApy: number): number {
  if (!(healthFactor > 1)) return 0
  if (borrowApy <= supplyApy) return Infinity
  return (365 * Math.log(healthFactor)) / Math.log((1 + borrowApy) / (1 + supplyApy))
}
