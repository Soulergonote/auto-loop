import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { V4Reserve } from './reserves'
import { v4CollateralTargets, v4DebtTargets, v4Hf, v4SamePairs } from './switch'

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const reserve = (spoke: number, id: number, token: number, over: Partial<V4Reserve> = {}): V4Reserve => ({
  chainId: 1,
  network: 'Ethereum',
  spoke: { name: `S${spoke}`, address: A(0x500 + spoke) },
  reserveId: id,
  hub: 'Core',
  token: { address: A(token), symbol: `T${token}`, name: `T${token}`, decimals: 18 },
  price: 10n ** 8n,
  supplyApy: 0,
  underlyingApy: 0,
  borrowApy: 0.05,
  supplyRewardApy: 0,
  borrowRewardApy: 0,
  collateralFactor: 0.8,
  collateralRisk: 0,
  canCollateral: true,
  canBorrow: true,
  borrowableUsd: 1e6,
  suppliableUsd: 1e6,
  ...over,
})
// spoke 1: tokens 1 (collateral), 2 (debt), 3, 4 (not a collateral); spoke 2: 1 and 2 again; spoke 3: only 1
const all = [
  reserve(1, 0, 1),
  reserve(1, 1, 2),
  reserve(1, 2, 3),
  reserve(1, 3, 4, { canCollateral: false, collateralFactor: 0 }),
  reserve(2, 0, 2),
  reserve(2, 1, 1, { canBorrow: false }),
  reserve(3, 0, 1),
]
const pair = { collateral: all[0], debt: all[1] }

describe('v4 switch targets', () => {
  it('offers the other collaterals and debts of the spoke, never the pair’s own tokens', () => {
    expect(v4CollateralTargets(all, pair).map((r) => r.reserveId)).toEqual([2])
    expect(v4DebtTargets(all, pair).map((r) => r.reserveId)).toEqual([2, 3])
  })
  it('finds the same pair on other spokes, whatever the reserve ids', () => {
    const p = v4SamePairs(all, pair)
    expect(p).toHaveLength(1)
    expect(p[0].collateral.reserveId).toBe(1)
    expect(p[0].debt.reserveId).toBe(0)
    expect(p[0].canLand).toBe(true)
  })
  it('computes the health factor over every collateral', () => {
    expect(v4Hf([{ value: 100n, factor: 0.8 }], 50n)).toBeCloseTo(1.6)
    expect(
      v4Hf(
        [
          { value: 50n, factor: 0.8 },
          { value: 50n, factor: 0.9 },
        ],
        50n,
      ),
    ).toBeCloseTo(1.7)
    expect(v4Hf([{ value: 100n, factor: 0.8 }], 0n)).toBe(Infinity)
  })
})
