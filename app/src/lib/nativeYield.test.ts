import { describe, expect, it } from 'vitest'
import { loopNativeApy, nativeYieldFromRatio } from './nativeYield'

const DAY = 86_400

describe('intrinsic yield from an Aave CAPO adapter', () => {
  it('annualises the exchange-rate growth since the snapshot', () => {
    // wstETH on Base, 5 Nov 2026: 1.22718 on 17 Feb, 1.24842 now
    const y = nativeYieldFromRatio(1248420541703429835n, 1227182231483433137n, 1771307347n, 1793844248)!
    expect(y.since).toBe(1771307347)
    expect(y.apy).toBeCloseTo(0.0243, 3)
    // 1e27-scaled ratios (sDAI) work the same
    const now = 1_800_000_000
    expect(nativeYieldFromRatio(1050n * 10n ** 24n, 10n ** 27n, BigInt(now - 365 * DAY), now)!.apy).toBeCloseTo(0.05, 6)
  })

  it('gives nothing for a missing, broken or too recent snapshot', () => {
    const now = 1_800_000_000
    expect(nativeYieldFromRatio(undefined, 10n ** 18n, BigInt(now - 30 * DAY), now)).toBeUndefined()
    expect(nativeYieldFromRatio(10n ** 18n, 0n, BigInt(now - 30 * DAY), now)).toBeUndefined()
    expect(nativeYieldFromRatio(101n * 10n ** 16n, 10n ** 18n, BigInt(now - 3 * DAY), now)).toBeUndefined()
  })

  it('nets a yield-bearing debt against the collateral', () => {
    expect(loopNativeApy(5, { apy: 0.03, since: 0 })).toBeCloseTo(0.15)
    expect(loopNativeApy(5, { apy: 0.03, since: 0 }, { apy: 0.025, since: 0 })).toBeCloseTo(0.05)
    expect(loopNativeApy(5)).toBe(0)
  })
})
