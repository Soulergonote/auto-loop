import { describe, expect, it } from 'vitest'
import { estimatedRoundTripUsd, gainPerYearUsd, parseAmountUsd, paybackDays } from './sizing'

describe('scanner amount', () => {
  it('reads what people type', () => {
    expect(parseAmountUsd('25 000')).toBe(25_000)
    expect(parseAmountUsd('25k')).toBe(25_000)
    expect(parseAmountUsd('1,5 M')).toBe(1_500_000)
    expect(parseAmountUsd('10000 $')).toBe(10_000)
    expect(parseAmountUsd('')).toBeUndefined()
    expect(parseAmountUsd('abc')).toBeUndefined()
    expect(parseAmountUsd('0')).toBeUndefined()
  })

  it('estimates costs and payback', () => {
    // 10 000 $ at 5x between stablecoins: 2 swaps of 40 000 $ at 0,05 % = 40 $
    expect(estimatedRoundTripUsd('stable', 5, 10_000)).toBeCloseTo(40)
    expect(gainPerYearUsd(0.1, 10_000)).toBeCloseTo(1000)
    // 1 000 $ a year pays 40 $ in 14,6 days
    expect(paybackDays(40, 0.1, 10_000)).toBeCloseTo(14.6, 1)
    expect(paybackDays(40, -0.01, 10_000)).toBeUndefined()
  })
})
