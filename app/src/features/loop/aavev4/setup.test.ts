import { describe, expect, it } from 'vitest'
import { defaultCapital, v4SetupOf, v4SetupSteps } from './setup'

describe('v4 setup steps', () => {
  it('asks for everything while the account is not read, nothing once it is set', () => {
    expect(v4SetupOf()).toEqual({ giver: true, taker: true, collateral: true })
    expect(v4SetupSteps(v4SetupOf({ giverSet: true, takerSet: true, collateralEnabled: true }), false)).toEqual([])
  })
  it('is one line, a transaction of its own without batches', () => {
    const [step] = v4SetupSteps(v4SetupOf(), false)
    expect(step.label).toMatch(/^Activer les gestionnaires.*collatéral \(transaction, une fois par spoke\)$/)
    expect(v4SetupSteps(v4SetupOf(), true)[0].label).not.toMatch(/transaction/)
  })
  it('leaves the collateral flag out of a close', () => {
    expect(v4SetupSteps({ giver: false, taker: false, collateral: true }, false, { collateral: false })).toEqual([])
  })
})

describe('default capital', () => {
  it('is about 1 000 $ of the token', () => {
    expect(defaultCapital(1)).toBe('1000')
    expect(defaultCapital(1832)).toBe('0.55')
    expect(defaultCapital(98_000)).toBe('0.01')
    expect(defaultCapital(0)).toBe('1000')
  })
})
