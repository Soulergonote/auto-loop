/**
 * Replay of a loop over the past (A1): opened `days` days ago at today's leverage, then left alone. Each day the debt
 * grows at that day's borrow rate, the collateral at its lending rate (Aave; none on Morpho), and the collateral is
 * valued at that day's market price in debt units. That price already carries a yield-bearing token's own yield
 * (wstETH, sUSDe, a PT), so it is not added a second time. Merkl, the entry and exit costs are left out.
 *
 * Health factor = collateral value × liquidation threshold / debt, at the market price: an oracle pinned to an
 * exchange rate can read higher. Under 1 the loop is liquidated that day and the replay stops there.
 */
import { DAY_MS, type RatePoint } from './apyHistory'
import { despike, ratioPoints, type PricePoint } from './riskSignals'

export const BACKTEST_DAYS = 90

export type BacktestInput = {
  /** daily borrow rate of the debt (APY, fraction) */
  borrow: RatePoint[]
  /** daily lending rate of the collateral; undefined when it earns none (Morpho) */
  supply?: RatePoint[]
  /** collateral price in debt units, timestamps in ms */
  ratio: RatePoint[]
  leverage: number
  /** fraction (0.95) */
  liquidationThreshold: number
  /** capital put in, in dollars (the result is measured in the debt token, scaled to it) */
  capitalUsd: number
  days?: number
  now?: number
}

export type BacktestResult = {
  /** health factor at the end of each day replayed */
  hf: RatePoint[]
  start: number
  end: number
  /** days replayed (fewer when liquidated) */
  days: number
  finalEquityUsd: number
  gainUsd: number
  /** the gain annualised (compounded), over the days replayed */
  apy: number
  minHf: RatePoint
  finalHf: number
  /** day of liquidation, when the health factor fell under 1 */
  liquidatedAt?: number
}

const dayOf = (t: number) => Math.floor(t / DAY_MS)

/** The last value of each UTC day, by day number. */
function daily(points: RatePoint[]): Map<number, number> {
  const latest = new Map<number, RatePoint>()
  for (const p of points) {
    if (!Number.isFinite(p.v)) continue
    const d = dayOf(p.t)
    const cur = latest.get(d)
    if (!cur || p.t >= cur.t) latest.set(d, p)
  }
  return new Map([...latest].map(([d, p]) => [d, p.v]))
}

/** Value of day `d`, else the closest earlier day's (a day the API skipped), else the first one after. */
function carried(byDay: Map<number, number>, days: number[]): (d: number) => number | undefined {
  const sorted = [...byDay.keys()].sort((a, b) => a - b)
  return (d) => {
    let best: number | undefined
    for (const k of sorted) {
      if (k > d) break
      best = k
    }
    const k = best ?? sorted.find((x) => x > d && x <= days[days.length - 1])
    return k === undefined ? undefined : byDay.get(k)
  }
}

/**
 * Collateral price in debt units from two DefiLlama price series (dollars, timestamps in seconds), timestamps in ms; a
 * price aggregator's isolated outliers removed (rolling median of 5 points, as the depeg signal on 6-hour prices).
 */
export function priceRatio(collateral: PricePoint[], debt: PricePoint[]): RatePoint[] {
  const points = ratioPoints(collateral, debt)
  const clean = despike(
    points.map((p) => p.v),
    2,
  )
  return points.map((p, i) => ({ t: p.t * 1000, v: clean[i] }))
}

/** Undefined when a rate or price is missing over the whole window, or the leverage cannot be looped. */
export function backtest(input: BacktestInput): BacktestResult | undefined {
  const { leverage: L, liquidationThreshold: lt, capitalUsd } = input
  const window = input.days ?? BACKTEST_DAYS
  const today = dayOf(input.now ?? Date.now())
  if (!(L > 1) || !(lt > 0) || !(capitalUsd > 0)) return undefined
  const ratioByDay = daily(input.ratio)
  const borrowByDay = daily(input.borrow)
  const supplyByDay = input.supply && daily(input.supply)
  // the replay starts on the first day every series covers, at most `window` days ago
  const firsts = [ratioByDay, borrowByDay, ...(supplyByDay ? [supplyByDay] : [])].map((m) => Math.min(...m.keys()))
  if (firsts.some((f) => !Number.isFinite(f))) return undefined
  const first = Math.max(today - window, ...firsts)
  if (today - first < 7) return undefined
  const days = Array.from({ length: today - first + 1 }, (_, i) => first + i)
  const ratio = carried(ratioByDay, days)
  const borrow = carried(borrowByDay, days)
  const supply = supplyByDay ? carried(supplyByDay, days) : () => 0
  const r0 = ratio(first)!
  // in debt units, capital = 1: collateral L, debt L − 1
  let collateral = L / r0
  let debt = L - 1
  const hf: RatePoint[] = [{ t: first * DAY_MS, v: (L * lt) / (L - 1) }]
  let liquidatedAt: number | undefined
  let equity = 1
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1]
    // a day's interest at the rate of the day before (APY compounded daily)
    collateral *= (1 + (supply(prev) ?? 0)) ** (1 / 365)
    debt *= (1 + (borrow(prev) ?? 0)) ** (1 / 365)
    const value = collateral * (ratio(days[i]) ?? r0)
    const h = (value * lt) / debt
    hf.push({ t: days[i] * DAY_MS, v: h })
    equity = value - debt
    if (h < 1) {
      liquidatedAt = days[i] * DAY_MS
      break
    }
  }
  const span = hf.length - 1
  const minHf = hf.reduce((m, p) => (p.v < m.v ? p : m), hf[0])
  const growth = Math.max(0, equity)
  return {
    hf,
    start: first * DAY_MS,
    end: hf[hf.length - 1].t,
    days: span,
    finalEquityUsd: growth * capitalUsd,
    gainUsd: (equity - 1) * capitalUsd,
    apy: span > 0 && growth > 0 ? growth ** (365 / span) - 1 : -1,
    minHf,
    finalHf: hf[hf.length - 1].v,
    liquidatedAt,
  }
}
