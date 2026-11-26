import { describe, expect, it } from 'vitest'
import { DAY_MS, apyRegime, lastDays, loopApyHistory, seriesStats, sparkSeries, stabilityStats } from './apyHistory'

const d = (n: number, v: number) => ({ t: n * DAY_MS + 3_600_000, v })

describe('loopApyHistory', () => {
  it('applies the leverage to each day and adds the extra yield', () => {
    const pts = loopApyHistory([d(2, 0.05), d(1, 0.04)], [d(1, 0.03), d(2, 0.02)], 3, 0.01)
    expect(pts.map((p) => p.t)).toEqual([1 * DAY_MS, 2 * DAY_MS])
    expect(pts[0].v).toBeCloseTo(0.03 * 3 - 0.04 * 2 + 0.01)
    expect(pts[1].v).toBeCloseTo(0.02 * 3 - 0.05 * 2 + 0.01)
  })
  it('keeps the latest point of a day', () => {
    const pts = loopApyHistory([d(1, 0.04), { t: 1 * DAY_MS + 50_000_000, v: 0.06 }], undefined, 2)
    expect(pts).toHaveLength(1)
    expect(pts[0].v).toBeCloseTo(-0.06)
  })
  it('skips a day missing on the supply leg', () => {
    expect(loopApyHistory([d(1, 0.04), d(2, 0.05)], [d(2, 0.02)], 2)).toHaveLength(1)
  })
  it('without a supply leg (Morpho) the collateral earns no lending rate, only the extra (already at loop scale)', () => {
    expect(loopApyHistory([d(1, 0.04)], undefined, 4, 0.1)[0].v).toBeCloseTo(0.1 - 0.12)
  })
})

describe('lastDays and seriesStats', () => {
  const now = 100 * DAY_MS + 5
  const pts = Array.from({ length: 100 }, (_, i) => d(i + 1, i === 99 ? 0.3 : 0.1))
  it('keeps the window, today included', () => {
    const w = lastDays(pts, 30, now)
    expect(w).toHaveLength(30)
    expect(w[w.length - 1].v).toBe(0.3)
  })
  it('average, min, max, last', () => {
    const s = seriesStats(lastDays(pts, 30, now))!
    expect(s.average).toBeCloseTo((29 * 0.1 + 0.3) / 30)
    expect(s.max.v).toBe(0.3)
    expect(s.min.v).toBe(0.1)
    expect(s.last.v).toBe(0.3)
    expect(seriesStats([])).toBeUndefined()
  })
  it('tells a spike from a regime', () => {
    expect(apyRegime(seriesStats(lastDays(pts, 30, now))!)).toBe('spike')
    expect(apyRegime(seriesStats(pts.slice(0, 50))!)).toBe('steady')
    expect(apyRegime(seriesStats([d(1, 0.2), d(2, 0.2), d(3, 0.05)])!)).toBe('dip')
  })
})

describe('sparkSeries', () => {
  const now = 40 * DAY_MS + 3600_000
  const at = (d: number, v: number) => ({ t: d * DAY_MS, v })
  it('keeps the last 30 days and ends on today’s APY', () => {
    const borrow = Array.from({ length: 40 }, (_, d) => at(d + 1, 0.04))
    const supply = Array.from({ length: 40 }, (_, d) => at(d + 1, d === 39 ? 0.06 : 0.05))
    const s = sparkSeries(borrow, supply, 3, 0.2, 30, now)
    expect(s).toHaveLength(30)
    expect(s[s.length - 1].v).toBeCloseTo(0.2)
    // 0.05 × 3 − 0.04 × 2 = 0.07 before the last day (0.10), shifted by 0.10
    expect(s[0].v).toBeCloseTo(0.17)
  })
  it('is empty without enough history', () => {
    expect(sparkSeries([at(40, 0.04)], undefined, 3, 0.1, 30, now)).toEqual([])
    expect(sparkSeries([at(39, 0.04), at(40, 0.04)], undefined, Infinity, 0.1, 30, now)).toEqual([])
  })
})

describe('stabilityStats (A6)', () => {
  const pts = (vs: number[]) => vs.map((v, i) => ({ t: i * DAY_MS, v }))
  it('gives the average and the population deviation', () => {
    const st = stabilityStats(pts([0.1, 0.1, 0.1, 0.1, 0.12, 0.08, 0.1]))!
    expect(st.average).toBeCloseTo(0.1, 10)
    expect(st.deviation).toBeCloseTo(Math.sqrt((0.02 ** 2 * 2) / 7), 10)
    expect(st.days).toBe(7)
  })
  it('is zero for a flat series and undefined when too short', () => {
    expect(stabilityStats(pts(Array(10).fill(0.05)))!.deviation).toBeCloseTo(0, 12)
    expect(stabilityStats(pts([0.1, 0.2, 0.3]))).toBeUndefined()
  })
})
