import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, maxUint256 } from 'viem'
import { erc20Abi, executorAbi } from '../abi'
import { flashAmountFor, projectSwap, swapCollateralArgs, swapTargets, thresholdIn, type SwapCollateralPlan } from './swapCollateral'
import { swapCollateralCall } from './execute'
import { swapCollateralBatchCalls } from './oneClick'
import { flashLoanOwed } from './math'
import type { Quote } from './quotes'
import type { EModeCategory, Reserve } from './useMarket'

const a = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const USER = a(0x11),
  EXECUTOR = a(0xe1),
  WETH = a(0xc0),
  WSTETH = a(0xc1),
  CBETH = a(0xc2),
  USDC = a(0xd0),
  AWETH = a(0xa0),
  ROUTER = a(0x7001),
  MORPHO = a(0x8001)
const quote = (sellAmount: bigint, over: Partial<Quote> = {}): Quote => ({
  aggregator: 'velora',
  router: ROUTER,
  data: '0xdeadbeef',
  sellAmount,
  buyAmount: 85n * 10n ** 16n,
  minOut: 84n * 10n ** 16n,
  simulated: false,
  fetchedAt: 0,
  ...over,
})
const plan = (over: Partial<SwapCollateralPlan> = {}): SwapCollateralPlan => ({
  chainId: 8453,
  executor: EXECUTOR,
  user: USER,
  from: WETH,
  to: WSTETH,
  fromAToken: AWETH,
  full: false,
  fromAmount: 10n ** 18n,
  quote: quote(10n ** 18n),
  toAmount: 84n * 10n ** 16n,
  flashLender: MORPHO,
  minHealthFactor: 12n * 10n ** 17n,
  aTokenAllowance: 0n,
  ...over,
})

describe('flashAmountFor', () => {
  it('borrows the whole minimum without a premium', () => {
    expect(flashAmountFor(1000n, 0n)).toBe(1000n)
  })
  it('leaves room for the premium, rounded up like Aave', () => {
    for (const min of [10n ** 18n, 123456789n, 999_999n]) {
      const x = flashAmountFor(min, 5n)
      expect(flashLoanOwed(x, 5n)).toBeLessThanOrEqual(min)
      expect(flashLoanOwed(x + 3n, 5n)).toBeGreaterThan(min - 2n)
    }
  })
})

describe('swapCollateral parameters', () => {
  it('partial: the exact aTokens, one step to the new collateral', () => {
    const args = swapCollateralArgs(plan())
    expect(args.fromAsset).toBe(WETH)
    expect(args.toAsset).toBe(WSTETH)
    expect(args.fromAmount).toBe(10n ** 18n)
    expect(args.toAmount).toBe(84n * 10n ** 16n)
    expect(args.steps).toEqual([{ router: ROUTER, tokenOut: WSTETH, data: '0xdeadbeef', minOut: 84n * 10n ** 16n }])
    expect(args.flashLender).toBe(MORPHO)
    expect(args.guard.minHealthFactor).toBe(12n * 10n ** 17n)
  })
  it('full: the whole balance at inclusion', () => {
    expect(swapCollateralArgs(plan({ full: true })).fromAmount).toBe(maxUint256)
  })
  it('refuses a quote for another amount, a loan above the minimum, no lender, a simulated quote', () => {
    expect(() => swapCollateralArgs(plan({ quote: quote(1n) }))).toThrow(/autre montant/)
    expect(() => swapCollateralArgs(plan({ toAmount: 85n * 10n ** 16n }))).toThrow(/incohérent/)
    expect(() => swapCollateralArgs(plan({ flashLender: undefined as never }))).toThrow(/Prêteur/)
    expect(() => swapCollateralArgs(plan({ quote: quote(10n ** 18n, { simulated: true }) }))).toThrow(/simulé/)
  })
  it('uses the permit variant when a signature is given', () => {
    const sig = { value: 1n, deadline: 2n, v: 27, r: ('0x' + '1'.repeat(64)) as `0x${string}`, s: ('0x' + '2'.repeat(64)) as `0x${string}` }
    expect(swapCollateralCall(plan(), sig).functionName).toBe('swapCollateralWithSig')
    expect(swapCollateralCall(plan()).functionName).toBe('swapCollateral')
  })
  it('the batch approves the old aTokens exactly (headroom on a full switch) and puts the allowance back', () => {
    for (const [full, need] of [
      [false, 10n ** 18n],
      [true, 1001n * 10n ** 15n],
    ] as const) {
      const calls = swapCollateralBatchCalls(plan({ full }), 0n)
      expect(calls.map((c) => c.to)).toEqual([AWETH, EXECUTOR, AWETH])
      expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([EXECUTOR, need])
      expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([EXECUTOR, 0n])
      expect(decodeFunctionData({ abi: executorAbi, data: calls[1].data }).functionName).toBe('swapCollateral')
    }
    expect(swapCollateralBatchCalls(plan(), 10n ** 19n)).toHaveLength(1)
  })
})

const reserve = (address: `0x${string}`, symbol: string, id: number, over: Partial<Reserve['config']> = {}): Reserve =>
  ({
    token: { address, symbol, name: symbol, decimals: 18 },
    id,
    config: { ltvBps: 8000, liquidationThresholdBps: 8300, active: true, frozen: false, paused: false, isolated: false, ...over },
  }) as Reserve

describe('swapTargets', () => {
  const all = [
    reserve(WETH, 'WETH', 0),
    reserve(USDC, 'USDC', 1),
    reserve(WSTETH, 'wstETH', 2),
    reserve(CBETH, 'cbETH', 3),
    reserve(a(0xc3), 'FROZEN', 4, { frozen: true }),
    reserve(a(0xc4), 'LTV0', 5, { ltvBps: 0 }),
    reserve(a(0xc5), 'ISO', 6, { isolated: true }),
  ]
  it('collaterals other than the pair, accepted, not frozen, not isolated', () => {
    expect(swapTargets(all, WETH, USDC).map((r) => r.token.symbol)).toEqual(['wstETH', 'cbETH'])
  })
  it('in eMode, only those of the category (and not at LTV 0 in it)', () => {
    const emode = { id: 1, liquidationThresholdBps: 9500, collateralBitmap: (1n << 0n) | (1n << 2n) | (1n << 3n), ltvZeroBitmap: 1n << 3n } as EModeCategory
    const t = swapTargets(all, WETH, USDC, emode)
    expect(t.map((r) => r.token.symbol)).toEqual(['wstETH'])
    expect(thresholdIn(t[0], emode)).toBe(9500)
    expect(thresholdIn(t[0])).toBe(8300)
  })
  it('in eMode, takes a reserve listed at LTV 0 outside it (Aave PTs)', () => {
    const emode = { id: 1, liquidationThresholdBps: 9200, collateralBitmap: (1n << 0n) | (1n << 5n), ltvZeroBitmap: 0n } as EModeCategory
    expect(swapTargets(all, WETH, USDC, emode).map((r) => r.token.symbol)).toEqual(['LTV0'])
  })
})

describe('projectSwap', () => {
  const account = { collateralBase: 3000n * 10n ** 8n, debtBase: 2000n * 10n ** 8n, liquidationThresholdBps: 8300n }
  it('same value and threshold: same health factor', () => {
    const p = projectSwap(account, 1500n * 10n ** 8n, 8300, 1500n * 10n ** 8n, 8300)
    expect(p.healthFactor).toBeCloseTo(1.245, 6)
    expect(p.collateralBase).toBe(account.collateralBase)
  })
  it('a lower threshold or a value lost in the swap lowers it', () => {
    expect(projectSwap(account, 3000n * 10n ** 8n, 8300, 3000n * 10n ** 8n, 7800).healthFactor).toBeCloseTo(1.17, 6)
    expect(projectSwap(account, 3000n * 10n ** 8n, 8300, 2970n * 10n ** 8n, 8300).healthFactor).toBeCloseTo(1.23255, 4)
  })
  it('no debt: infinite', () => {
    expect(projectSwap({ ...account, debtBase: 0n }, 1n, 8300, 1n, 8300).healthFactor).toBe(Infinity)
  })
})
