import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import markets from './__fixtures__/morpho-markets.json'
import { parseMarkets } from './morpho'
import { scanMorpho } from './morphoScan'
import type { PtInfo } from './pendle'

const parsed = parseMarkets(1, markets as never)
const bySymbol = (s: string) => parsed.find((m) => m.collateral.symbol === s)!
const NOW = Date.UTC(2026, 10, 9) / 1000
const pt = (token: string, expiry: number, impliedApy?: number): PtInfo => ({
  pt: getAddress(token),
  sy: getAddress('0x0000000000000000000000000000000000000001'),
  yt: getAddress('0x0000000000000000000000000000000000000002'),
  expiry,
  expired: false,
  tokensIn: [],
  tokensOut: [],
  impliedApy,
})

describe('scanMorpho', () => {
  it('loops each market at the target health factor, capped by the slider', () => {
    const rows = scanMorpho(parsed, { targetHf: 1.1, nowSec: NOW })
    const eth = rows.find((r) => r.market.collateral.symbol === 'wstETH')!
    // HF = LLTV x L / (L - 1) → L = 1.1 / (1.1 - 0.965)
    expect(eth.leverage).toBeCloseTo(1.1 / (1.1 - 0.965), 6)
    expect(eth.healthFactor).toBeCloseTo(1.1, 9)
    expect(eth.correlated).toBe(true)
    expect(eth.stable).toBe(false)
    const y = bySymbol('wstETH').collateralYield!.apy
    expect(eth.apy).toBeCloseTo(y * eth.leverage - bySymbol('wstETH').borrowApy * (eth.leverage - 1), 9)
    expect(eth.capacityUsd).toBeCloseTo(bySymbol('wstETH').liquidityUsd / (eth.leverage - 1), 3)
    // at 1.05 the 96.5 % market would go past 15x: capped
    expect(scanMorpho(parsed, { targetHf: 1.05, nowSec: NOW }).find((r) => r.market.collateral.symbol === 'wstETH')!.leverage).toBeCloseTo(1.05 / 0.085, 6)
    expect(scanMorpho(parsed, { targetHf: 1.0, nowSec: NOW }).find((r) => r.market.collateral.symbol === 'wstETH')!.leverage).toBe(15)
  })

  it('counts a PT at its Pendle implied APY and flags one whose market is unknown', () => {
    const re = bySymbol('PT-reUSD-10DEC2026')
    const usd3 = bySymbol('PT-USD3-17DEC2026')
    const pts = new Map([
      [re.collateral.address.toLowerCase(), pt(re.collateral.address, NOW + 31 * 86_400, 0.12)],
      [usd3.collateral.address.toLowerCase(), pt(usd3.collateral.address, NOW + 38 * 86_400)],
    ])
    const rows = scanMorpho(parsed, { targetHf: 1.1, pts, nowSec: NOW })
    const r = rows.find((x) => x.market.id === re.id)!
    expect(r.nativeApy).toBeCloseTo(0.12 * r.leverage, 9)
    expect(r.stable).toBe(true)
    expect(r.flags).not.toContain('nativeUnknown')
    expect(rows.find((x) => x.market.id === usd3.id)!.flags).toContain('nativeUnknown')
    // sorted by APY
    expect(rows.map((x) => x.apy)).toEqual([...rows.map((x) => x.apy)].sort((a, b) => b - a))
  })

  it('leaves out expired PTs, red warnings and unpriced markets', () => {
    const re = bySymbol('PT-reUSD-10DEC2026')
    const pts = new Map([[re.collateral.address.toLowerCase(), pt(re.collateral.address, NOW - 1, 0.1)]])
    expect(scanMorpho(parsed, { targetHf: 1.1, pts, nowSec: NOW }).some((r) => r.market.id === re.id)).toBe(false)
    const red = parsed.map((m) => (m.id === re.id ? { ...m, warnings: [{ type: 'bad_debt_unrealized', level: 'RED' }] } : m))
    expect(scanMorpho(red, { targetHf: 1.1, nowSec: NOW }).some((r) => r.market.id === re.id)).toBe(false)
    const unpriced = parsed.map((m) => (m.id === re.id ? { ...m, collateralUsd: 0 } : m))
    expect(scanMorpho(unpriced, { targetHf: 1.1, nowSec: NOW }).some((r) => r.market.id === re.id)).toBe(false)
  })

  it('flags nearly full and unlisted markets', () => {
    const rows = scanMorpho(
      parsed.map((m) => ({ ...m, listed: m.collateral.symbol !== 'wstETH' })),
      { targetHf: 1.1, lowCapacityUsd: 1e9, nowSec: NOW },
    )
    expect(rows.every((r) => r.flags.includes('lowCapacity'))).toBe(true)
    expect(rows.find((r) => r.market.collateral.symbol === 'wstETH')!.flags).toContain('unlisted')
  })
})
