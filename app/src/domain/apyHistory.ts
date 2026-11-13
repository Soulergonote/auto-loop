/**
 * Daily history of a loop's net APY (I3): today's leverage applied to each past day's rates, to tell a two-day spike
 * from a regime. Rates are fractions (0.05 = 5 %), one point per UTC day.
 */
export type RatePoint = { /** start of the UTC day, ms */ t: number; v: number }

export const HISTORY_WINDOWS = [30, 90] as const
export type HistoryWindow = (typeof HISTORY_WINDOWS)[number]

export const DAY_MS = 86_400_000
const day = (t: number) => Math.floor(t / DAY_MS)

/** One rate per day: the latest point of each day (an API may add today's live point beside its daily one). */
function byDay(points: RatePoint[]): Map<number, number> {
  const latest = new Map<number, RatePoint>()
  for (const p of points) {
    const k = day(p.t)
    const cur = latest.get(k)
    if (!cur || p.t > cur.t) latest.set(k, p)
  }
  return new Map([...latest].map(([k, p]) => [k, p.v]))
}

/**
 * Net APY of the loop on each day both legs have a rate: collateral rate × L − borrow rate × (L − 1) + `extra` (token
 * yield and Merkl of the whole loop, already levered, at today's level: their history is not read). `supply` undefined: the collateral earns no lending
 * rate (Morpho). Sorted from the oldest day; a day missing on one leg is skipped.
 */
export function loopApyHistory(borrow: RatePoint[], supply: RatePoint[] | undefined, leverage: number, extra = 0): RatePoint[] {
  const supplyByDay = supply && byDay(supply)
  const out: RatePoint[] = []
  for (const [d, b] of byDay(borrow)) {
    const s = supplyByDay ? supplyByDay.get(d) : 0
    if (s === undefined || !Number.isFinite(b) || !Number.isFinite(s)) continue
    out.push({ t: d * DAY_MS, v: s * leverage - b * (leverage - 1) + extra })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** The points of the last `days` days (today included). */
export const lastDays = (points: RatePoint[], days: number, now = Date.now()) => points.filter((p) => day(p.t) > day(now) - days)

export type SeriesStats = { average: number; min: RatePoint; max: RatePoint; last: RatePoint; days: number }

/** Average, extremes and last point of a series; undefined when empty. */
export function seriesStats(points: RatePoint[]): SeriesStats | undefined {
  if (!points.length) return undefined
  let min = points[0]
  let max = points[0]
  let sum = 0
  for (const p of points) {
    sum += p.v
    if (p.v < min.v) min = p
    if (p.v > max.v) max = p
  }
  return { average: sum / points.length, min, max, last: points[points.length - 1], days: points.length }
}

/**
 * A spike rather than a regime: today's APY is more than 1.5 times its average and at least 5 points above it (or
 * the other way down). Same spirit as the rate spike banner, on the loop's APY.
 */
export function apyRegime(stats: SeriesStats): 'spike' | 'dip' | 'steady' {
  const gap = stats.last.v - stats.average
  if (gap >= 0.05 && stats.last.v > stats.average * 1.5) return 'spike'
  if (gap <= -0.05 && stats.last.v < stats.average / 1.5) return 'dip'
  return 'steady'
}
