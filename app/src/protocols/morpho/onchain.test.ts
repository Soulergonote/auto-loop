import { describe, expect, it } from 'vitest'
import { getAddress, zeroAddress } from 'viem'
import { buildOnchainMarkets, logRanges, type OnchainRow } from './onchain'
import { marketId, marketSizeUsd, type MarketParams } from './markets'

const USDC = getAddress('0x29219dd400f2bf60e5a23d13be72b486d4038894')
const WS = getAddress('0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38')
const params: MarketParams = {
  loanToken: USDC,
  collateralToken: WS,
  oracle: getAddress('0x1111111111111111111111111111111111111111'),
  irm: getAddress('0xDEfCf242226425f93d8DD0e314735C28517C473F'),
  lltv: 860000000000000000n,
}
const tokens = new Map([
  [USDC.toLowerCase(), { address: USDC, symbol: 'USDC', decimals: 6 }],
  [WS.toLowerCase(), { address: WS, symbol: 'wS', decimals: 18 }],
])
// wS at 0.30 USDC: loan units per collateral unit x 1e36 = 0.3 x 1e6 / 1e18 x 1e36
const row = (over: Partial<OnchainRow> = {}): OnchainRow => ({
  id: marketId(params),
  params,
  totalSupplyAssets: 200_000n * 10n ** 6n,
  totalBorrowAssets: 150_000n * 10n ** 6n,
  price: 3n * 10n ** 23n,
  borrowRate: 1_585_489_599n, // ~5 % a year
  ...over,
})

describe('logRanges', () => {
  it('one range without a cap, inclusive ranges of `chunk` blocks with one', () => {
    expect(logRanges(10n, 100n, undefined)).toEqual([[10n, 100n]])
    expect(logRanges(0n, 25n, 10n)).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 25n],
    ])
    expect(logRanges(5n, 4n, 10n)).toEqual([])
  })
  it('stops at `max` ranges, oldest first (the rest waits for the next visit)', () => {
    expect(logRanges(0n, 1000n, 10n, 3)).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 29n],
    ])
  })
})

describe('buildOnchainMarkets', () => {
  it('builds a not-listed market from what Morpho, the oracle and the IRM return', () => {
    const [m] = buildOnchainMarkets(146, [row()], tokens, new Map([[`146:${USDC.toLowerCase()}`, 1]]))
    expect(m.source).toBe('chain')
    expect(m.listed).toBe(false)
    expect(m.loan.symbol).toBe('USDC')
    expect(m.lltv).toBeCloseTo(0.86)
    // no DefiLlama price for wS: the oracle's, times USDC's
    expect(m.collateralUsd).toBeCloseTo(0.3)
    expect(m.liquidity).toBe(50_000n * 10n ** 6n)
    expect(m.liquidityUsd).toBeCloseTo(50_000)
    expect(m.borrowUsd).toBeCloseTo(150_000)
    expect(m.utilization).toBeCloseTo(0.75)
    expect(m.borrowApy).toBeCloseTo(0.0513, 3)
    expect(m.collateralTotalUsd).toBe(0)
    // ranked by the least collateral its debt needs
    expect(marketSizeUsd(m)).toBeCloseTo(150_000 / 0.86)
  })
  it('prefers DefiLlama’s collateral price to the oracle’s', () => {
    const usd = new Map([
      [`146:${USDC.toLowerCase()}`, 1],
      [`146:${WS.toLowerCase()}`, 0.31],
    ])
    expect(buildOnchainMarkets(146, [row()], tokens, usd)[0].collateralUsd).toBe(0.31)
  })
  it('drops idle, tampered, unpriced or nearly empty markets', () => {
    const usd = new Map([[`146:${USDC.toLowerCase()}`, 1]])
    const idle = { ...params, collateralToken: zeroAddress, oracle: zeroAddress }
    expect(buildOnchainMarkets(146, [row({ id: marketId(idle), params: idle })], tokens, usd)).toEqual([])
    expect(buildOnchainMarkets(146, [row({ params: { ...params, lltv: 945000000000000000n } })], tokens, usd)).toEqual([])
    expect(buildOnchainMarkets(146, [row({ price: undefined })], tokens, usd)).toEqual([])
    expect(buildOnchainMarkets(146, [row()], tokens, new Map())).toEqual([])
    expect(buildOnchainMarkets(146, [row({ totalSupplyAssets: 5_000n * 10n ** 6n, totalBorrowAssets: 0n })], tokens, usd)).toEqual([])
  })
})
