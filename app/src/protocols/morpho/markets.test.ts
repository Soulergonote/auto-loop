import { describe, expect, it } from 'vitest'
import { domainSeparator, getAddress, hashTypedData } from 'viem'
import markets from '../../test/fixtures/morpho-markets.json'
import {
  accruedBorrow,
  authorizationTypedData,
  debtForMorphoLeverage,
  dropToLiquidation,
  leverageAtMorphoHf,
  marketId,
  maxMorphoLeverage,
  morphoHf,
  morphoLeverage,
  morphoNetApy,
  morphoSides,
  parseMarkets,
  rateToApy,
  repayForMorphoLeverage,
  toAssetsUp,
  wTaylorCompounded,
} from './markets'
import { toBase } from '../../domain/math'

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const RE_USD = '0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64'

describe('parseMarkets', () => {
  const parsed = parseMarkets(1, markets as never)

  it('keeps markets whose parameters hash to their id', () => {
    expect(parsed).toHaveLength(3)
    const m = parsed.find((x) => x.id === RE_USD)!
    expect(m.collateral.symbol).toBe('PT-reUSD-10DEC2026')
    expect(m.loan.symbol).toBe('USDC')
    expect(m.loan.decimals).toBe(6)
    expect(m.lltv).toBeCloseTo(0.915)
    expect(marketId(m.params)).toBe(RE_USD)
  })

  it('drops a market whose parameters were changed (an oracle swapped by the API would not hash to the id)', () => {
    const tampered = (markets as { oracle: { address: string } }[]).map((m, i) =>
      i === 0 ? { ...m, oracle: { ...m.oracle, address: '0x0000000000000000000000000000000000000001' } } : m,
    )
    expect(parseMarkets(1, tampered as never)).toHaveLength(2)
  })

  it('drops idle markets (no collateral)', () => {
    const idle = { ...(markets[0] as object), collateralAsset: null }
    expect(parseMarkets(1, [idle] as never)).toHaveLength(0)
  })

  it('prices a collateral the API does not price from the oracle and the loan token', () => {
    const m = markets.find((x) => x.marketId === RE_USD) as { collateralAsset: object; loanAsset: { decimals: number; price: object }; state: object }
    // 1.03 USDC per PT (both 6 decimals): 1.03 x 1e36; USDC at 0.9998 USD
    const unpriced = {
      ...m,
      collateralAsset: { ...m.collateralAsset, price: null },
      loanAsset: { ...m.loanAsset, price: { usd: 0.9998 } },
      state: { ...m.state, price: '1030000000000000000000000000000000000' },
    }
    expect(parseMarkets(1, [unpriced] as never)[0].collateralUsd).toBeCloseTo(1.03 * 0.9998, 9)
    expect(parseMarkets(1, [{ ...unpriced, state: { ...m.state, price: null } }] as never)[0].collateralUsd).toBe(0)
  })
})

describe('Morpho math', () => {
  it('rounds shares up like Morpho', () => {
    // 1e6 virtual shares per virtual asset: 1 share of an empty market is worth 1 / 1e6 asset, rounded up to 1
    expect(toAssetsUp(1n, 0n, 0n)).toBe(1n)
    expect(toAssetsUp(3_000_000n, 2n, 3_000_000n)).toBe(3n)
  })

  it('accrues interest with the same Taylor expansion as Morpho', () => {
    const rate = 1_585_489_599n // 5 %/year per second
    const year = 365n * 86_400n
    const f = Number(wTaylorCompounded(rate, year)) / 1e18
    expect(f).toBeCloseTo(0.051271, 5)
    expect(accruedBorrow({ totalSupplyAssets: 0n, totalBorrowAssets: 1_000_000n, totalBorrowShares: 0n, lastUpdate: 0n, fee: 0n }, rate, year)).toBe(1_051_270n)
    expect(rateToApy(rate)).toBeCloseTo(0.05127, 4)
  })

  it('computes the health factor from the oracle price and the LLTV', () => {
    // 5000 PT at 0.95 USDC (6 decimals) each: price = 0.95e24, debt 3800 USDC, LLTV 91.5 %
    const price = 95n * 10n ** 22n
    expect(morphoHf(5000n * 10n ** 18n, 3800n * 10n ** 6n, price, 915n * 10n ** 15n)).toBeCloseTo(1.14375, 4)
    expect(morphoHf(1n, 0n, price, 915n * 10n ** 15n)).toBe(Infinity)
    expect(morphoLeverage(5000n * 10n ** 18n, 3800n * 10n ** 6n, price)).toBeCloseTo(5, 6)
  })

  it('leverage, health factor and liquidation move together', () => {
    expect(maxMorphoLeverage(0.915)).toBeCloseTo(11.7647, 3)
    const lev = leverageAtMorphoHf(0.915, 1.1)
    expect((0.915 * lev) / (lev - 1)).toBeCloseTo(1.1, 9)
    expect(dropToLiquidation(1.25)).toBeCloseTo(0.2, 9)
    expect(morphoNetApy(5, 0.08, 0.05)).toBeCloseTo(0.2, 9)
  })

  it('finds the debt for a target leverage, and the repayment back to a lower one', () => {
    // 950 USDC of capital at 5x: 3800 USDC of debt
    expect(debtForMorphoLeverage(0n, 0n, 950_000_000n, 50_000n)).toBe(3_800_000_000n)
    // a 4750 / 3800 position (5x) taken to 6x with no new capital: 950 x 6 - ... = 950 more
    expect(debtForMorphoLeverage(4_750_000_000n, 3_800_000_000n, 0n, 60_000n)).toBe(950_000_000n)
    // and back to 3x: equity 950, target debt 1900
    expect(repayForMorphoLeverage(4_750_000_000n, 3_800_000_000n, 30_000n)).toBe(1_900_000_000n)
    expect(repayForMorphoLeverage(4_750_000_000n, 3_800_000_000n, 60_000n)).toBe(0n)
  })

  it('gives USD sides that agree with the oracle', () => {
    const m = parseMarkets(1, markets as never).find((x) => x.id === RE_USD)!
    // PT-reUSD has 6 decimals like USDC: 0.98 USDC per PT is 0.98e36
    expect(m.collateral.decimals).toBe(6)
    const price = 98n * 10n ** 34n
    const { collateral, loan } = morphoSides({ ...m, loanUsd: 1 }, price)
    expect(collateral.price).toBe(98_000_000n)
    expect(loan.price).toBe(100_000_000n)
    // 1000 PT and 980 USDC are worth the same in base units
    expect(toBase(1000n * 10n ** 6n, collateral)).toBe(toBase(980n * 10n ** 6n, loan))
    // an 18-decimal collateral at the same price: 0.98e24
    const s18 = morphoSides({ ...m, collateral: { ...m.collateral, decimals: 18 }, loanUsd: 1 }, 98n * 10n ** 22n)
    expect(s18.collateral.price).toBe(98_000_000n)
  })
})

describe('authorization signature', () => {
  it('uses Morpho’s EIP-712 domain (chain id and address, no name or version)', () => {
    const td = authorizationTypedData(1, MORPHO, { authorizer: MORPHO, authorized: MORPHO, isAuthorized: true, nonce: 0n, deadline: 0n })
    // DOMAIN_SEPARATOR() of Morpho Blue on Ethereum, read on-chain 2026-11-09
    expect(domainSeparator({ domain: td.domain })).toBe('0xec6ac4ec6469375712b671d38548b711c7a4a17b4db99be41e0eb9f28cafdd2d')
    expect(hashTypedData(td)).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
