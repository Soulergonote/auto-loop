import { describe, expect, it } from 'vitest'
import { logoOf } from './Logo'
import { LOGOS } from '../generated/logos'
import { MARKETS, MORPHO_NETWORKS, networkName } from '../config'

describe('logos', () => {
  it('has one for every network of the app', () => {
    const names = [...MARKETS.map((m) => networkName(m.label)), ...MORPHO_NETWORKS.map((n) => n.label)]
    expect(names.filter((n) => !logoOf(n))).toEqual([])
  })
  it('finds a protocol by its first word, and nothing for an unknown name', () => {
    expect(logoOf('Aave v3')).toBe(LOGOS.Aave)
    expect(logoOf('Morpho Blue')).toBe(LOGOS.Morpho)
    expect(logoOf('Ethereum (Prime)')).toBe(LOGOS.Ethereum)
    expect(logoOf('Spark')).toBeUndefined()
  })
  it('is monochrome: no colour but currentColor', () => {
    for (const l of Object.values(LOGOS)) expect(l.body.match(/(fill|stroke)="(?!currentColor|none)[^"]*"/g) ?? []).toEqual([])
  })
})
