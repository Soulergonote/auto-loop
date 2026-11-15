import { describe, expect, it } from 'vitest'
import { shares, totalGain } from './portfolio'

describe('shares', () => {
  const parts = [
    { network: 'Plasma', protocol: 'Aave v3', usd: 600 },
    { network: 'Ethereum', protocol: 'Morpho Blue', usd: 300 },
    { network: 'Plasma', protocol: 'Morpho Blue', usd: 100 },
    { network: 'Base', protocol: 'Aave v3', usd: 0 },
  ]
  it('groups by network, biggest first, without empty parts', () => {
    expect(shares(parts, 'network')).toEqual([
      { label: 'Plasma', usd: 700, share: 0.7 },
      { label: 'Ethereum', usd: 300, share: 0.3 },
    ])
  })
  it('groups by protocol', () => {
    expect(shares(parts, 'protocol').map((s) => [s.label, s.share])).toEqual([
      ['Aave v3', 0.6],
      ['Morpho Blue', 0.4],
    ])
  })
  it('is empty without value', () => {
    expect(shares([{ network: 'Base', protocol: 'Aave v3', usd: -5 }], 'network')).toEqual([])
  })
})

describe('totalGain', () => {
  it('adds the known gains and counts the rest', () => {
    expect(totalGain([{ usd: 12, since: 200 }, { usd: -2, since: 100 }, 'pending', 'none'])).toEqual({
      usd: 10,
      since: 100,
      counted: 2,
      pending: 1,
      positions: 4,
    })
  })
  it('has no date without a gain', () => {
    expect(totalGain(['none']).since).toBeUndefined()
  })
})
