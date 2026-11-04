import { describe, expect, it } from 'vitest'
import { apyTone, hfTone } from './tone'

describe('colour thresholds', () => {
  it('colours the health factor by pair type, with no gap at the boundaries', () => {
    expect([1.09, 1.1, 1.29, 1.3].map((h) => hfTone(h, false))).toEqual(['bad', 'warn', 'warn', 'good'])
    expect([1.02, 1.03, 1.07, 1.08].map((h) => hfTone(h, true))).toEqual(['bad', 'warn', 'warn', 'good'])
    expect(hfTone(Infinity, false)).toBeUndefined()
  })

  it('colours an APY red below 0 and green from 0', () => {
    expect([-0.01, 0, 0.05].map(apyTone)).toEqual(['bad', 'good', 'good'])
  })
})
