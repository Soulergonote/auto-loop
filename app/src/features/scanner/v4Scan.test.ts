import { describe, expect, it } from 'vitest'
import { scanV4, v4LeverageAtHf } from './v4Scan'
import { parseV4Reserves, type V4Reserve } from '../../protocols/aavev4/reserves'

const reserve = (over: Partial<V4Reserve>): V4Reserve => ({
  chainId: 1,
  network: 'Ethereum',
  spoke: { name: 'Ethena Ecosystem', address: '0x00000000000000000000000000000000000000a1' },
  token: { address: '0x00000000000000000000000000000000000000c1', symbol: 'USDe' },
  price: 100_000_000n,
  supplyApy: 0,
  underlyingApy: 0,
  borrowApy: 0,
  supplyRewardApy: 0,
  borrowRewardApy: 0,
  collateralFactor: 0,
  collateralRisk: 0,
  canCollateral: false,
  canBorrow: false,
  borrowableUsd: 0,
  suppliableUsd: 0,
  ...over,
})

describe('v4LeverageAtHf', () => {
  it('gives the leverage of the target health factor', () => {
    expect(v4LeverageAtHf(0.93, 1.1)).toBeCloseTo(1.1 / 0.17)
  })
  it('is capped at the leverage of a health factor of 1.02 and at 15x', () => {
    expect(v4LeverageAtHf(0.93, 1.0)).toBeCloseTo(1.02 / 0.09)
    expect(v4LeverageAtHf(0.99, 1.0)).toBe(15)
  })
})

describe('scanV4', () => {
  const usde = reserve({ canCollateral: true, collateralFactor: 0.93, supplyRewardApy: 0.059, collateralRisk: 0.1, suppliableUsd: 10_000_000, rewardsEnd: 500 })
  const usdt = reserve({
    token: { address: '0x00000000000000000000000000000000000000d1', symbol: 'USDt' },
    canBorrow: true,
    borrowApy: 0.048,
    borrowableUsd: 340_000,
  })
  const other = reserve({
    spoke: { name: 'Main', address: '0x00000000000000000000000000000000000000a2' },
    token: { address: '0x00000000000000000000000000000000000000d2', symbol: 'USDC' },
    canBorrow: true,
    borrowApy: 0.01,
    borrowableUsd: 1e9,
  })
  it('pairs collaterals and debts of one spoke only', () => {
    const rows = scanV4([usde, usdt, other], { targetHf: 1.1 })
    expect(rows).toHaveLength(1)
    expect(rows[0].debt.token.symbol).toBe('USDt')
  })
  it('adds the risk premium to the borrow rate and levers Merkl', () => {
    const [r] = scanV4([usde, usdt], { targetHf: 1.1 })
    const L = 1.1 / 0.17
    expect(r.borrowCost).toBeCloseTo(0.048 * 1.1)
    expect(r.rewardsApy).toBeCloseTo(0.059 * L)
    expect(r.apy).toBeCloseTo(0.059 * L - 0.0528 * (L - 1))
    expect(r.capacityUsd).toBeCloseTo(340_000 / (L - 1))
    expect(r.rewardsEnd).toBe(500)
    expect(r.stable && r.correlated).toBe(true)
  })
  it('flags a PT, whose yield the API does not give', () => {
    const pt = reserve({ token: { address: '0x00000000000000000000000000000000000000c2', symbol: 'PT USDe' }, canCollateral: true, collateralFactor: 0.9 })
    expect(scanV4([pt, usdt], { targetHf: 1.1 })[0].nativeUnknown).toBe(true)
  })
})

describe('parseV4Reserves', () => {
  const raw = (over: object) => ({
    chain: { chainId: 1, name: 'Ethereum' },
    spoke: { name: 'Main', address: '0x00000000000000000000000000000000000000a2' as const },
    status: { frozen: false, paused: false, active: true },
    canBorrow: true,
    canSupply: true,
    canUseAsCollateral: true,
    asset: { underlying: { address: '0x00000000000000000000000000000000000000d2' as const, info: { symbol: 'USDC' } } },
    summary: {
      supplyApy: { value: '0.04' },
      borrowApy: { value: '0.05' },
      underlyingApy: null,
      borrowable: { exchange: { value: '1000' }, exchangeRate: { value: '1.0001' } },
      suppliable: { exchange: { value: '2000' } },
      rewards: [
        { __typename: 'MerklSupplyReward', extraApy: { value: '0.017' }, endDate: '2026-12-01T00:00:00Z' },
        { __typename: 'MerklBorrowReward', discountApy: { value: '0.018' }, endDate: '2026-11-20T00:00:00Z' },
        { __typename: 'SupplyPointsReward' },
      ],
    },
    settings: { collateralFactor: { value: '0' }, collateralRisk: { value: '0' } },
    ...over,
  })
  it('reads rates, Merkl on both sides and the price', () => {
    const [r] = parseV4Reserves([raw({})])
    expect(r).toMatchObject({ supplyApy: 0.04, borrowApy: 0.05, underlyingApy: 0, supplyRewardApy: 0.017, borrowRewardApy: 0.018, price: 100_010_000n })
    expect(r.canCollateral).toBe(false)
    expect(r.rewardsEnd).toBe(Date.parse('2026-11-20T00:00:00Z') / 1000)
  })
  it('leaves out frozen and paused reserves', () => {
    expect(
      parseV4Reserves([raw({ status: { frozen: true, paused: false, active: true } }), raw({ status: { frozen: false, paused: true, active: true } })]),
    ).toEqual([])
  })
})
