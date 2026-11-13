import { describe, expect, it } from 'vitest'
import { eligibleEModes, type EModeCategory, type Reserve } from './useMarket'
import { legacyEModes } from './reserveConfig'

// Two categories as read on Aave v3 Base (2026-10-31): reserve ids WETH 0, USDC 4, wstETH 3, ezETH 7.
const cat = (id: number, label: string, ltvBps: number, collat: string, borrow: string, ltvZero = '0'): EModeCategory => ({
  id,
  label,
  ltvBps,
  liquidationThresholdBps: ltvBps + 200,
  liquidationBonusBps: 10100,
  collateralBitmap: BigInt('0b' + collat),
  borrowableBitmap: BigInt('0b' + borrow),
  ltvZeroBitmap: BigInt('0b' + ltvZero),
})
const categories = [
  cat(1, 'ETH correlated', 9000, '101011', '1'),
  cat(8, 'wstETH/WETH', 9300, '1000', '1'),
  cat(3, 'ezETH Stablecoins', 7200, '10000000', '10000', '10000000'),
]
const reserve = (id: number) => ({ id }) as Reserve

describe('eligibleEModes', () => {
  it('keeps categories where the collateral counts and the debt is borrowable, best LTV first', () => {
    expect(eligibleEModes(categories, reserve(3), reserve(0)).map((c) => c.id)).toEqual([8, 1])
  })
  it('drops a category whose debt asset is not borrowable', () => {
    expect(eligibleEModes(categories, reserve(3), reserve(4))).toEqual([])
  })
  it('drops a category where the collateral has LTV 0', () => {
    expect(eligibleEModes(categories, reserve(7), reserve(4))).toEqual([])
  })
})

describe('legacyEModes (pools before Aave v3.2: SparkLend)', () => {
  // configuration with eMode category `c` (bits 168-175) and borrowing enabled (bit 58) or not
  const conf = (c: number, borrow = true) => (BigInt(c) << 168n) | (borrow ? 1n << 58n : 0n)
  it('builds each category from the reserves that carry it', () => {
    const data = [
      { ltv: 9200, liquidationThreshold: 9300, liquidationBonus: 10100, label: 'ETH' },
      undefined,
      { ltv: 0, liquidationThreshold: 0, liquidationBonus: 0, label: '' },
    ]
    const reserves = [
      { id: 0, configuration: conf(1) }, // WETH
      { id: 3, configuration: conf(1, false) }, // wstETH, not borrowable
      { id: 5, configuration: conf(0) }, // USDC
    ]
    const [eth, ...rest] = legacyEModes(data, reserves)
    expect(rest).toEqual([])
    expect(eth).toMatchObject({
      id: 1,
      label: 'ETH',
      ltvBps: 9200,
      liquidationThresholdBps: 9300,
      collateralBitmap: 0b1001n,
      borrowableBitmap: 0b1n,
      ltvZeroBitmap: 0n,
    })
    // wstETH collateral, WETH debt: eligible; USDC debt: not
    expect(eligibleEModes([eth], reserve(3), reserve(0))).toEqual([eth])
    expect(eligibleEModes([eth], reserve(3), reserve(5))).toEqual([])
  })
})
