import { describe, expect, it } from 'vitest'
import morphoFixture from '../test/fixtures/merkl-morpho-2026-11-26.json'
import {
  endingRewards,
  NO_MORPHO_MERKL,
  morphoMerkl,
  morphoMerklApy,
  toMorphoCampaign,
  campaignsForPair,
  campaignYields,
  daysLeft,
  eligibleForPosition,
  parseNetOf,
  rewardsOverHorizon,
  toCampaign,
  v4BonusPage,
} from './merkl'

// Shapes copied from api.merkl.xyz/v4/opportunities (2026-11-01), addresses shortened to test ones.
const A_USDE = '0x00000000000000000000000000000000000000a1'
const D_USDC = '0x00000000000000000000000000000000000000d2'
const USDE = '0x00000000000000000000000000000000000000c1'
const op = (o: Record<string, unknown>) => toCampaign({ action: 'LEND', name: 'x', identifier: '', tokens: [], ...o } as never)

const rewardsOnEquity = (...a: Parameters<typeof campaignYields>) => campaignYields(...a).reduce((s, y) => s + y.apy, 0)

const collateral = { token: { address: USDE, symbol: 'USDe' }, aToken: A_USDE, variableDebtToken: '0x00000000000000000000000000000000000000e1' } as const
const debt = {
  token: { address: '0x00000000000000000000000000000000000000c2', symbol: 'USDC' },
  aToken: '0x00000000000000000000000000000000000000a2',
  variableDebtToken: D_USDC,
} as const

describe('Merkl campaigns', () => {
  it('skips restricted audiences, keeps BORROW_BL as conditional', () => {
    expect(op({ type: 'AAVE_SUPPLY', identifier: A_USDE + 'JUMPER', explorerAddress: A_USDE, apr: 1 })).toBeUndefined()
    expect(op({ type: 'AAVE_SUPPLY', identifier: A_USDE + 'BORROW_BL', explorerAddress: A_USDE, apr: 4 })?.conditional).toBe(true)
    expect(op({ type: 'AAVE_V4_HUB_SUPPLY', identifier: A_USDE, explorerAddress: A_USDE, apr: 3 })).toBeUndefined()
  })

  it('reads the netted assets from the description', () => {
    expect(parseNetOf('Earn rewards on your net lending position (USDS supply minus USDS, USDT, USDC, USDe borrows) on Aave')).toEqual([
      'usds',
      'usdt',
      'usdc',
      'usde',
    ])
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
    const c = op({
      type: 'AAVE_BORROW_FROM_COLLATERAL',
      action: 'BORROW',
      identifier: 'cd34',
      explorerAddress: D_USDC,
      apr: 1,
      tokens: [{ address: '0x00000000000000000000000000000000000000c2' }, { address: '0x00000000000000000000000000000000000000ff' }],
    })!
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
      campaigns: [
        {
          params: {
            hooks: [
              { hookType: 17, healthFactorThreshold: '2' },
              { hookType: 14, borrowBytesLike: [D_USDE] },
            ],
          },
        },
      ],
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

describe('Merkl pages of Morpho and Aave v4 bonuses', () => {
  const pages = [
    {
      url: 'https://app.merkl.xyz/opportunities/1',
      depositUrl: 'https://app.morpho.org/base/market/0xabc/usde-usdc#market',
      type: 'MORPHOBORROW',
      identifier: '',
    },
    { url: 'https://app.merkl.xyz/opportunities/2', depositUrl: 'https://pro.aave.com/explore/asset/1/0xdd', type: 'AAVE_V4_HUB_NET_LENDING', identifier: '' },
    {
      url: 'https://app.merkl.xyz/opportunities/3',
      depositUrl: 'https://pro.aave.com/explore/asset/1/0xdd',
      type: 'AAVE_V4_HUB_NET_BORROWING',
      identifier: '',
    },
    { url: 'https://app.merkl.xyz/opportunities/4', depositUrl: 'https://app.morpho.org/arc/borrow', type: 'MORPHOBORROW_SINGLETOKEN', identifier: '0x36' },
  ]
  it('finds the page by asset and side', () => {
    expect(v4BonusPage(pages, '0xDD', 'supply')).toBe('https://app.merkl.xyz/opportunities/2')
    expect(v4BonusPage(pages, '0xDD', 'borrow')).toBe('https://app.merkl.xyz/opportunities/3')
  })
})

describe('Merkl on Morpho (M7)', () => {
  // real answers of api.merkl.xyz on 2026-11-26 (Ethereum, Base), trimmed to the fields read
  const list = (morphoFixture as unknown as Parameters<typeof toMorphoCampaign>[0][]).map(toMorphoCampaign)
  const usdeRlusd = {
    id: '0xd9d2fc090bdbab1804ea960dd6669b62357787e5816f575f14ca4e6d999614bf',
    collateral: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
    loan: '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD',
  }
  const oethUsdc = {
    id: '0xb8fef900b383db2dbbf4458c7f46acf5b140f26d603a6d1829963f241b82510e',
    collateral: '0x856c4Efb76C1D1AE02e20CEB03A2A6a08b0b8dC3',
    loan: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  }

  it('reads collateral and borrow campaigns, skips supply ones and zero APRs', () => {
    expect(list.filter(Boolean).map((c) => c!.side)).toEqual(['collateral', 'collateral', 'borrow'])
    const c = list[0]!
    expect(c.market).toBe(usdeRlusd.id)
    expect(c.token).toBe(usdeRlusd.collateral.toLowerCase())
    expect(c.apr).toBeCloseTo(0.0475, 10)
    expect(c.endsAt).toBe(1795737600)
    expect(c.merklUrl).toContain('app.merkl.xyz')
  })

  it('counts the collateral campaign of the market only, at L on equity', () => {
    const all = list.filter((c): c is NonNullable<typeof c> => !!c)
    const m = morphoMerkl(all, usdeRlusd)
    expect(m.collateralApr).toBeCloseTo(0.0475, 10)
    expect(m.borrowApr).toBe(0)
    expect(morphoMerklApy(m, 10)).toBeCloseTo(0.475, 10)
    // another USDe market: the campaign names its market
    expect(morphoMerkl(all, { ...usdeRlusd, id: '0x01' })).toEqual(NO_MORPHO_MERKL)
  })

  it('counts borrow campaigns at L - 1 on equity', () => {
    const all = list.filter((c): c is NonNullable<typeof c> => !!c)
    const onchain = morphoMerkl(all, oethUsdc)
    expect(onchain.borrowApr).toBeCloseTo(0.04853865, 6)
    expect(morphoMerklApy(onchain, 5)).toBeCloseTo(0.04853865 * 4, 6)
  })

  it('skips a whitelisted audience, flags hooks, reads a single-token campaign', () => {
    const base = { type: 'MORPHOCOLLATERAL_SINGLETOKEN', action: 'BORROW', name: 'x', identifier: usdeRlusd.collateral, apr: 2 }
    expect(toMorphoCampaign({ ...base, campaigns: [{ params: { whitelist: ['0x1'] } }] })).toBeUndefined()
    const c = toMorphoCampaign({ ...base, campaigns: [{ params: { targetToken: usdeRlusd.collateral, hooks: [{}] } }] })!
    expect(c).toMatchObject({ side: 'collateral', market: undefined, conditional: true, apr: 0.02 })
    expect(morphoMerkl([c], { ...usdeRlusd, id: '0x02' }).collateralApr).toBeCloseTo(0.02, 10)
  })
})

describe('endingRewards (A5)', () => {
  const now = 1_000_000_000_000
  const y = (apy: number, endsAt?: number) => ({ campaign: { endsAt }, apy })
  it('sums the rewards with a known end still to come, gives the first end', () => {
    expect(endingRewards([y(0.1, 1_000_100_000), y(0.05, 1_000_050_000), y(0.02)], now)).toEqual({ apy: 0.15000000000000002, endsAt: 1_000_050_000 })
  })
  it('ignores campaigns already over and gives nothing without a dated one', () => {
    expect(endingRewards([y(0.1, 999_999_000), y(0.02)], now)).toEqual({ apy: 0, endsAt: undefined })
  })
})
