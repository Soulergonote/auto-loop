import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { needsRenewal, ptPriceFromApy, ptYield, type PtInfo } from './pt'
import { fmtMaturity, ptShortSymbol } from '../../ui/format'
import { loopCosts } from '../../domain/economics'
import { scanMarket } from '../../features/scanner/aaveScan'
import { rollTargets } from '../aave/swapCollateral'
import type { Snapshot, SnapReserve } from '../aave/snapshot'
import { addr, emode, reserve } from '../../test/testReserves'

const NOW = 1_790_000_000
const DAY = 86_400
const info = (n: number, o: Partial<PtInfo> = {}): PtInfo => ({
  pt: addr(0x100 + n),
  sy: addr(0x5000),
  yt: addr(0x6000 + n),
  expiry: NOW + 90 * DAY,
  expired: false,
  tokensIn: [],
  tokensOut: [],
  market: addr(0x7000 + n) as Address,
  impliedApy: 0.12,
  ...o,
})
const withPt = (r: SnapReserve, pt: PtInfo): SnapReserve => ({ ...r, pt, native: ptYield(pt, NOW) })

describe('PT yield and maturity', () => {
  it('counts the implied APY as a fixed yield until maturity, nothing after', () => {
    expect(ptYield(info(0), NOW)).toEqual({ apy: 0.12, source: 'pt', fixedUntil: NOW + 90 * DAY })
    expect(ptYield(info(0, { expired: true }), NOW)).toBeUndefined()
    expect(ptYield(info(0, { expiry: NOW - 1 }), NOW)).toBeUndefined()
    expect(ptYield(info(0, { impliedApy: undefined }), NOW)).toBeUndefined()
  })

  it('prices a PT from its APY and writes the days left', () => {
    expect(ptPriceFromApy(0.12, 365)).toBeCloseTo(1 / 1.12, 9)
    expect(ptPriceFromApy(0.12, -3)).toBe(1)
    expect(fmtMaturity(NOW + 32.7 * DAY, NOW)).toBe('J−32')
    expect(fmtMaturity(NOW + 3600, NOW)).toBe('J−0')
    expect(fmtMaturity(NOW, NOW)).toBe('échu')
    expect(ptShortSymbol('PT-reUSDe-10DEC2026')).toBe('PT-reUSDe')
    expect(ptShortSymbol('PT-sUSN-22JUL2027')).toBe('PT-sUSN')
  })

  it('offers a roll in the last month or once matured', () => {
    expect(needsRenewal(info(0, { expiry: NOW + 31 * DAY }), NOW)).toBe(false)
    expect(needsRenewal(info(0, { expiry: NOW + 29 * DAY }), NOW)).toBe(true)
    expect(needsRenewal(info(0, { expired: true, expiry: NOW + 99 * DAY }), NOW)).toBe(true)
  })
})

describe('PT pairs', () => {
  it('leaves the exit swap out when Pendle redeems straight into the debt asset', () => {
    const base = { entrySoldBase: 1000n, entrySwapBase: 10n, debtBase: 5000n, premiumBps: 0n }
    expect(loopCosts(base).exitSwap).toBe(50n)
    expect(loopCosts({ ...base, freeExit: true }).exitSwap).toBe(0n)
    expect(loopCosts({ ...base, gasPriceWei: 10n ** 9n, nativePriceBase: 10n ** 8n, gasUnits: 2_000_000n }).gas).toBe(200_000n)
  })

  it('scans a PT only while it can still be bought', () => {
    const usdc = reserve(1, 'USDC', { borrowApy: 0.05 })
    const live = withPt(reserve(0, 'PT-A'), info(0))
    const snap = (pt: SnapReserve): Snapshot => ({
      market: { id: 't' } as Snapshot['market'],
      reserves: [pt, usdc],
      emodes: [emode(1, [0], [1])],
      premiumBps: 0n,
    })
    const ptRows = (s: Snapshot) => scanMarket(s, [], { targetHf: 1.1 }).filter((r) => r.collateral.token.symbol === 'PT-A')
    const [row] = ptRows(snap(live))
    expect(row.nativeApy).toBeGreaterThan(0)
    expect(ptRows(snap(withPt(reserve(0, 'PT-A'), info(0, { expired: true }))))).toEqual([])
    expect(ptRows(snap(withPt(reserve(0, 'PT-A'), info(0, { market: undefined }))))).toEqual([])
  })

  it('rolls into a later PT, same underlying first, then the nearest maturity', () => {
    const from = withPt(reserve(0, 'PT-A-DEC'), info(0, { expiry: NOW + 10 * DAY }))
    const other = withPt(reserve(1, 'PT-B-MAR'), info(1, { sy: addr(0x5001), expiry: NOW + 100 * DAY }))
    const later = withPt(reserve(2, 'PT-A-JUN'), info(2, { expiry: NOW + 200 * DAY }))
    const sooner = withPt(reserve(3, 'PT-A-NOV'), info(3, { expiry: NOW + 5 * DAY }))
    const dead = withPt(reserve(4, 'PT-A-OLD'), info(4, { expiry: NOW + 300 * DAY, expired: true }))
    const plain = reserve(5, 'USDe')
    expect(rollTargets([other, later, sooner, dead, plain], from, NOW).map((r) => r.token.symbol)).toEqual(['PT-A-JUN', 'PT-B-MAR'])
    expect(rollTargets([later], reserve(6, 'USDe'), NOW)).toEqual([])
  })
})

describe('Pendle networks', () => {
  it('gives every Pendle network a quoter, its factories and the PT oracle, and only networks of the app', async () => {
    const { MARKETS, PENDLE_FACTORIES, PENDLE_MARKETS, PENDLE_PY_ORACLE, PENDLE_ROUTER_STATIC, pendleChain } = await import('../../config')
    const ids = Object.keys(PENDLE_ROUTER_STATIC).map(Number)
    expect(ids.sort((x, y) => x - y)).toEqual([1, 10, 56, 143, 146, 5000, 8453, 9745, 42161])
    for (const id of ids) {
      expect(PENDLE_FACTORIES[id]?.length).toBeGreaterThan(0)
      expect(PENDLE_PY_ORACLE[id]).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(MARKETS.some((m) => m.chain.id === id)).toBe(true)
    }
    for (const id of Object.keys(PENDLE_MARKETS).map(Number)) expect(pendleChain(id)).toBe(true)
    // no Pendle there
    expect([43114, 137, 59144].some(pendleChain)).toBe(false)
  })
})
