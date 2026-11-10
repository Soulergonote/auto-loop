import { describe, expect, it } from 'vitest'
import { hfAtLeverage, isCorrelated, isUsdStable, leverageAtHf, loopCapacity, scanMarket } from './scan'
import { toCampaign } from './merkl'
import type { Snapshot, SnapReserve } from './snapshot'
import type { EModeCategory } from './useMarket'
import { USD, emode, reserve } from './testReserves'

const snapshot = (reserves: SnapReserve[], emodes: EModeCategory[] = []): Snapshot => ({
  market: { id: 'test' } as Snapshot['market'],
  reserves,
  emodes,
  premiumBps: 0n,
})

describe('scanner maths', () => {
  it('finds the leverage of a target health factor, capped by the LTV and the slider', () => {
    // LT 95 %, HF 1.10 -> L = 1.1 / 0.15
    expect(leverageAtHf(9500, 9300, 1.1)).toBeCloseTo(7.333, 3)
    expect(hfAtLeverage(9500, 1.1 / 0.15)).toBeCloseTo(1.1)
    // LT 78 %, LTV 75 %: HF 1.05 would need 3.89x but the LTV allows 4x x 95 % = 3.8x
    expect(leverageAtHf(7800, 7500, 1.05)).toBeCloseTo(3.8)
    expect(leverageAtHf(9700, 9600, 1.01)).toBe(15)
  })

  it('recognises USD stablecoins by oracle price and symbol', () => {
    expect(isUsdStable(reserve(0, 'USDC'))).toBe(true)
    expect(isUsdStable(reserve(0, 'sUSDe', { price: 120_000_000n }))).toBe(true)
    expect(isUsdStable(reserve(0, 'EURC', { price: 116_000_000n }))).toBe(false)
    expect(isUsdStable(reserve(0, 'WETH', { price: 3000n * USD }))).toBe(false)
  })

  it('limits the loopable equity by cash, borrow cap and supply cap', () => {
    const C = reserve(0, 'USDe', { supplyCap: 1_000_000n, totalSupplyBase: 600_000n * USD })
    const D = reserve(1, 'USDC', { cashBase: 2_000_000n * USD, borrowCap: 1_000_000n, totalDebtBase: 700_000n * USD })
    // debt room 300k / (5 - 1) = 75k; supply room 400k / 5 = 80k
    expect(loopCapacity(C, D, 5)).toBe(75_000n * USD)
    expect(loopCapacity(C, { ...D, cashBase: 100_000n * USD }, 5)).toBe(25_000n * USD)
  })
})

describe('scanMarket', () => {
  it('picks the eMode when it pays more and ranks pairs by yield', () => {
    const usde = reserve(0, 'USDe', { supplyApy: 0.06 })
    const usdc = reserve(1, 'USDC', { supplyApy: 0.03, borrowApy: 0.04 })
    const weth = reserve(2, 'WETH', { price: 3000n * USD, supplyApy: 0.01, borrowApy: 0.02 })
    const rows = scanMarket(snapshot([usde, usdc, weth], [emode(1, [0], [1])]), [], { targetHf: 1.1 })
    const top = rows[0]
    expect(top.collateral.token.symbol).toBe('USDe')
    expect(top.debt.token.symbol).toBe('USDC')
    // the eMode (LT 95 %) allows 7.3x at HF 1.1, against 3.8x outside it
    expect(top.emode?.id).toBe(1)
    expect(top.apy).toBeCloseTo(0.06 * top.leverage - 0.04 * (top.leverage - 1))
    expect(top.correlated && top.stable).toBe(true)
    // losing pairs are still listed (USDC against WETH borrowed at 2 % earns, WETH against USDC at 4 % loses)
    expect(rows.find((r) => r.collateral.token.symbol === 'WETH' && r.debt.token.symbol === 'USDC')!.apy).toBeLessThan(0)
    expect(rows.every((r, i) => i === 0 || rows[i - 1].apy >= r.apy)).toBe(true)
    // no pair of a reserve with itself
    expect(rows.some((r) => r.collateral.token.address === r.debt.token.address)).toBe(false)
  })

  it('adds the Merkl campaigns the loop qualifies for, at the loop health factor', () => {
    const usde = reserve(0, 'USDe', { supplyApy: 0.0, ltv: 0 })
    const usdc = reserve(1, 'USDC', { borrowApy: 0.04 })
    const campaign = toCampaign({
      type: 'AAVE_SUPPLY',
      action: 'LEND',
      name: 'Ethena',
      identifier: usde.aToken + 'BORROW_BL',
      explorerAddress: usde.aToken,
      apr: 5,
      latestCampaignEnd: '2000000000',
      campaigns: [{ params: { hooks: [{ healthFactorThreshold: '2' }] } }],
    } as never)!
    const [row] = scanMarket(snapshot([usde, usdc], [emode(1, [0], [1])]), [campaign], { targetHf: 1.1, nowMs: 1_000_000_000_000 })
    expect(row.emode?.id).toBe(1)
    expect(row.leverage).toBeCloseTo(7.333, 3)
    expect(row.rewardsApy).toBeCloseTo(0.05 * row.leverage)
    expect(row.apy).toBeCloseTo(row.ratesApy + row.rewardsApy)
    expect(row.rewardsEnd).toBe(2_000_000_000)
    // at HF 3 the Ethena rule (HF at most 2) is broken: no reward counted
    const [loose] = scanMarket(snapshot([usde, usdc], [emode(1, [0], [1])]), [campaign], { targetHf: 3 })
    expect(loose.rewardsApy).toBe(0)
  })

  it('does not take every eMode pair for a correlated one', () => {
    const link = reserve(0, 'LINK', { price: 20n * USD, supplyApy: 0.1, ltv: 7000, lt: 7500 })
    const usdc = reserve(1, 'USDC')
    const wsteth = reserve(2, 'wstETH', { price: 3600n * USD })
    const weth = reserve(3, 'WETH', { price: 3000n * USD })
    const rows = scanMarket(snapshot([link, usdc, wsteth, weth], [emode(1, [0], [1], 7500, 8000), emode(2, [2], [3])]), [], { targetHf: 1.5 })
    const linkUsdc = rows.find((r) => r.collateral.token.symbol === 'LINK' && r.debt.token.symbol === 'USDC')!
    expect(linkUsdc.emode?.id).toBe(1)
    expect(linkUsdc.correlated).toBe(false)
    expect(linkUsdc.flags).not.toContain('nativeUnknown')
    const lst = rows.find((r) => r.collateral.token.symbol === 'wstETH' && r.debt.token.symbol === 'WETH')!
    expect(lst.correlated).toBe(true)
    expect(lst.flags).toContain('nativeUnknown')
  })

  it('counts the intrinsic yield of the collateral on L and of a yield-bearing debt on L - 1', () => {
    const since = 1_700_000_000
    const wsteth = reserve(0, 'wstETH', { price: 3600n * USD, supplyApy: 0, native: { apy: 0.03, source: 'aave', since } })
    const weth = reserve(1, 'WETH', { price: 3000n * USD, borrowApy: 0.02 })
    const weeth = reserve(2, 'weETH', { price: 3200n * USD, borrowApy: 0.01, native: { apy: 0.025, source: 'aave', since } })
    const rows = scanMarket(snapshot([wsteth, weth, weeth], [emode(1, [0], [1, 2], 9300, 9500)]), [], { targetHf: 1.1 })
    const onWeth = rows.find((r) => r.collateral.token.symbol === 'wstETH' && r.debt.token.symbol === 'WETH')!
    const L = onWeth.leverage
    expect(onWeth.nativeApy).toBeCloseTo(0.03 * L)
    expect(onWeth.ratesApy).toBeCloseTo(-0.02 * (L - 1))
    expect(onWeth.apy).toBeCloseTo(0.03 * L - 0.02 * (L - 1))
    expect(onWeth.flags).not.toContain('nativeUnknown')
    const onWeeth = rows.find((r) => r.collateral.token.symbol === 'wstETH' && r.debt.token.symbol === 'weETH')!
    expect(onWeeth.nativeApy).toBeCloseTo(0.03 * onWeeth.leverage - 0.025 * (onWeeth.leverage - 1))
  })

  it('does not take EURC / USDC for a correlated, yield-bearing pair (the euro is not a yield)', () => {
    const eurc = reserve(0, 'EURC', { price: 116_000_000n })
    const usdc = reserve(1, 'USDC')
    const rows = scanMarket(snapshot([eurc, usdc], [emode(1, [0, 1], [0, 1])]), [], { targetHf: 1.5 })
    const row = rows.find((r) => r.collateral.token.symbol === 'EURC')!
    expect(row.correlated).toBe(false)
    expect(row.flags).not.toContain('nativeUnknown')
    expect(isCorrelated(reserve(0, 'cbBTC', { price: 70_000n * USD }), reserve(1, 'WBTC', { price: 70_100n * USD }))).toBe(true)
    expect(isCorrelated(reserve(0, 'sUSDe', { price: 120_000_000n }), reserve(1, 'USDC'))).toBe(true)
    expect(isCorrelated(reserve(0, 'WETH', { price: 3000n * USD }), reserve(1, 'USDC'))).toBe(false)
  })

  it('skips what the open panel would refuse: frozen, isolated, LTV 0, no flash loan', () => {
    const ok = reserve(0, 'USDC')
    const rows = (r: SnapReserve) => scanMarket(snapshot([ok, r]), [], { targetHf: 1.5 })
    const frozen = reserve(1, 'X')
    frozen.config = { ...frozen.config, frozen: true }
    expect(rows(frozen)).toHaveLength(0)
    const isolated = reserve(1, 'X')
    isolated.config = { ...isolated.config, isolated: true, flashLoanEnabled: false }
    expect(rows(isolated)).toHaveLength(0)
    expect(rows(reserve(1, 'X', { ltv: 0 })).map((r) => r.collateral.token.symbol)).toEqual(['USDC'])
  })
})
