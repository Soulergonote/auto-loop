import { describe, expect, it } from 'vitest'
import { leverageAtHf, rebalanceFor, rebalanceTo, safetyTarget } from './rebalance'

const B = 10n ** 8n
// 4x on a 95 % threshold: C 4000, D 3000, HF = 0.95 x 4000 / 3000
const pos = (C: number, D: number, lt: number, correlated = true) => ({
  collateralBase: BigInt(C) * B,
  debtBase: BigInt(D) * B,
  healthFactor: (lt * C) / D,
  correlated,
})

describe('leverageAtHf', () => {
  it('is HF / (HF - LT)', () => {
    expect(leverageAtHf(1.1, 0.95)).toBeCloseTo(7.333, 3)
    expect(leverageAtHf(0.9, 0.95)).toBe(Infinity)
  })
})

describe('rebalanceTo', () => {
  it('below the target: repays down to its leverage', () => {
    // HF 0.95 x 4000 / 3500 = 1.0857, target 1.15: L = 1.15 / (1.15 - 0.95) = 5.75, equity 500 -> debt 2375
    const r = rebalanceTo(pos(4000, 3500, 0.95), 1.15)!
    expect(r.direction).toBe('down')
    expect(r.leverage).toBeCloseTo(5.75)
    expect(Number(r.debtChangeBase) / 1e8).toBeCloseTo(3500 - 2375, 4)
  })
  it('above the target: borrows up to its leverage', () => {
    // HF 1.2667 at 4x, target 1.1: L = 7.333, equity 1000 -> debt 6333
    const r = rebalanceTo(pos(4000, 3000, 0.95), 1.1)!
    expect(r.direction).toBe('up')
    expect(Number(r.debtChangeBase) / 1e8).toBeCloseTo(6333.33 - 3000, 1)
  })
  it('nothing inside the band, without debt, or for an impossible target', () => {
    // HF 1.2667: within +0.03 of 1.25
    expect(rebalanceTo(pos(4000, 3000, 0.95), 1.25)).toBeUndefined()
    expect(rebalanceTo({ ...pos(4000, 3000, 0.95), debtBase: 0n }, 1.1)).toBeUndefined()
    expect(rebalanceTo(pos(4000, 3000, 0.95), 0.9)).toBeUndefined()
  })
  it('the band is wider for a pair that moves apart', () => {
    // WETH / USDC at LT 0.83: HF 0.83 x 4000 / 2200 = 1.509, target 1.45: within +0.1
    expect(rebalanceTo(pos(4000, 2200, 0.83, false), 1.45)).toBeUndefined()
    expect(rebalanceTo(pos(4000, 2200, 0.83, false), 1.4)?.direction).toBe('up')
  })
})

describe('rebalanceFor', () => {
  it('follows the chosen target', () => {
    expect(rebalanceFor(pos(4000, 3000, 0.95), 1.1)?.direction).toBe('up')
  })
  it('without one: only brings an amber or red position back to safety, never adds leverage', () => {
    expect(safetyTarget(true)).toBe(1.1)
    expect(safetyTarget(false)).toBe(1.4)
    // HF 1.2667, green: nothing
    expect(rebalanceFor(pos(4000, 3000, 0.95), undefined)).toBeUndefined()
    // HF 1.0556, amber for a correlated pair: back to 1.10
    const r = rebalanceFor(pos(4000, 3600, 0.95), undefined)!
    expect(r.direction).toBe('down')
    expect(r.target).toBe(1.1)
  })
})
