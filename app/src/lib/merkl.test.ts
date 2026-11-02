import { describe, expect, it } from 'vitest'
import { campaignsForPair, campaignYields, daysLeft, eligibleForPosition, parseNetOf, rewardsOnEquity, rewardsOverHorizon, toCampaign } from './merkl'

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
    expect(rewardsOnEquity(pair, 5, collateral, debt)).toBeCloseTo(0.2 + 0.02 + 0.04)
  })

  it('counts borrow-from-collateral campaigns only with the right collateral', () => {
    const c = op({ type: 'AAVE_BORROW_FROM_COLLATERAL', action: 'BORROW', identifier: 'cd34', explorerAddress: D_USDC, apr: 1, tokens: [{ address: '0x00000000000000000000000000000000000000c2' }, { address: '0x00000000000000000000000000000000000000ff' }] })!
    expect(campaignsForPair([c], collateral, debt).borrow).toHaveLength(0)
  })

  it('uses the exact netted tokens from the campaign parameters', () => {
    const other = '0x00000000000000000000000000000000000000d9'
    const base = { type: 'AAVE_NET_LENDING', identifier: 'ab12', explorerAddress: A_USDE, apr: 2, description: '(USDe supply minus USDe, USDC borrows)' }
    // the parameters only net another debt token: the loop's USDC borrow does not reduce the reward
    const c = op({ ...base, campaigns: [{ params: { hooks: [], borrowTokens: [other] } }] })!
    expect(c.netOfTokens).toEqual([other])
    expect(rewardsOnEquity(campaignsForPair([c], collateral, debt), 5, collateral, debt)).toBeCloseTo(0.1)
    const netted = op({ ...base, campaigns: [{ params: { borrowTokens: [D_USDC] } }] })!
    expect(rewardsOnEquity(campaignsForPair([netted], collateral, debt), 5, collateral, debt)).toBeCloseTo(0.02)
  })

  it('reads and checks Ethena-style conditions (health factor at most 2, USDe never borrowed)', () => {
    const D_USDE = '0x00000000000000000000000000000000000000e1'
    const c = op({
      type: 'AAVE_SUPPLY',
      identifier: A_USDE + 'BORROW_BL',
      explorerAddress: A_USDE,
      apr: 4.93,
      latestCampaignEnd: '1793923200',
      campaigns: [{ params: { hooks: [{ hookType: 17, healthFactorThreshold: '2' }, { hookType: 14, borrowBytesLike: [D_USDE] }] } }],
    })!
    expect(c.maxHealthFactor).toBe(2)
    expect(c.forbiddenBorrows).toEqual([D_USDE])
    expect(c.conditional).toBe(false) // every rule was read, the app checks them
    expect(c.endsAt).toBe(1793923200)
    const pair = campaignsForPair([c], collateral, debt)
    expect(eligibleForPosition(pair, { healthFactor: 1.1, debtToken: D_USDC }).excluded).toHaveLength(0)
    expect(eligibleForPosition(pair, { healthFactor: 2.5, debtToken: D_USDC }).excluded[0].reasons[0]).toMatch(/maximum 2/)
    expect(eligibleForPosition(pair, { healthFactor: 1.1, debtToken: D_USDE }).pair.supply).toHaveLength(0)
  })

  it('counts each campaign only until its end over the horizon', () => {
    const now = 1_000_000 * 1000
    const c = op({ type: 'AAVE_SUPPLY', identifier: A_USDE, explorerAddress: A_USDE, apr: 10, latestCampaignEnd: 1_000_000 + 9 * 86_400 })!
    expect(daysLeft(c, now)).toBeCloseTo(9)
    const y = campaignYields(campaignsForPair([c], collateral, debt), 2, collateral, debt)
    // 20 % on equity at 2x, paid 9 days out of 90
    expect(rewardsOverHorizon(y, 90, now)).toBeCloseTo(0.02)
  })
})
