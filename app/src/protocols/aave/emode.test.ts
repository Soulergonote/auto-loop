import { describe, expect, it } from 'vitest'
import { eligibleEModes, type EModeCategory, type Reserve } from './useMarket'

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
