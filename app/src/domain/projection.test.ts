import { describe, expect, it } from 'vitest'
import { legGrowth, projectHealthFactor } from './projection'
import { hfAfterDays } from './economics'

describe('legGrowth', () => {
  it('compounds the yearly rate', () => {
    expect(legGrowth({ value: 1, apy: 0.1 }, 365)).toBeCloseTo(1.1, 10)
    expect(legGrowth({ value: 1, apy: 0.1 }, 0)).toBe(1)
  })
  it('a PT on a linear feed climbs to par at maturity, then stays', () => {
    // 10 %/year discount, 73 days left: 0.98 today, par at maturity
    const pt = { value: 1, apy: 0, pt: { daysLeft: 73, discount: 0.1 } }
    expect(legGrowth(pt, 73)).toBeCloseTo(1 / 0.98, 10)
    expect(legGrowth(pt, 200)).toBeCloseTo(1 / 0.98, 10)
    expect(legGrowth(pt, 36.5)).toBeCloseTo(0.99 / 0.98, 10)
  })
  it('a PT without a known feed earns its fixed yield until maturity only', () => {
    const pt = { value: 1, apy: 0.1, pt: { daysLeft: 30 } }
    expect(legGrowth(pt, 90)).toBeCloseTo(legGrowth({ value: 1, apy: 0.1 }, 30), 10)
    expect(legGrowth({ value: 1, apy: 0.1, pt: { daysLeft: -5 } }, 90)).toBe(1)
  })
})

describe('projectHealthFactor', () => {
  it('one collateral, one debt: the same as hfAfterDays', () => {
    expect(projectHealthFactor(1.2, [{ value: 300, apy: 0.03 }], [{ value: 200, apy: 0.08 }], 90)).toBeCloseTo(hfAfterDays(1.2, 0.03, 0.08, 90), 10)
  })
  it('weights the legs by value; a negative carry pulls the health factor down', () => {
    const hf = projectHealthFactor(
      1.1,
      [
        { value: 900, apy: 0.02 },
        { value: 100, apy: 0.1 },
      ],
      [{ value: 800, apy: 0.06 }],
      365,
    )
    expect(hf).toBeCloseTo((1.1 * (0.9 * 1.02 + 0.1 * 1.1)) / 1.06, 10)
    expect(hf).toBeLessThan(1.1)
  })
  it('no debt stays infinite', () => {
    expect(projectHealthFactor(Infinity, [{ value: 1, apy: 0 }], [], 30)).toBe(Infinity)
  })
})
