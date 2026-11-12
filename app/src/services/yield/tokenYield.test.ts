import { describe, expect, it } from 'vitest'
import { aprToApy, growthToApy, parsePendleYields, pickTokenYield, rayRateToApy, tokenCopies, tokenKey, type SourceData } from './tokenYield'
import { matchCopies } from './copies'

const SUSDE_ETH = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497'
const SUSDE_OFT = '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2'
const SYRUP_ETH = '0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b'
const SYRUP_BASE = '0x660975730059246A68521a3e2FBD4740173100f5'
const copy = (chainId: number, address: string) => [{ chainId, address }]
const data = (entries: [number, string, number, string?][]): SourceData => new Map(entries.map(([c, a, apy, via]) => [tokenKey(c, a), { apy, via }]))

describe('token yields', () => {
  it('takes the first source in order: on-chain rate, then Pendle, then Morpho', () => {
    const sources = { rate: data([[1, SUSDE_ETH, 0.04, 'X']]), pendle: data([[1, SUSDE_ETH, 0.05]]), morpho: data([[1, SUSDE_ETH, 0.06]]) }
    expect(pickTokenYield(1, SUSDE_ETH, sources)).toEqual({ apy: 0.04, source: 'rate', via: 'X' })
    expect(pickTokenYield(1, SUSDE_ETH, { pendle: sources.pendle, morpho: sources.morpho })).toMatchObject({ apy: 0.05, source: 'pendle' })
    expect(pickTokenYield(1, SUSDE_ETH, { morpho: sources.morpho })).toMatchObject({ apy: 0.06, source: 'morpho' })
    expect(pickTokenYield(1, SUSDE_ETH, {})).toBeUndefined()
  })

  it('gives a bridged copy the yield of the same token on another chain, and says which', () => {
    // syrupUSDC: only Morpho on Ethereum knows it
    const morpho = data([[1, SYRUP_ETH, 0.0544]])
    expect(pickTokenYield(8453, SYRUP_BASE, { morpho }, copy(1, SYRUP_ETH))).toEqual({ apy: 0.0544, source: 'morpho', fromChain: 1 })
    // the token's own figure beats its copies' within a source
    const pendle = data([
      [1, SUSDE_ETH, 0.051],
      [43114, SUSDE_OFT, 0.03],
    ])
    expect(pickTokenYield(43114, SUSDE_OFT, { pendle }, copy(1, SUSDE_ETH))).toEqual({ apy: 0.03, source: 'pendle' })
    // a better source on a copy beats a worse one on the token itself
    expect(
      pickTokenYield(43114, SUSDE_OFT, { pendle: data([[1, SUSDE_ETH, 0.051]]), morpho: data([[43114, SUSDE_OFT, 0.04]]) }, copy(1, SUSDE_ETH)),
    ).toMatchObject({
      source: 'pendle',
      fromChain: 1,
    })
    // a token in no group has no copies
    expect(tokenCopies(1, '0x0000000000000000000000000000000000000001')).toHaveLength(1)
  })

  it('ignores yields that are a missing or broken feed', () => {
    for (const apy of [0, -0.01, 1.5, NaN]) expect(pickTokenYield(1, SUSDE_ETH, { pendle: data([[1, SUSDE_ETH, apy]]) })).toBeUndefined()
  })

  it('reads Pendle markets: interest yield of the underlying, deepest market wins', () => {
    const y = parsePendleYields(1, [
      { underlyingAsset: { address: SUSDE_ETH }, underlyingInterestApy: 0.04, liquidity: { usd: 1e6 } },
      { underlyingAsset: { address: SUSDE_ETH.toLowerCase() }, underlyingInterestApy: 0.051, liquidity: { usd: 5e7 } },
      { underlyingAsset: { address: SYRUP_ETH }, underlyingInterestApy: 0 },
      { underlyingAsset: { address: 'nope' }, underlyingInterestApy: 0.05 },
    ])
    expect([...y]).toEqual([[tokenKey(1, SUSDE_ETH), { apy: 0.051 }]])
  })

  it('converts rates to compounded yields', () => {
    // DSR 1.25 %: per-second ray read on-chain on 10 Nov 2026
    expect(rayRateToApy(1000000000393915525145987602n)).toBeCloseTo(0.0125, 6)
    expect(rayRateToApy(10n ** 27n)).toBe(0)
    expect(aprToApy(0.053)).toBeCloseTo(0.05443, 5)
    // savUSD share price over 7 days, read on Avalanche on 12 Nov 2026 (7.8 %)
    expect(growthToApy(10n ** 18n, 1001445000000000000n, 7 * 86_400)).toBeCloseTo(0.0782, 3)
    expect(growthToApy(10n ** 18n, 10n ** 18n, 7 * 86_400)).toBe(0)
    expect(growthToApy(0n, 10n ** 18n, 7 * 86_400)).toBeNaN()
  })

  it('puts a vault share price after the published rate, before Pendle', () => {
    const vault = data([[1, SUSDE_ETH, 0.045]])
    expect(pickTokenYield(1, SUSDE_ETH, { rate: data([[1, SUSDE_ETH, 0.04]]), vault })).toMatchObject({ source: 'rate' })
    expect(pickTokenYield(1, SUSDE_ETH, { vault, pendle: data([[1, SUSDE_ETH, 0.05]]) })).toEqual({ apy: 0.045, source: 'vault' })
  })

  it('matches a copy by symbol and price, never a look-alike', () => {
    const t = { chainId: 4663, address: '0x4085', symbol: 'syrupUSDG', price: 1.0186 }
    const eth = { chainId: 1, address: '0x87B6', symbol: 'syrupUSDG', price: 1.0188 }
    expect(matchCopies(t, [eth])).toEqual([{ chainId: 1, address: '0x87b6' }])
    // same symbol, other price: a different token
    expect(matchCopies(t, [{ ...eth, price: 1 }])).toEqual([])
    // other symbol, same price; the token itself; another token on its own chain
    expect(matchCopies(t, [{ ...eth, symbol: 'syrupUSDC' }, { ...t }, { ...eth, chainId: 4663 }])).toEqual([])
    // symbol case aside, no duplicates, no price no match
    expect(matchCopies(t, [{ ...eth, symbol: 'SYRUPUSDG' }, eth, { ...eth, chainId: 8453, price: 0 }])).toEqual([{ chainId: 1, address: '0x87b6' }])
  })
})
