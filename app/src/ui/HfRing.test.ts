import { describe, expect, it } from 'vitest'
import { ringFill, ringValue } from './HfRing'

describe('health factor ring', () => {
  it('fills from 1.0 (empty) to 1.5 (full), bounded, full without debt', () => {
    expect(ringFill(1)).toBe(0)
    expect(ringFill(1.25)).toBeCloseTo(0.5)
    expect(ringFill(2)).toBe(1)
    expect(ringFill(0.9)).toBe(0)
    expect(ringFill(Infinity)).toBe(1)
  })
  it('reads the value after the arrow of a before → after summary', () => {
    expect(ringValue('1.48 → 1.46')).toBe(1.46)
    expect(ringValue('1.10')).toBe(1.1)
    expect(ringValue('∞')).toBe(Infinity)
    expect(ringValue(undefined)).toBeUndefined()
  })
})
