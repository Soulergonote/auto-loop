import { describe, expect, it } from 'vitest'
import { parseV4Reserves } from './reserves'

const v = (x: number | string) => ({ value: String(x) })

// Ethereum Core hub USDC as the API gave it on 2026-11-28: 95.6 M borrowed, 16.9 M left, 5.21 % borrow APY
const raw = (borrowApy: number) => ({
  onChainId: 3,
  chain: { chainId: 1, name: 'Ethereum' },
  spoke: { name: 'Main', address: '0x0000000000000000000000000000000000000001' as const },
  status: { frozen: false, paused: false, active: true },
  canBorrow: true,
  canSupply: true,
  canUseAsCollateral: false,
  asset: {
    hub: { name: 'Core' },
    underlying: { address: '0x0000000000000000000000000000000000000002' as const, info: { symbol: 'USDC', decimals: 6 } },
    summary: { borrowed: { exchange: v(95_627_255) }, availableLiquidity: { exchange: v(16_850_636) }, borrowApy: v(borrowApy) },
    settings: { liquidityFee: v(0.1), optimalUtilizationRate: v(0.92), baseBorrowRate: v(0), slopeBelowOptimal: v(0.055), slopeAboveOptimal: v(0.2) },
  },
  summary: {
    supplyApy: v(0.0397),
    borrowApy: v(borrowApy),
    underlyingApy: v(0),
    borrowable: { exchange: v(16_850_636), exchangeRate: v(1) },
    suppliable: { exchange: v(1e9) },
    rewards: [],
  },
  settings: { collateralFactor: v(0), collateralRisk: v(0) },
})

describe('v4 hub curve', () => {
  it('is kept when it gives back the hub rate, in USD', () => {
    const [r] = parseV4Reserves([raw(0.0521)])
    expect(r.curve).toEqual({
      kind: 'aave',
      irm: { optimal: 0.92, base: 0, slope1: 0.055, slope2: 0.2, reserveFactor: 0.1 },
      cash: 16_850_636,
      debt: 95_627_255,
    })
  })

  it('is dropped when it does not', () => {
    expect(parseV4Reserves([raw(0.09)])[0].curve).toBeUndefined()
  })
})
