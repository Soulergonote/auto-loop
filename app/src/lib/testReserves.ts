/** Reserve and eMode fixtures for unit tests (not used by the app). */
import type { Address } from 'viem'
import type { SnapReserve } from './snapshot'
import type { EModeCategory } from './useMarket'

export const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
export const USD = 100_000_000n

export function reserve(
  id: number,
  symbol: string,
  o: Partial<SnapReserve> & { ltv?: number; lt?: number; borrowCap?: bigint; supplyCap?: bigint } = {},
): SnapReserve {
  const price = o.price ?? USD
  return {
    token: { address: addr(0x100 + id), symbol, name: symbol, decimals: 18 },
    id,
    config: {
      ltvBps: o.ltv ?? 7500,
      liquidationThresholdBps: o.lt ?? 7800,
      liquidationBonusBps: 10_500,
      decimals: 18,
      active: true,
      frozen: false,
      borrowingEnabled: true,
      paused: false,
      flashLoanEnabled: true,
      isolated: false,
      borrowCap: o.borrowCap ?? 0n,
      supplyCap: o.supplyCap ?? 0n,
    },
    aToken: addr(0xa00 + id),
    variableDebtToken: addr(0xd00 + id),
    supplyApy: o.supplyApy ?? 0.03,
    borrowApy: o.borrowApy ?? 0.05,
    supplyRewardApr: 0,
    borrowRewardApr: 0,
    native: o.native,
    price,
    side: { price, decimals: 18 },
    cashBase: o.cashBase ?? 10_000_000n * USD,
    totalSupplyBase: o.totalSupplyBase ?? 0n,
    totalDebtBase: o.totalDebtBase ?? 0n,
  }
}

export const emode = (id: number, collat: number[], borrow: number[], ltv = 9300, lt = 9500): EModeCategory => ({
  id,
  label: `cat ${id}`,
  ltvBps: ltv,
  liquidationThresholdBps: lt,
  liquidationBonusBps: 10_100,
  collateralBitmap: collat.reduce((b, i) => b | (1n << BigInt(i)), 0n),
  borrowableBitmap: borrow.reduce((b, i) => b | (1n << BigInt(i)), 0n),
  ltvZeroBitmap: 0n,
})
