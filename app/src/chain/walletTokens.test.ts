import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress } from 'viem'
import { erc20Abi, executorAbi } from './abi'
import { capitalKind, walletTokens, type WalletToken } from './walletTokens'
import { openArgs, openCall, type OpenPlan } from '../protocols/aave/execute'
import { openBatchCalls } from '../protocols/aave/batch'
import type { Quote } from '../services/quotes/quotes'
import { pairPosition, positionLeverage } from '../domain/math'

const a = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const USER = a(0x11),
  EXECUTOR = a(0xe1),
  WETH = a(0xc0),
  USDC = a(0xd0),
  WSTETH = a(0xc1),
  VDEBT = a(0xd1),
  POOL = a(0x9001),
  ROUTER = a(0x7001),
  ROUTER2 = a(0x7002)
const quote = (sellAmount: bigint, over: Partial<Quote> = {}): Quote => ({
  aggregator: 'velora',
  router: ROUTER,
  data: '0xdeadbeef',
  sellAmount,
  buyAmount: 10n,
  minOut: 9n,
  simulated: false,
  fetchedAt: 0,
  ...over,
})
const plan = (over: Partial<OpenPlan> = {}): OpenPlan => ({
  chainId: 8453,
  executor: EXECUTOR,
  user: USER,
  collateral: WETH,
  debt: USDC,
  variableDebtToken: VDEBT,
  initialCollateral: 10n ** 18n,
  debtAmount: 2_000_000_000n,
  quote: quote(2_000_000_000n),
  collateralAllowance: 0n,
  borrowAllowance: 0n,
  pool: POOL,
  ...over,
})

describe('capitalKind', () => {
  it('tells the three cases apart, whatever the address case', () => {
    expect(capitalKind(WETH, WETH, USDC)).toBe('collateral')
    expect(capitalKind(USDC.toLowerCase() as never, WETH, USDC)).toBe('debt')
    expect(capitalKind(WSTETH, WETH, USDC)).toBe('swap')
  })
})

describe('open with the capital in another token (v2)', () => {
  it('collateral as capital: no capital step, as before', () => {
    const args = openArgs(plan())
    expect(args.capitalToken).toBe(WETH)
    expect(args.capitalSteps).toEqual([])
    expect(args.steps[0].tokenOut).toBe(WETH)
  })

  it('debt asset as capital: no capital step, the swap sells the debt plus the capital', () => {
    const p = plan({ capitalToken: USDC, initialCollateral: 1_000_000_000n, quote: quote(3_000_000_000n) })
    const args = openArgs(p)
    expect(args.capitalToken).toBe(USDC)
    expect(args.capitalAmount).toBe(1_000_000_000n)
    expect(args.capitalSteps).toEqual([])
    expect(args.debtAmount).toBe(2_000_000_000n)
    // a quote for the debt alone would leave the capital unsold
    expect(() => openArgs({ ...p, quote: quote(2_000_000_000n) })).toThrow(/autre montant/)
  })

  it('another token: one capital step to the collateral with the quote minimum', () => {
    const cq = quote(5n * 10n ** 17n, { router: ROUTER2, data: '0xcafe', minOut: 4n * 10n ** 17n })
    const args = openArgs(plan({ capitalToken: WSTETH, initialCollateral: 5n * 10n ** 17n, capitalQuote: cq }))
    expect(args.capitalToken).toBe(WSTETH)
    expect(args.capitalSteps).toEqual([{ router: ROUTER2, tokenOut: WETH, data: '0xcafe', minOut: 4n * 10n ** 17n }])
    expect(args.steps).toHaveLength(1)
  })

  it('another token needs its quote, for the exact capital', () => {
    expect(() => openArgs(plan({ capitalToken: WSTETH }))).toThrow(/capital manquant/)
    expect(() => openArgs(plan({ capitalToken: WSTETH, capitalQuote: quote(1n) }))).toThrow(/capital pour un autre montant/)
  })

  it('a v1 contract refuses any capital but the collateral', () => {
    expect(() => openCall(plan({ version: 1, capitalToken: USDC }))).toThrow(/v1/)
    expect(openCall(plan({ version: 1 })).functionName).toBe('open')
  })

  it('the batch approves the capital token, exactly, and puts its allowance back', () => {
    const cq = quote(5n * 10n ** 17n, { router: ROUTER2 })
    const calls = openBatchCalls(plan({ capitalToken: WSTETH, initialCollateral: 5n * 10n ** 17n, capitalQuote: cq }), { collateral: 0n, borrow: 0n })
    const approvals = calls.filter((c) => c.to === WSTETH).map((c) => decodeFunctionData({ abi: erc20Abi, data: c.data }))
    expect(approvals.map((d) => d.args)).toEqual([
      [EXECUTOR, 5n * 10n ** 17n],
      [EXECUTOR, 0n],
    ])
    expect(calls.some((c) => c.to === WETH)).toBe(false)
    const open = decodeFunctionData({ abi: executorAbi, data: calls.find((c) => c.to === EXECUTOR)!.data })
    expect((open.args[0] as { capitalToken: string }).capitalToken).toBe(WSTETH)
  })

  it('a simulated capital quote is never sent', () => {
    const cq = quote(5n * 10n ** 17n, { simulated: true })
    expect(() => openBatchCalls(plan({ capitalToken: WSTETH, initialCollateral: 5n * 10n ** 17n, capitalQuote: cq }), { collateral: 0n, borrow: 0n })).toThrow(
      /simulé/,
    )
  })
})

describe('walletTokens', () => {
  const t = (address: `0x${string}`, symbol: string, balance: bigint, price = 1n): WalletToken => ({
    token: { address, symbol, name: symbol, decimals: 18 },
    side: { price, decimals: 18 },
    balance,
    allowance: 0n,
  })
  it('lists the pair first, then the other tokens held, by symbol', () => {
    const list = walletTokens(
      [t(a(5), 'cbBTC', 1n), t(USDC, 'USDC', 0n), t(a(6), 'AAVE', 0n), t(WSTETH, 'wstETH', 3n), t(WETH, 'WETH', 0n), t(a(7), 'X', 9n, 0n)],
      WETH,
      USDC,
    )
    expect(list.map((x) => x.token.symbol)).toEqual(['WETH', 'USDC', 'cbBTC', 'wstETH'])
  })
})

describe('pairPosition', () => {
  const side = { price: 10n ** 8n, decimals: 18 }
  const usd = { price: 10n ** 8n, decimals: 6 }
  it('the pair alone when the account holds nothing else', () => {
    const p = pairPosition(
      { aTokenBalance: 3n * 10n ** 18n, debtBalance: 2_000_000n, account: { collateralBase: 3n * 10n ** 8n, debtBase: 2n * 10n ** 8n } },
      side,
      usd,
    )
    expect(p).toEqual({ collateralBase: 3n * 10n ** 8n, debtBase: 2n * 10n ** 8n })
  })
  it('the whole account once another collateral backs the debt: finite leverage', () => {
    // half switched to another collateral: 1.5 left on the pair, 3 in the account, debt 2
    const p = pairPosition(
      { aTokenBalance: 15n * 10n ** 17n, debtBalance: 2_000_000n, account: { collateralBase: 3n * 10n ** 8n, debtBase: 2n * 10n ** 8n } },
      side,
      usd,
    )
    expect(positionLeverage(p)).toBe(3)
    expect(positionLeverage({ collateralBase: 15n * 10n ** 7n, debtBase: 2n * 10n ** 8n })).toBe(Infinity)
  })
})
