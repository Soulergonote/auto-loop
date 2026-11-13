import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, maxUint256 } from 'viem'
import { debtTokenAbi, executorAbi } from '../../chain/abi'
import { borrowRoom, debtTargets, fullDebtTarget, projectDebtSwap, resizeNewDebt, swapDebtArgs, type SwapDebtPlan } from './swapDebt'
import { swapDebtCall } from './execute'
import { swapDebtBatchCalls } from './batch'
import type { Quote } from '../../services/quotes/quotes'
import type { EModeCategory, Reserve } from './useMarket'

const a = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const USER = a(0x11),
  EXECUTOR = a(0xe1),
  USDE = a(0xc0),
  GHO = a(0xd0),
  USDT = a(0xd1),
  VUSDT = a(0xb1),
  ROUTER = a(0x7001)
const E18 = 10n ** 18n
const quote = (sellAmount: bigint, over: Partial<Quote> = {}): Quote => ({
  aggregator: 'velora',
  router: ROUTER,
  data: '0xdeadbeef',
  sellAmount,
  buyAmount: 1001n * E18,
  minOut: 1000n * E18,
  simulated: false,
  fetchedAt: 0,
  ...over,
})
const plan = (over: Partial<SwapDebtPlan> = {}): SwapDebtPlan => ({
  chainId: 9745,
  executor: EXECUTOR,
  user: USER,
  from: GHO,
  to: USDT,
  toDebtToken: VUSDT,
  full: false,
  newDebtAmount: 1000n * 10n ** 6n,
  quote: quote(1000n * 10n ** 6n),
  minRepaid: 1000n * E18,
  minHealthFactor: 11n * 10n ** 17n,
  borrowAllowance: 0n,
  ...over,
})

describe('swapDebtArgs', () => {
  it('sells the new debt for the old one; a full switch repays the whole debt at inclusion', () => {
    const args = swapDebtArgs(plan())
    expect(args.fromAsset).toBe(GHO)
    expect(args.toAsset).toBe(USDT)
    expect(args.newDebtAmount).toBe(1000n * 10n ** 6n)
    expect(args.minRepaid).toBe(1000n * E18)
    expect(args.steps).toHaveLength(1)
    expect(args.steps[0].tokenOut).toBe(GHO)
    expect(args.steps[0].minOut).toBe(1000n * E18)
    expect(swapDebtArgs(plan({ full: true, minRepaid: 0n })).minRepaid).toBe(maxUint256)
  })
  it('refuses a simulated quote, a quote for another amount, a minimum the swap cannot guarantee', () => {
    expect(() => swapDebtArgs(plan({ quote: quote(1000n * 10n ** 6n, { simulated: true }) }))).toThrow(/simulé/)
    expect(() => swapDebtArgs(plan({ newDebtAmount: 999n }))).toThrow(/autre montant/)
    expect(() => swapDebtArgs(plan({ minRepaid: 1001n * E18 }))).toThrow(/minimum/)
    expect(() => swapDebtArgs(plan({ minRepaid: 0n }))).toThrow(/minimum/)
  })
})

describe('swapDebtCall and its batch', () => {
  it('uses swapDebtWithSig with a signature', () => {
    const sig = { value: 1n, deadline: 2n, v: 27, r: ('0x' + '1'.repeat(64)) as `0x${string}`, s: ('0x' + '2'.repeat(64)) as `0x${string}` }
    expect(swapDebtCall(plan()).functionName).toBe('swapDebt')
    expect(swapDebtCall(plan(), sig).functionName).toBe('swapDebtWithSig')
  })
  it('delegates the exact new debt, calls the contract, then puts the delegation back', () => {
    const calls = swapDebtBatchCalls(plan(), 0n)
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.to)).toEqual([VUSDT, EXECUTOR, VUSDT])
    expect(decodeFunctionData({ abi: debtTokenAbi, data: calls[0].data }).args).toEqual([EXECUTOR, 1000n * 10n ** 6n])
    expect(decodeFunctionData({ abi: executorAbi, data: calls[1].data }).functionName).toBe('swapDebt')
    expect(decodeFunctionData({ abi: debtTokenAbi, data: calls[2].data }).args).toEqual([EXECUTOR, 0n])
    // enough delegation already: the contract call alone
    expect(swapDebtBatchCalls(plan(), 10n ** 12n)).toHaveLength(1)
  })
})

describe('sizing a full switch', () => {
  it('aims a little above the debt for the interest until inclusion', () => {
    expect(fullDebtTarget(10_000n)).toBe(10_005n)
    expect(fullDebtTarget(1n)).toBe(2n)
  })
  it('scales the sold amount so that the minimum covers the target', () => {
    // 1000 USDT gave a minimum of 998 GHO: 1003 GHO needs about 1005.01 USDT
    const sold = 1000n * 10n ** 6n
    const n = resizeNewDebt(sold, 998n * E18, 1003n * E18)
    expect(n).toBeGreaterThan((sold * 1003n) / 998n)
    expect(n).toBeLessThan((sold * 1004n) / 998n)
    expect(resizeNewDebt(sold, 0n, 1n)).toBe(0n)
  })
})

const reserve = (address: `0x${string}`, symbol: string, id: number, over: Partial<Reserve['config']> = {}): Reserve =>
  ({
    token: { address, symbol, name: symbol, decimals: 18 },
    id,
    config: { ltvBps: 8000, liquidationThresholdBps: 8300, active: true, frozen: false, paused: false, borrowingEnabled: true, isolated: false, ...over },
  }) as Reserve

describe('debtTargets', () => {
  const all = [
    reserve(USDE, 'USDe', 0),
    reserve(GHO, 'GHO', 1),
    reserve(USDT, 'USDT', 2),
    reserve(a(0xd2), 'USDC', 3),
    reserve(a(0xd3), 'FROZEN', 4, { frozen: true }),
    reserve(a(0xd4), 'NOBORROW', 5, { borrowingEnabled: false }),
    reserve(a(0xd5), 'PAUSED', 6, { paused: true }),
  ]
  it('borrowable assets other than the pair', () => {
    expect(debtTargets(all, GHO, USDE).map((r) => r.token.symbol)).toEqual(['USDT', 'USDC'])
  })
  it('in eMode, only those borrowable in the category', () => {
    const emode = { id: 1, borrowableBitmap: (1n << 1n) | (1n << 2n) } as EModeCategory
    expect(debtTargets(all, GHO, USDE, emode).map((r) => r.token.symbol)).toEqual(['USDT'])
  })
})

describe('projectDebtSwap', () => {
  const account = { collateralBase: 10_000n * 10n ** 8n, debtBase: 9_000n * 10n ** 8n, liquidationThresholdBps: 9500n }
  it('a dearer swap (more new debt than repaid) lowers the health factor', () => {
    const before = projectDebtSwap(account as never, 0n, 0n).healthFactor
    expect(before).toBeCloseTo(9500 / 9000)
    const after = projectDebtSwap(account as never, 9_000n * 10n ** 8n, 9_020n * 10n ** 8n)
    expect(after.healthFactor).toBeCloseTo(9500 / 9020)
    expect(after.dropToLiquidation).toBeCloseTo(1 - 9020 / 9500)
  })
  it('no debt left: infinite health factor', () => {
    expect(projectDebtSwap(account as never, 9_000n * 10n ** 8n, 0n).healthFactor).toBe(Infinity)
  })
})

describe('borrowRoom', () => {
  it('the smaller of the cash and what the borrow cap leaves', () => {
    expect(borrowRoom(500n, 0n, 0n, 6)).toBe(500n)
    expect(borrowRoom(10n ** 12n, 900n * 10n ** 6n, 1000n, 6)).toBe(100n * 10n ** 6n)
    expect(borrowRoom(10n ** 12n, 2000n * 10n ** 6n, 1000n, 6)).toBe(0n)
  })
})
