import { describe, expect, it } from 'vitest'
import { DAY_MS, apyRegime, lastDays, loopApyHistory, seriesStats } from './apyHistory'

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
