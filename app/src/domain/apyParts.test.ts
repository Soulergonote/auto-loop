import { describe, expect, it } from 'vitest'
import { apyLines } from './apyParts'

describe('apyLines', () => {
  it('separates the deposit rate from the token’s own yield', () => {
    const { lines, total } = apyLines({ leverage: 5, deposit: 0.001, native: 0.028, borrow: 0.021, rewards: 0 }, { lends: true })
    expect(lines.map((l) => l.label)).toEqual(['Dépôt du collatéral', 'Rendement du token', 'Emprunt'])
    expect(lines[0].value).toBeCloseTo(0.005)
    expect(lines[1].value).toBeCloseTo(0.14)
    expect(lines[2].value).toBeCloseTo(-0.084)
    expect(total).toBeCloseTo(0.061)
  })
  it('keeps a zero deposit line where the collateral is lent, drops it on Morpho', () => {
    const p = { leverage: 3, deposit: 0, native: 0.05, borrow: 0.04, rewards: 0 }
    expect(apyLines(p, { lends: true }).lines).toHaveLength(3)
    expect(apyLines(p, { lends: false }).lines.map((l) => l.label)).toEqual(['Rendement du token', 'Emprunt'])
  })
  it('counts a PT, a risk premium, a yield-bearing debt and Merkl', () => {
    const { lines, total } = apyLines(
      { leverage: 4, deposit: 0, native: 0.08, nativeFixed: true, borrow: 0.05, riskPremium: 0.005, debtNative: 0.01, rewards: 0.03 },
      { lends: false },
    )
    expect(lines.map((l) => l.label)).toEqual(['Rendement fixe du PT', 'Emprunt', 'Prime de risque', 'Rendement du token emprunté', 'Bonus Merkl'])
    expect(total).toBeCloseTo(0.32 - 0.15 - 0.015 - 0.03 + 0.03)
  })
})
