import { describe, expect, it } from 'vitest'
import { campaignYields, campaignsForPair, toCampaign } from './merkl'
import { merklBalances, summarizePosition, type Holding } from './positions'
import { USD, reserve } from './testReserves'
import type { SnapReserve } from './snapshot'

const usde = reserve(0, 'USDe', { supplyApy: 0.03 })
const usdc = reserve(1, 'USDC', { borrowApy: 0.05 })
const op = (o: Record<string, unknown>) => toCampaign({ action: 'LEND', name: 'x', identifier: '', tokens: [], ...o } as never)!

const hold = (r: SnapReserve, suppliedUsd: number, borrowedUsd: number): Holding => ({
  reserve: r,
  supplied: 0n,
  borrowed: 0n,
  suppliedBase: BigInt(suppliedUsd) * USD,
  borrowedBase: BigInt(borrowedUsd) * USD,
})

describe('positions', () => {
  // a 5x USDe / USDC loop on 1 000 $ of equity
  const loop = [hold(usde, 5000, 0), hold(usdc, 0, 4000)]
  const campaigns = [
    op({ type: 'AAVE_SUPPLY', identifier: usde.aToken, explorerAddress: usde.aToken, apr: 4 }),
    op({ type: 'AAVE_NET_LENDING', identifier: 'ab', explorerAddress: usde.aToken, apr: 2, description: '(USDe supply minus USDe, USDC borrows)' }),
    op({ type: 'AAVE_BORROW', action: 'BORROW', identifier: usdc.variableDebtToken, explorerAddress: usdc.variableDebtToken, apr: 1 }),
  ]

  it('gives the same yield as the loop view on a simple loop', () => {
    const s = summarizePosition(loop, campaigns, 1.1)
    expect(s.equityBase).toBe(1000n * USD)
    expect(s.leverage).toBeCloseTo(5)
    expect(s.ratesApy).toBeCloseTo(0.03 * 5 - 0.05 * 4)
    const expected = campaignYields(campaignsForPair(campaigns, usde, usdc), 5, usde, usdc).reduce((t, y) => t + y.apy, 0)
    expect(s.rewardsApy).toBeCloseTo(expected)
    expect(s.nativeApy).toBe(0)
    expect(s.apy).toBeCloseTo(s.ratesApy + s.rewardsApy)
  })

  it('adds the intrinsic yield of a yield-bearing collateral, and charges it on a yield-bearing debt', () => {
    const susde = reserve(2, 'sUSDe', { supplyApy: 0, native: { apy: 0.05, source: 'aave', since: 0 } })
    expect(summarizePosition([hold(susde, 5000, 0), hold(usdc, 0, 4000)], [], 1.1).nativeApy).toBeCloseTo(0.25)
    const s = summarizePosition([hold(usde, 5000, 0), hold(susde, 0, 4000)], [], 1.1)
    expect(s.nativeApy).toBeCloseTo(-0.2)
    expect(s.apy).toBeCloseTo(s.ratesApy - 0.2)
  })

  it('counts nothing for a campaign whose rules the position breaks, and says why', () => {
    const ethena = op({
      type: 'AAVE_SUPPLY',
      identifier: usde.aToken + 'BORROW_BL',
      explorerAddress: usde.aToken,
      apr: 5,
      campaigns: [{ params: { hooks: [{ healthFactorThreshold: '2', borrowBytesLike: [usde.variableDebtToken] }] } }],
    })
    const [c] = summarizePosition(loop, [ethena], 2.5).campaigns
    expect(c.apy).toBe(0)
    expect(c.reasons[0]).toMatch(/au-dessus du maximum 2/)
    expect(summarizePosition(loop, [ethena], 1.5).rewardsApy).toBeCloseTo(0.05 * 5)
  })

  it('explains a net campaign the loop cancels out (GHO supplied against GHO-netted debt)', () => {
    const net = op({
      type: 'AAVE_NET_LENDING',
      identifier: 'cd',
      explorerAddress: usde.aToken,
      apr: 6,
      campaigns: [{ params: { borrowTokens: [usdc.variableDebtToken] } }],
    })
    const [c] = summarizePosition([hold(usde, 5000, 0), hold(usdc, 0, 5000)], [net], 1.05).campaigns
    expect(c.apy).toBe(0)
    expect(c.reasons[0]).toMatch(/compense/)
  })

  it('reads claimable and pending Merkl rewards', () => {
    const b = merklBalances([
      {
        chain: { id: 1 },
        rewards: [
          {
            amount: '3000000000000000000',
            claimed: '1000000000000000000',
            pending: '500000000000000000',
            token: { address: '0x1', symbol: 'USDe', decimals: 18, price: 1 },
          },
          { amount: '5', claimed: '5', pending: '0', token: { address: '0x2', symbol: 'X', decimals: 0 } },
          // a few millionths of a dollar left: not a line
          { amount: '3', claimed: '0', pending: '0', token: { address: '0x3', symbol: 'USDC', decimals: 6, price: 1 } },
        ],
      },
    ])
    expect(b).toEqual([{ address: '0x1', symbol: 'USDe', claimable: 2, pending: 0.5, usd: 2.5 }])
  })
})
