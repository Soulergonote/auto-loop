import { describe, expect, it } from 'vitest'
import { depegTone, maxDrawdown, ratioSeries, riskSignals } from './riskSignals'

const pts = (prices: number[], step = 14_400, t0 = 1_000_000) => prices.map((price, i) => ({ timestamp: t0 + i * step, price }))

describe('ratioSeries', () => {
  it('divides point by point, matching the closest timestamp', () => {
    const a = pts([2, 4, 6])
    const b = pts([1, 2, 3], 14_400, 1_000_000 + 300)
    expect(ratioSeries(a, b)).toEqual([2, 2, 2])
  })
  it('skips points without a close match or with a zero price', () => {
    expect(ratioSeries(pts([1, 1]), pts([1], 14_400, 1_000_000 + 40_000))).toEqual([])
    expect(ratioSeries(pts([1, 0, 1]), pts([1, 1, 1]))).toEqual([1, 1])
  })
})

describe('maxDrawdown', () => {
  it('is the largest fall from a running peak', () => {
    expect(maxDrawdown([1, 1.02, 0.97, 1.01, 0.99])).toBeCloseTo(1 - 0.97 / 1.02)
    expect(maxDrawdown([1, 1.1, 1.2])).toBe(0)
    expect(maxDrawdown([])).toBe(0)
  })
  it('tones by pair type: 1 % already counts for a correlated pair', () => {
    expect(depegTone(0.005, true)).toBe('good')
    expect(depegTone(0.012, true)).toBe('warn')
    expect(depegTone(0.06, true)).toBe('bad')
    expect(depegTone(0.12, false)).toBe('good')
  })
})

describe('riskSignals', () => {
  const base = { collateral: 'USDe', debt: 'USDC', correlated: true }
  it('reads each signal on its own and leaves out what is unknown', () => {
    expect(riskSignals(base)).toEqual([])
    const s = riskSignals({ ...base, oracleRatio: 1, marketRatio: 0.99, drawdown: 0.004, exitLoss: 0.001, topBorrower: { share: 0.7, mine: false } })
    expect(s.map((x) => [x.key, x.tone])).toEqual([
      ['gap', 'warn'],
      ['depeg', 'good'],
      ['exit', 'good'],
      ['concentration', 'bad'],
    ])
    expect(s[0].value).toBe('−1,00 %')
  })
  it('a market above the oracle costs nothing; an uncorrelated pair gets a wider band', () => {
    expect(riskSignals({ ...base, oracleRatio: 1, marketRatio: 1.01 })[0].tone).toBe('good')
    expect(riskSignals({ ...base, correlated: false, oracleRatio: 1, marketRatio: 0.993 })[0].tone).toBe('good')
  })
  it('no exit route is red; the largest borrower being the user is not a risk', () => {
    expect(riskSignals({ ...base, exitNoRoute: true })[0]).toMatchObject({ value: 'aucune route', tone: 'bad' })
    expect(riskSignals({ ...base, topBorrower: { share: 0.9, mine: true } })[0].tone).toBe('good')
  })
})
