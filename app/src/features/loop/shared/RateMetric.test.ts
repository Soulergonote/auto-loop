import { describe, expect, it } from 'vitest'
import { kinkAfter } from './RateMetric'
import { aprToApy } from '../../../domain/irm'

const irm = { optimal: 0.9, base: 0, slope1: 0.0475, slope2: 0.1, reserveFactor: 0.1 }

describe('kinkAfter (A3)', () => {
  it('takes the trade’s own borrow off the room, past the kink below zero', () => {
    const curve = { kind: 'aave' as const, irm, cash: 20, debt: 80 }
    expect(kinkAfter(curve, 4)!.room).toBeCloseTo(6, 9)
    expect(kinkAfter(curve, 15)!.room).toBeLessThan(0)
    expect(kinkAfter(undefined, 4)).toBeUndefined()
  })
  it('scales the rate at the kink by the v4 risk premium', () => {
    expect(kinkAfter({ kind: 'aave', irm, cash: 20, debt: 80 }, 0, 0.1)!.borrowApy).toBeCloseTo(aprToApy(0.0475) * 1.1, 9)
  })
})
