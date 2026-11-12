import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, maxUint256, toFunctionSelector } from 'viem'
import { executorAbi } from '../../chain/abi'
import {
  buyPtCalldata,
  fixedApy,
  hfAtMaturity,
  impliedApyFromLn,
  isExpired,
  mintableTokensIn,
  pendleCalldataProblem,
  pendleRouterAbi,
  pendleTerms,
  redeemPtCalldata,
  sellPtCalldata,
} from './pt'
import { quoteLabel, quoteSteps, type Quote, type RouteLeg } from '../../services/quotes/quotes'
import { closeCall, openCall, openArgsV1, type ClosePlan, type OpenPlan } from '../aave/execute'

const a = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const EXECUTOR = a(0xe1),
  MARKET = a(0x3001),
  YT = a(0x3002),
  PT = a(0x3003),
  REUSDE = a(0xc1),
  USDC = a(0xd0),
  KYBER = a(0x7001),
  PENDLE = getAddress('0x888888888889758F76e7103c6CbF23ABbF58F946')
const tok = (address: `0x${string}`, symbol: string, decimals = 18) => ({ address, symbol, name: symbol, decimals })

describe('Pendle yields', () => {
  it('reads the implied APY from ln(1 + APY)', () => {
    // 18.09 % read on the reUSDe market (lastLnImpliedRate 166274624217317088), 2026-11-08
    expect(impliedApyFromLn(166274624217317088n)).toBeCloseTo(0.1809, 4)
    expect(impliedApyFromLn(0n)).toBe(0)
  })

  it('annualises the discount paid to maturity', () => {
    // 1.02 PT for 1 asset, half a year left: 1.02^2 - 1
    expect(fixedApy(102n * 10n ** 16n, 10n ** 18n, (365 * 86_400) / 2)).toBeCloseTo(0.0404, 4)
    expect(fixedApy(10n ** 18n, 10n ** 18n, 86_400)).toBeCloseTo(0, 9)
    expect(fixedApy(10n ** 18n, 10n ** 18n, 0)).toBeUndefined()
    expect(fixedApy(0n, 10n ** 18n, 86_400)).toBeUndefined()
  })

  it('projects the health factor to maturity', () => {
    // price climbs 15 % x 73 d / 365 = 3 % to 1, debt grows 5 % a year for 73 days
    expect(hfAtMaturity(1.05, 0.15, 0.05, 73)).toBeCloseTo(1.05 / 0.97 / Math.pow(1.05, 0.2), 6)
    // borrowing dearer than the discount: the health factor still rises, only less
    expect(hfAtMaturity(1.05, 0.05, 0.08, 73)).toBeLessThan(hfAtMaturity(1.05, 0.05, 0.02, 73))
    expect(hfAtMaturity(Infinity, 0.15, 0.05, 73)).toBe(Infinity)
    expect(hfAtMaturity(1.05, 0.15, 0.05, -2)).toBe(1.05)
  })

  it('treats a PT as expired from its maturity or when the chain says so', () => {
    expect(isExpired({ expiry: 1000, expired: false }, 999)).toBe(false)
    expect(isExpired({ expiry: 1000, expired: false }, 1000)).toBe(true)
    expect(isExpired({ expiry: 2000, expired: true }, 999)).toBe(true)
  })
})

describe('Pendle router calldata', () => {
  it('uses the selectors of Pendle RouterV4 (checked on an Ethereum fork, 2026-11-08)', () => {
    const sel = Object.fromEntries(pendleRouterAbi.map((f) => [f.name, toFunctionSelector(f)]))
    expect(sel).toEqual({ swapExactTokenForPt: '0xc81f847a', swapExactPtForToken: '0x594a88cc', redeemPyToToken: '0x47f1de22' })
  })

  it('decodes what it builds', () => {
    const buy = buyPtCalldata({ receiver: EXECUTOR, market: MARKET, tokenIn: REUSDE, amountIn: 1000n, minPtOut: 1400n, ptOut: 1410n })
    expect(pendleTerms(buy)).toEqual({ kind: 'buy', receiver: EXECUTOR, target: MARKET, tokenIn: REUSDE, amountIn: 1000n, minOut: 1400n, external: false })
    const { args } = decodeFunctionData({ abi: pendleRouterAbi, data: buy })
    const guess = args[3] as { guessMin: bigint; guessMax: bigint; guessOffchain: bigint }
    expect([guess.guessMin, guess.guessOffchain, guess.guessMax]).toEqual([1400n, 1410n, 1480n])
    const sell = sellPtCalldata({ receiver: EXECUTOR, market: MARKET, ptIn: 1400n, tokenOut: REUSDE, minOut: 990n })
    expect(pendleTerms(sell)).toMatchObject({ kind: 'sell', target: MARKET, tokenOut: REUSDE, amountIn: 1400n, minOut: 990n, external: false })
    const redeem = redeemPtCalldata({ receiver: EXECUTOR, yt: YT, ptIn: 1400n, tokenOut: REUSDE, minOut: 970n })
    expect(pendleTerms(redeem)).toMatchObject({ kind: 'redeem', target: YT, tokenOut: REUSDE, amountIn: 1400n, minOut: 970n })
    expect(pendleTerms('0xdeadbeef')).toBeUndefined()
  })

  it('refuses a calldata that does something else than the quote', () => {
    const data = sellPtCalldata({ receiver: EXECUTOR, market: MARKET, ptIn: 1400n, tokenOut: REUSDE, minOut: 990n })
    const ok = { kind: 'sell' as const, receiver: EXECUTOR, target: MARKET, token: REUSDE, amountIn: 1400n, minOut: 990n }
    expect(pendleCalldataProblem(data, ok)).toBeUndefined()
    expect(pendleCalldataProblem(data, { ...ok, receiver: a(0x66) })).toMatch(/autre adresse/)
    expect(pendleCalldataProblem(data, { ...ok, target: a(0x66) })).toMatch(/marché/)
    expect(pendleCalldataProblem(data, { ...ok, token: USDC })).toMatch(/token/)
    expect(pendleCalldataProblem(data, { ...ok, amountIn: 1401n })).toMatch(/montant/)
    expect(pendleCalldataProblem(data, { ...ok, minOut: 991n })).toMatch(/minimum/)
    expect(pendleCalldataProblem(data, { ...ok, kind: 'buy' })).toMatch(/inattendu/)
  })
})

describe('routes through Pendle', () => {
  const legs: RouteLeg[] = [
    { via: 'kyber', router: KYBER, sell: tok(USDC, 'USDC', 6), buy: tok(REUSDE, 'reUSDe'), sellAmount: 4000n, buyAmount: 2759n, minOut: 2756n, data: '0x01' },
    { via: 'pendle', router: PENDLE, sell: tok(REUSDE, 'reUSDe'), buy: tok(PT, 'PT'), sellAmount: 2756n, buyAmount: 4031n, minOut: 4027n, data: '0x02' },
  ]
  const route: Quote = {
    aggregator: 'kyber',
    router: PENDLE,
    data: '0x02',
    sellAmount: 4000n,
    buyAmount: 4031n,
    minOut: 4027n,
    simulated: false,
    fetchedAt: 0,
    route: legs,
  }

  it('gives one contract step per leg, ending in the right token', () => {
    expect(quoteSteps(route, PT)).toEqual([
      { router: KYBER, tokenOut: REUSDE, data: '0x01', minOut: 2756n },
      { router: PENDLE, tokenOut: PT, data: '0x02', minOut: 4027n },
    ])
    expect(() => quoteSteps(route, USDC)).toThrow(/bon token/)
    const single: Quote = { ...route, route: undefined, router: KYBER, data: '0x03', minOut: 9n }
    expect(quoteSteps(single, PT)).toEqual([{ router: KYBER, tokenOut: PT, data: '0x03', minOut: 9n }])
    expect(quoteLabel(route)).toBe('KyberSwap + Pendle')
  })

  it('puts every leg in the open and close calls, and keeps routes off v1 executors', () => {
    const open = openCall({ version: 2, collateral: PT, debt: USDC, initialCollateral: 1000n, capitalToken: USDC, debtAmount: 3000n, quote: route } as OpenPlan)
    const [p] = open.args as [{ steps: { router: string }[]; capitalSteps: unknown[] }]
    expect(p.steps.map((s) => s.router)).toEqual([KYBER, PENDLE])
    expect(p.capitalSteps).toEqual([])
    expect(() => openArgsV1({ quote: route } as OpenPlan)).toThrow(/v1/)
    const back: Quote = {
      ...route,
      sellAmount: 4031n,
      route: [
        { ...legs[1], sell: tok(PT, 'PT'), buy: tok(REUSDE, 'reUSDe') },
        { ...legs[0], sell: tok(REUSDE, 'reUSDe'), buy: tok(USDC, 'USDC', 6) },
      ],
    }
    const close = closeCall({
      version: 2,
      flashLender: a(0x8001),
      collateral: PT,
      debt: USDC,
      full: true,
      repayAmount: 0n,
      collateralToWithdraw: 0n,
      collateralToSell: 4031n,
      quote: back,
    } as unknown as ClosePlan)
    const [c] = close.args as [{ steps: { tokenOut: string }[]; repayAmount: bigint }]
    expect(c.steps.map((s) => s.tokenOut)).toEqual([REUSDE, USDC])
    expect(c.repayAmount).toBe(maxUint256)
    expect(executorAbi.some((f) => f.type === 'function' && f.name === 'close')).toBe(true)
  })
})

describe('mintableTokensIn', () => {
  const USDC = { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), symbol: 'USDC', name: 'USDC', decimals: 6 }
  const USD3 = { address: getAddress('0x056B269Eb1f75477a8666ae8C7fE01b64dD55eCc'), symbol: 'USD3', name: 'USD3', decimals: 6 }
  const room = (max?: bigint) => ({ yieldToken: USD3.address, asset: USDC.address, max })

  it('keeps every token when the vault has room or does not say', () => {
    expect(mintableTokensIn([USDC, USD3], room(10_000n), USDC.address, 5_000n)).toEqual([USDC, USD3])
    expect(mintableTokensIn([USDC, USD3], room(undefined), USDC.address, 5_000n)).toEqual([USDC, USD3])
    expect(mintableTokensIn([USDC, USD3], undefined, USDC.address, 5_000n)).toEqual([USDC, USD3])
  })

  it('buys through the yield token when the vault is full or too small for the amount', () => {
    expect(mintableTokensIn([USDC, USD3], room(0n), USDC.address, 5_000n)).toEqual([USD3])
    expect(mintableTokensIn([USDC, USD3], room(4_999n), USDC.address, 5_000n)).toEqual([USD3])
    // another token held: USDC still offered while the vault takes anything
    expect(mintableTokensIn([USDC, USD3], room(1n), USD3.address, 5_000n)).toEqual([USDC, USD3])
  })
})
