import { describe, expect, it } from 'vitest'
import { aaveBorrowApr, aaveModelMatches, aaveRatesAfter, aaveSupplyApr, aprToApy, morphoBorrowApyAfter, morphoCurve } from './irm'

// Aave Base USDC, read on 2026-11-12: optimal 90 %, base 0, slopes 4.75 % and 10 %, reserve factor 10 %;
// at 90.9 % utilization the pool showed a 5.6493 % borrow APR and a 4.6217 % supply APR
const usdc = { optimal: 0.9, base: 0, slope1: 0.0475, slope2: 0.1, reserveFactor: 0.1 }

describe('Aave rate strategy', () => {
  it('gives back the on-chain rates', () => {
    const u = 0.9089934249563791
    expect(aaveBorrowApr(usdc, u)).toBeCloseTo(0.056493, 5)
    expect(aaveSupplyApr(usdc, u)).toBeCloseTo(0.046217, 5)
    expect(aaveModelMatches(usdc, 9.1, 90.9, aprToApy(0.056493))).toBe(true)
    expect(aaveModelMatches(usdc, 9.1, 90.9, 0.09)).toBe(false)
  })

  it('raises the borrow rate past the kink', () => {
    // 100 M supplied, 80 M borrowed; borrowing 15 M more takes it to 95 %
    const before = aaveRatesAfter(usdc, 20, 80, 0, 0)!
    const after = aaveRatesAfter(usdc, 20, 80, 0, 15)!
    expect(before.borrowApy).toBeCloseTo(aprToApy((0.0475 * 0.8) / 0.9), 6)
    expect(after.borrowApy).toBeCloseTo(aprToApy(0.0475 + 0.1 * 0.5), 6)
    expect(aaveRatesAfter(usdc, 20, 80, 0, 25)).toBeUndefined()
  })

  it('lowers the supply rate of a collateral supplied in size', () => {
    const before = aaveRatesAfter(usdc, 20, 80, 0, 0)!
    const after = aaveRatesAfter(usdc, 20, 80, 100, 0)!
    expect(after.supplyApy).toBeLessThan(before.supplyApy)
  })
})

describe('Morpho AdaptiveCurveIRM', () => {
  it('is 1 at target, 4 at full use and 1/4 empty', () => {
    expect(morphoCurve(0.9)).toBeCloseTo(1)
    expect(morphoCurve(1)).toBeCloseTo(4)
    expect(morphoCurve(0)).toBeCloseTo(0.25)
  })

  it('scales today’s rate along the curve', () => {
    // 6 % at 90 %: borrowing up to 95 % gives 2.5x the rate at target
    expect(morphoBorrowApyAfter(0.06, 100, 90, 5)).toBeCloseTo(aprToApy(Math.log1p(0.06) * 2.5), 6)
    expect(morphoBorrowApyAfter(0.06, 100, 90, 0)).toBeCloseTo(0.06, 9)
    expect(morphoBorrowApyAfter(0.06, 100, 90, 11)).toBeUndefined()
  })
})
