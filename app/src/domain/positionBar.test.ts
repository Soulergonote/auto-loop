import { describe, expect, it } from 'vitest'
import { barGeometry, hfAtPriceMove, thresholdOf } from './positionBar'

describe('barGeometry', () => {
  it('places the debt at LT / HF and the liquidation at LT', () => {
    const g = barGeometry(1.25, 0.8, 1.2)!
    expect(g.debt).toBeCloseTo(0.64)
    expect(g.liquidation).toBe(0.8)
    expect(g.projected).toBeCloseTo(0.8 / 1.2)
  })
  it('clamps an underwater position and ignores an unusable projection', () => {
    const g = barGeometry(0.5, 0.9, Infinity)!
    expect(g.debt).toBe(1)
    expect(g.projected).toBeUndefined()
  })
  it('nothing without debt', () => {
    expect(barGeometry(Infinity, 0.8)).toBeUndefined()
    expect(barGeometry(1.5, 0)).toBeUndefined()
  })
  it('threshold from the account, HF after a price move', () => {
    expect(thresholdOf(1.25, 10_000, 6_400)).toBeCloseTo(0.8)
    expect(thresholdOf(1.25, 10_000, 0)).toBe(0)
    expect(hfAtPriceMove(1.25, -0.2)).toBeCloseTo(1)
  })
})
