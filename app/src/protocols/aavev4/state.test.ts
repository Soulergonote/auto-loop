import { describe, expect, it } from 'vitest'
import { morphoHf, morphoLeverage } from '../morpho/markets'
import { usdToUnits, v4BorrowApy, v4Lltv, v4Price } from './state'

describe('Aave v4 pair as an isolated market', () => {
  // 30 WETH (18 decimals, 3 000 $) against 60 000 USDC (6 decimals, 1 $), collateral factor 84 %
  const price = v4Price(3000_00000000n, 18, 1_00000000n, 6)

  it('prices the collateral in debt units, decimals included', () => {
    expect((30n * 10n ** 18n * price) / 10n ** 36n).toBe(90_000_000000n)
    expect(v4Price(1n, 18, 0n, 6)).toBe(0n)
  })

  it('gives the spoke’s health factor and the leverage through the shared math', () => {
    expect(morphoHf(30n * 10n ** 18n, 60_000_000000n, price, v4Lltv(0.84))).toBeCloseTo(1.26, 9)
    expect(morphoLeverage(30n * 10n ** 18n, 60_000_000000n, price)).toBeCloseTo(3, 9)
  })

  it('keeps the precision of a collateral factor like 0.955', () => {
    expect(v4Lltv(0.955)).toBe(955_000_000_000_000_000n)
  })

  it('turns the API’s USD caps into token units', () => {
    expect(usdToUnits(1500, 3000_00000000n, 18)).toBe(5n * 10n ** 17n)
    expect(usdToUnits(1500, 0n, 18)).toBe(0n)
    expect(usdToUnits(0, 1_00000000n, 6)).toBe(0n)
  })

  it('adds the risk premium to the base borrow rate', () => {
    expect(v4BorrowApy(0.04, 0.2)).toBeCloseTo(0.048, 9)
  })
})
