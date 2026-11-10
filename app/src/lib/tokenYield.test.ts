import { describe, expect, it } from 'vitest'
import { aprToApy, parsePendleYields, pickTokenYield, rayRateToApy, tokenCopies, tokenKey, type SourceData } from './tokenYield'
import { SAME_TOKEN } from './yieldTokens'

const SUSDE_ETH = SAME_TOKEN.sUSDe[1]
const SUSDE_OFT = SAME_TOKEN.sUSDe[42161]
const SYRUP_ETH = SAME_TOKEN.syrupUSDC[1]
const SYRUP_BASE = SAME_TOKEN.syrupUSDC[8453]
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
    expect(pickTokenYield(8453, SYRUP_BASE, { morpho })).toEqual({ apy: 0.0544, source: 'morpho', fromChain: 1 })
    // the token's own figure beats its copies' within a source
    const pendle = data([
      [1, SUSDE_ETH, 0.051],
      [43114, SUSDE_OFT, 0.03],
    ])
    expect(pickTokenYield(43114, SUSDE_OFT, { pendle })).toEqual({ apy: 0.03, source: 'pendle' })
    // a better source on a copy beats a worse one on the token itself
    expect(pickTokenYield(43114, SUSDE_OFT, { pendle: data([[1, SUSDE_ETH, 0.051]]), morpho: data([[43114, SUSDE_OFT, 0.04]]) })).toMatchObject({
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
  })
})
