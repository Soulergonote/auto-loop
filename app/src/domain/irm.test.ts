import { describe, expect, it } from 'vitest'
import {
  adjustedRate,
  aaveBorrowApr,
  aaveModelMatches,
  aaveRatesAfter,
  aaveSupplyApr,
  aprToApy,
  kinkOf,
  morphoBorrowApyAfter,
  morphoCurve,
  rateOf,
  ratesAfter,
  type RateCurve,
} from './irm'

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

describe('ratesAfter, every venue through one call', () => {
  const aave: RateCurve = { kind: 'aave', irm: usdc, cash: 20, debt: 80 }
  const morpho: RateCurve = { kind: 'morpho', borrowApy: 0.06, supplied: 100, borrowed: 90 }

  it('prices a loop on Aave: more debt, more collateral', () => {
    expect(ratesAfter(aave, { borrow: 15 })).toEqual(aaveRatesAfter(usdc, 20, 80, 0, 15))
    expect(ratesAfter(aave, { supply: 100 })!.supplyApy).toBeLessThan(ratesAfter(aave, {})!.supplyApy!)
    expect(ratesAfter(aave, { borrow: 25 })).toBeUndefined()
  })

  it('prices a move out: a repayment lowers the rate, never below an empty reserve', () => {
    expect(ratesAfter(aave, { borrow: -40 })!.borrowApy).toBeLessThan(ratesAfter(aave, {})!.borrowApy)
    expect(ratesAfter(aave, { borrow: -500 })!.borrowApy).toBeCloseTo(aprToApy(usdc.base), 9)
  })

  it('prices a Morpho borrow, with no supply rate', () => {
    expect(ratesAfter(morpho, { borrow: 5 })).toEqual({ borrowApy: morphoBorrowApyAfter(0.06, 100, 90, 5) })
    expect(ratesAfter(morpho, { borrow: 11 })).toBeUndefined()
    expect(ratesAfter(morpho, { supply: 50 })).toEqual({ borrowApy: 0.06 })
  })
})

describe('kinkOf (A3)', () => {
  const aave: RateCurve = { kind: 'aave', irm: usdc, cash: 20, debt: 80 }
  it('Aave: room to the optimal utilization and the rate there, less the trade’s own borrow', () => {
    // 100 in the reserve, 80 borrowed: 10 more to reach 90 %
    expect(kinkOf(aave)!.room).toBeCloseTo(10, 9)
    expect(kinkOf(aave)!.borrowApy).toBeCloseTo(aprToApy(0.0475), 9)
    expect(kinkOf(aave, 4)!.room).toBeCloseTo(6, 9)
    expect(kinkOf(aave, 15)!.room).toBeLessThan(0)
    expect(kinkOf(undefined, 4)).toBeUndefined()
  })

  it('scales the rate at the kink by the v4 risk premium', () => {
    expect(kinkOf(aave, 0, 0.1)!.borrowApy).toBeCloseTo(aprToApy(0.0475) * 1.1, 9)
  })

  it('Morpho: room to 90 % and the rate at target', () => {
    const k = kinkOf({ kind: 'morpho', borrowApy: 0.06, supplied: 100, borrowed: 80 })!
    expect(k.room).toBeCloseTo(10, 9)
    expect(k.borrowApy).toBeCloseTo(aprToApy(Math.log1p(0.06) / morphoCurve(0.8)), 9)
  })
})

describe('adjustedRate', () => {
  const aave: RateCurve = { kind: 'aave', irm: usdc, cash: 20, debt: 80 }
  it('keeps today’s rate alone without a curve, a change or room', () => {
    expect(adjustedRate(0.05, undefined, { borrow: 5 }, 'borrow')).toEqual({ now: 0.05 })
    expect(adjustedRate(0.05, aave, {}, 'borrow')).toEqual({ now: 0.05 })
    expect(adjustedRate(0.05, aave, { borrow: 25 }, 'borrow')).toEqual({ now: 0.05 })
    expect(rateOf({ now: 0.05 })).toBe(0.05)
  })
  it('gives the side asked for after the trade', () => {
    const r = adjustedRate(0.05, aave, { borrow: 15 }, 'borrow')
    expect(r.after).toBeCloseTo(aprToApy(0.0475 + 0.1 * 0.5), 9)
    expect(rateOf(r)).toBe(r.after)
    expect(adjustedRate(0.03, aave, { supply: 100 }, 'supply').after).toBeLessThan(aaveRatesAfter(usdc, 20, 80, 0, 0)!.supplyApy)
  })
})
