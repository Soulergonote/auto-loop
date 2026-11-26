import { describe, expect, it } from 'vitest'
import { DAY_MS } from './apyHistory'
import { backtest, priceRatio } from './backtest'

const NOW = Date.UTC(2026, 10, 26, 12)
const today = Math.floor(NOW / DAY_MS)
/** one point a day over the last `n` days, value from the day's index (0 = oldest) */
const series = (n: number, f: (i: number) => number) => Array.from({ length: n + 1 }, (_, i) => ({ t: (today - n + i) * DAY_MS + 3_600_000, v: f(i) }))

describe('backtest (A1)', () => {
  it('a flat pair earns the levered spread', () => {
    const r = backtest({
      borrow: series(90, () => 0.03),
      supply: series(90, () => 0.05),
      ratio: series(90, () => 1),
      leverage: 5,
      liquidationThreshold: 0.95,
      capitalUsd: 10_000,
      now: NOW,
    })!
    expect(r.days).toBe(90)
    expect(r.liquidatedAt).toBeUndefined()
    // each leg compounds at its own rate: about 5 × 5 % − 4 × 3 % = 13 % a year
    const equity = 5 * 1.05 ** (90 / 365) - 4 * 1.03 ** (90 / 365)
    expect(r.gainUsd).toBeCloseTo(10_000 * (equity - 1), 6)
    expect(r.apy).toBeCloseTo(equity ** (365 / 90) - 1, 10)
    expect(r.apy).toBeCloseTo(0.13, 2)
    expect(r.minHf.v).toBeCloseTo((5 * 0.95) / 4, 2)
  })

  it('counts a token yield through the price ratio, with no lending rate (Morpho)', () => {
    const r = backtest({
      borrow: series(90, () => 0.02),
      ratio: series(90, (i) => 1.04 ** (i / 365)),
      leverage: 4,
      liquidationThreshold: 0.915,
      capitalUsd: 1_000,
      now: NOW,
    })!
    expect(r.apy).toBeCloseTo(4 * 0.04 - 3 * 0.02, 2)
    // the ratio grows faster than the debt: the health factor rises
    expect(r.finalHf).toBeGreaterThan(r.hf[0].v)
    expect(r.minHf.t).toBe(r.start)
  })

  it('stops on the day a depeg liquidates the loop', () => {
    const r = backtest({
      borrow: series(90, () => 0.03),
      ratio: series(90, (i) => (i >= 40 ? 0.9 : 1)),
      leverage: 8,
      liquidationThreshold: 0.93,
      capitalUsd: 10_000,
      now: NOW,
    })!
    expect(r.liquidatedAt).toBe((today - 50) * DAY_MS)
    expect(r.days).toBe(40)
    expect(r.finalHf).toBeLessThan(1)
    expect(r.gainUsd).toBeLessThan(-5_000)
  })

  it('carries a day the API skipped, starts when every series has data', () => {
    const borrow = series(90, () => 0.03).filter((_, i) => i % 7 !== 3)
    const r = backtest({ borrow, ratio: series(30, () => 1), leverage: 3, liquidationThreshold: 0.9, capitalUsd: 100, now: NOW })!
    expect(r.days).toBe(30)
    // capital 1, collateral 3 flat, debt 2 at 3 %
    expect(r.gainUsd).toBeCloseTo(100 * -2 * (1.03 ** (30 / 365) - 1), 6)
  })

  it('needs a week of data and a real loop', () => {
    const base = { borrow: series(90, () => 0.03), ratio: series(3, () => 1), liquidationThreshold: 0.9, capitalUsd: 100, now: NOW }
    expect(backtest({ ...base, leverage: 3 })).toBeUndefined()
    expect(backtest({ ...base, ratio: series(90, () => 1), leverage: 1 })).toBeUndefined()
    expect(backtest({ ...base, ratio: [], leverage: 3 })).toBeUndefined()
  })

  it('builds the ratio from two price series and drops an isolated outlier', () => {
    const t = (h: number) => 1_790_000_000 + h * 6 * 3600
    const a = [1, 1, 1, 0.8, 1, 1, 1].map((price, h) => ({ timestamp: t(h), price }))
    const b = a.map((p) => ({ timestamp: p.timestamp + 60, price: 1 }))
    const r = priceRatio(a, b)
    expect(r).toHaveLength(7)
    expect(r.every((p) => p.v === 1)).toBe(true)
    expect(r[0].t).toBe(t(0) * 1000)
  })
})
