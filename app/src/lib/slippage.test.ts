import { describe, expect, it } from 'vitest'
import { defaultSlippage, extraWorstCaseUsd, isSlippageFailure, nextSlippage, pairKind, reserveAsset } from './slippage'

describe('slippage by pair', () => {
  it('classifies pairs', () => {
    expect(pairKind({ symbol: 'sUSDe', usd: 1.2 }, { symbol: 'USDC', usd: 1 })).toBe('stable')
    expect(pairKind({ symbol: 'wstETH', usd: 4100 }, { symbol: 'WETH', usd: 3400 })).toBe('correlated')
    expect(pairKind({ symbol: 'WETH', usd: 3400 }, { symbol: 'USDC', usd: 1 })).toBe('other')
    expect(pairKind({ symbol: 'EURC', usd: 1.16 }, { symbol: 'USDC', usd: 1 })).toBe('other')
    expect(pairKind({ symbol: 'PT-sUSDe-28JAN2027', usd: 0.97 }, { symbol: 'USDT0', usd: 1 }, { pt: true })).toBe('pt')
    expect(pairKind(reserveAsset({ token: { symbol: 'USDT' }, price: 100_000_000n }), reserveAsset({ token: { symbol: 'GHO' }, price: 99_900_000n }))).toBe(
      'stable',
    )
  })

  it('picks wider defaults for pairs that move apart', () => {
    expect(defaultSlippage('stable')).toBe('5')
    expect(defaultSlippage('correlated')).toBe('10')
    expect(defaultSlippage('other')).toBe('30')
    expect(defaultSlippage('pt')).toBe('30')
  })

  it('offers the next step up, none past the widest', () => {
    expect(nextSlippage('1')).toBe('5')
    expect(nextSlippage('30')).toBe('100')
    expect(nextSlippage('100')).toBeUndefined()
  })

  it('recognises a swap that returned less than its minimum', () => {
    expect(isSlippageFailure('Le swap a rendu moins que le minimum : le prix a bougé, recote ou augmente le slippage.')).toBe(true)
    expect(isSlippageFailure('Revert : Return amount is not enough')).toBe(true)
    expect(isSlippageFailure('Refusé dans le portefeuille.')).toBe(false)
    expect(isSlippageFailure(undefined)).toBe(false)
  })

  it('prices the wider minimum', () => {
    expect(extraWorstCaseUsd(10_000, '5', '10')).toBeCloseTo(5)
  })
})
