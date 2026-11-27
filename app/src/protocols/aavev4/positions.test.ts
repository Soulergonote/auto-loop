import { describe, expect, it } from 'vitest'
import type { V4Reserve } from './reserves'
import { buildV4Positions, summarizeV4 } from './positions'

const reserve = (over: Partial<V4Reserve>): V4Reserve => ({
  chainId: 1,
  network: 'Ethereum',
  spoke: { name: 'Main', address: '0x00000000000000000000000000000000000000a1' },
  reserveId: 0,
  hub: 'Core',
  token: { address: '0x00000000000000000000000000000000000000c1', symbol: 'WETH', name: 'WETH', decimals: 18 },
  price: 2_000_00000000n,
  supplyApy: 0.02,
  underlyingApy: 0,
  borrowApy: 0,
  supplyRewardApy: 0,
  ending: { supply: { apy: 0 }, borrow: { apy: 0 } },
  borrowRewardApy: 0,
  collateralFactor: 0.8,
  collateralRisk: 0.1,
  canCollateral: true,
  canBorrow: false,
  borrowableUsd: 0,
  suppliableUsd: 0,
  ...over,
})
const weth = reserve({})
const usdc = reserve({
  reserveId: 7,
  token: { address: '0x00000000000000000000000000000000000000d1', symbol: 'USDC', name: 'USDC', decimals: 6 },
  price: 1_00000000n,
  borrowApy: 0.05,
  collateralFactor: 0,
  canBorrow: true,
})
const elsewhere = reserve({ spoke: { name: 'Lido', address: '0x00000000000000000000000000000000000000a2' } })
const none = { supplied: 0n, debt: 0n, collateral: false }

describe('v4 positions', () => {
  const accounts = new Map([['0x00000000000000000000000000000000000000a1', { healthFactor: 1_600_000_000_000_000_000n, riskPremium: 1_000n }]])
  const positions = buildV4Positions(
    [weth, usdc, elsewhere],
    [{ supplied: 10n ** 18n, debt: 0n, collateral: true }, { supplied: 0n, debt: 1_000_000_000n, collateral: false }, none],
    accounts,
  )
  it('keeps one position per spoke the address holds something in', () => {
    expect(positions).toHaveLength(1)
    expect(positions[0].spoke.name).toBe('Main')
    expect(positions[0].healthFactor).toBeCloseTo(1.6)
    expect(positions[0].riskPremium).toBeCloseTo(0.1)
    expect(positions[0].holdings.map((h) => [h.suppliedBase, h.debtBase])).toEqual([
      [2_000_00000000n, 0n],
      [0n, 1_000_00000000n],
    ])
  })
  it('sums it up: leverage, threshold, borrow cost with the risk premium, APY on the net value', () => {
    const s = summarizeV4(positions[0])
    expect(s.equityBase).toBe(1_000_00000000n)
    expect(s.leverage).toBe(2)
    expect(s.threshold).toBeCloseTo(0.8)
    expect(s.borrowApy).toBeCloseTo(0.055)
    expect(s.apy).toBeCloseTo(0.02 * 2 - 0.055)
    expect(s.collateral?.reserve.token.symbol).toBe('WETH')
    expect(s.debt?.reserve.token.symbol).toBe('USDC')
  })
})
