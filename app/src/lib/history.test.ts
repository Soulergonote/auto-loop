import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, zeroAddress, type Address, type Hex } from 'viem'
import { aaveFlows, aTokenFlows, historyLines, morphoFlows, positionGain, priceKey, txsToInspect, type Flow } from './history'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const A_WETH = '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8' as Address
const USER = '0x1111111111111111111111111111111111111111' as Address
const EXEC = '0x2222222222222222222222222222222222222222' as Address
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const leg = (address: string, symbol: string, value: string) => ({ amount: { amount: { value } }, reserve: { underlyingToken: { address, symbol } } })
const flow = (n: number, time: number, kind: Flow['kind'], token: Address, amount: number): Flow => ({ tx: tx(n), time, kind, token, symbol: '', amount })

describe('history flows', () => {
  it('reads the Aave API items, liquidations in two legs', () => {
    const flows = aaveFlows([
      { __typename: 'UserSupplyTransaction', txHash: tx(1), timestamp: '2026-01-01T00:00:00Z', ...leg(WETH.toLowerCase(), 'WETH', '3') },
      { __typename: 'UserBorrowTransaction', txHash: tx(1), timestamp: '2026-01-01T00:00:00Z', ...leg(USDC, 'USDC', '6000') },
      {
        __typename: 'UserLiquidationCallTransaction',
        txHash: tx(2),
        timestamp: '2026-02-01T00:00:00Z',
        collateral: leg(WETH, 'WETH', '0.5'),
        debtRepaid: leg(USDC, 'USDC', '900'),
      },
      { __typename: 'UserUsageAsCollateralTransaction', txHash: tx(3), timestamp: '2026-02-01T00:00:00Z' },
    ] as never)
    expect(flows.map((f) => [f.kind, f.symbol, f.amount])).toEqual([
      ['supply', 'WETH', 3],
      ['borrow', 'USDC', 6000],
      ['seized', 'WETH', 0.5],
      ['liquidationRepay', 'USDC', 900],
    ])
    expect(flows[0].token).toBe(WETH)
    expect(flows[0].time).toBe(Date.parse('2026-01-01T00:00:00Z') / 1000)
  })

  it('keeps the borrower side of Morpho, not the lender side', () => {
    const coll = { address: WETH, symbol: 'WETH', decimals: 18 }
    const loan = { address: USDC, symbol: 'USDC', decimals: 6 }
    const flows = morphoFlows(
      [
        { txHash: tx(1), timestamp: 100, type: 'SupplyCollateral', data: { assets: '2000000000000000000' } },
        { txHash: tx(1), timestamp: 100, type: 'Borrow', data: { assets: '3000000000' } },
        { txHash: tx(2), timestamp: 200, type: 'MarketSupply', data: { assets: '5' } },
        { txHash: tx(3), timestamp: 300, type: 'Liquidation', data: { seizedAssets: '100000000000000000', repaidAssets: '200000000' } },
      ],
      coll,
      loan,
    )
    expect(flows.map((f) => [f.kind, f.amount])).toEqual([
      ['supply', 2],
      ['borrow', 3000],
      ['seized', 0.1],
      ['liquidationRepay', 200],
    ])
  })

  it('finds the aTokens a contract moved, not the mints and burns', () => {
    const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
    const log = (address: Address, from: Address, to: Address, value: bigint) => ({
      address,
      topics: encodeEventTopics({ abi: [transfer], args: { from, to } }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    })
    const aTokens = new Map([[A_WETH.toLowerCase(), { token: WETH, symbol: 'WETH', decimals: 18 }]])
    const flows = aTokenFlows(
      [
        log(A_WETH, USER, EXEC, 3n * 10n ** 18n),
        log(A_WETH, EXEC, zeroAddress, 3n * 10n ** 18n),
        log(A_WETH, zeroAddress, USER, 10n ** 18n),
        log(USDC, USER, EXEC, 5n),
      ],
      USER,
      aTokens,
      tx(9),
      500,
    )
    expect(flows).toEqual([{ tx: tx(9), time: 500, kind: 'withdraw', token: WETH, symbol: 'WETH', amount: 3 }])
  })

  it('inspects the receipts of repayments and of deposits without a borrow only', () => {
    const flows = [flow(1, 1, 'supply', WETH, 3), flow(1, 1, 'borrow', USDC, 1), flow(2, 2, 'repay', USDC, 1), flow(3, 3, 'supply', WETH, 1)]
    expect(txsToInspect(flows)).toEqual([tx(2), tx(3)])
  })
})

describe('positionGain', () => {
  const DAY = 86_400
  it('values each flow at its day and annualises the gain', () => {
    // opened 3 WETH at 2000 $ with 4000 USDC borrowed: 2000 $ put in; a year later worth 2200 $
    const flows = [flow(1, 0, 'supply', WETH, 3), flow(1, 0, 'borrow', USDC, 4000)]
    const prices = new Map([
      [priceKey(WETH, 0), 2000],
      [priceKey(USDC, 0), 1],
    ])
    const now = new Map([
      [WETH.toLowerCase(), 3000],
      [USDC.toLowerCase(), 1],
    ])
    const g = positionGain(flows, prices, now, 2200, 365 * DAY, USDC)!
    expect(g.netInUsd).toBeCloseTo(2000)
    expect(g.gainUsd).toBeCloseTo(200)
    expect(g.gainInRef).toBeCloseTo(200)
    expect(g.apy).toBeCloseTo(0.1)
    expect(g.approximated).toBe(0)
    expect(g.since).toBe(0)
  })

  it('weighs a late deposit for the time it was in, and falls back on today prices', () => {
    const flows = [flow(1, 0, 'supply', USDC, 1000), flow(2, 182.5 * DAY, 'supply', USDC, 1000)]
    const now = new Map([[USDC.toLowerCase(), 1]])
    const g = positionGain(flows, new Map(), now, 2150, 365 * DAY)!
    expect(g.approximated).toBe(2)
    expect(g.gainUsd).toBeCloseTo(150)
    // 150 on an average 1500 of capital
    expect(g.apy).toBeCloseTo(0.1)
    expect(g.gainInRef).toBeUndefined()
  })

  it('gives no rate under a day and nothing without flows', () => {
    const now = new Map([[USDC.toLowerCase(), 1]])
    expect(positionGain([flow(1, 0, 'supply', USDC, 1000)], new Map(), now, 1001, 3600)!.apy).toBeUndefined()
    expect(positionGain([], new Map(), now, 0, 0)).toBeUndefined()
  })

  it('counts a closed position at zero worth', () => {
    const flows = [flow(1, 0, 'supply', USDC, 1000), flow(2, 30 * DAY, 'withdraw', USDC, 1010)]
    const g = positionGain(flows, new Map(), new Map([[USDC.toLowerCase(), 1]]), 0, 30 * DAY)!
    expect(g.gainUsd).toBeCloseTo(10)
  })
})

describe('historyLines', () => {
  it('names each transaction by what it did, newest first', () => {
    const lines = historyLines([
      flow(1, 1, 'supply', WETH, 3),
      flow(1, 1, 'borrow', USDC, 4000),
      flow(2, 2, 'repay', USDC, 4000),
      flow(2, 2, 'withdraw', WETH, 3),
      flow(3, 3, 'seized', WETH, 1),
      flow(4, 4, 'supply', WETH, 1),
      flow(4, 4, 'withdraw', USDC, 1),
    ])
    expect(lines.map((l) => l.label)).toEqual(['Changement de collatéral', 'Liquidation', 'Fermeture ou réduction', 'Ouverture ou hausse du levier'])
    expect(lines[3].parts).toHaveLength(2)
  })
})
