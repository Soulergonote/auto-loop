import { describe, expect, it } from 'vitest'
import { campaignsForPair, parseNetOf, rewardsOnEquity, toCampaign } from './merkl'

// Shapes copied from api.merkl.xyz/v4/opportunities (2026-11-01), addresses shortened to test ones.
const A_USDE = '0x00000000000000000000000000000000000000a1'
const D_USDC = '0x00000000000000000000000000000000000000d2'
const USDE = '0x00000000000000000000000000000000000000c1'
const op = (o: Record<string, unknown>) => toCampaign({ action: 'LEND', name: 'x', identifier: '', tokens: [], ...o } as never)

const collateral = { token: { address: USDE, symbol: 'USDe' }, aToken: A_USDE, variableDebtToken: '0x00000000000000000000000000000000000000e1' } as const
const debt = { token: { address: '0x00000000000000000000000000000000000000c2', symbol: 'USDC' }, aToken: '0x00000000000000000000000000000000000000a2', variableDebtToken: D_USDC } as const

describe('Merkl campaigns', () => {
  it('skips restricted audiences, keeps BORROW_BL as conditional', () => {
    expect(op({ type: 'AAVE_SUPPLY', identifier: A_USDE + 'JUMPER', explorerAddress: A_USDE, apr: 1 })).toBeUndefined()
    expect(op({ type: 'AAVE_SUPPLY', identifier: A_USDE + 'BORROW_BL', explorerAddress: A_USDE, apr: 4 })?.conditional).toBe(true)
    expect(op({ type: 'AAVE_V4_HUB_SUPPLY', identifier: A_USDE, explorerAddress: A_USDE, apr: 3 })).toBeUndefined()
  })

  it('reads the netted assets from the description', () => {
    expect(parseNetOf('Earn rewards on your net lending position (USDS supply minus USDS, USDT, USDC, USDe borrows) on Aave')).toEqual(['usds', 'usdt', 'usdc', 'usde'])
    expect(parseNetOf('Earn rewards on your net borrowing position (USDC borrow minus USDC, RLUSD supplies) on Aave')).toEqual(['usdc', 'rlusd'])
  })

  it('scales supply rewards by leverage, net lending only on what the loop does not borrow back', () => {
    const all = [
      op({ type: 'AAVE_SUPPLY', identifier: A_USDE, explorerAddress: A_USDE, apr: 4 })!,
      op({ type: 'AAVE_NET_LENDING', identifier: 'ab12', explorerAddress: A_USDE, apr: 2, description: '(USDe supply minus USDe, USDC borrows)' })!,
      op({ type: 'AAVE_BORROW', action: 'BORROW', identifier: D_USDC, explorerAddress: D_USDC, apr: 1 })!,
    ]
    const pair = campaignsForPair(all, collateral, debt)
    expect(pair.supply).toHaveLength(2)
    expect(pair.borrow).toHaveLength(1)
    // 5x: supply 5, borrow 4 (x equity) -> 4 % x 5 + 2 % x (5 - 4) + 1 % x 4
    expect(rewardsOnEquity(pair, 5, 'USDe', 'USDC')).toBeCloseTo(0.2 + 0.02 + 0.04)
  })

  it('counts borrow-from-collateral campaigns only with the right collateral', () => {
    const c = op({ type: 'AAVE_BORROW_FROM_COLLATERAL', action: 'BORROW', identifier: 'cd34', explorerAddress: D_USDC, apr: 1, tokens: [{ address: '0x00000000000000000000000000000000000000c2' }, { address: '0x00000000000000000000000000000000000000ff' }] })!
    expect(campaignsForPair([c], collateral, debt).borrow).toHaveLength(0)
  })
})
