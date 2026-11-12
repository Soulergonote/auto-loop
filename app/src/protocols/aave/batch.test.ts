import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, maxUint256 } from 'viem'
import { debtTokenAbi, erc20Abi, executorAbi, executorAbiV1, poolAbi } from '../../chain/abi'
import { closeBatchCalls, openBatchCalls } from './batch'
import { type BatchCall } from '../../chain/batch'
import type { ClosePlan, OpenPlan } from './execute'
import type { Quote } from '../../services/quotes/quotes'

const a = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const USER = a(0x11),
  EXECUTOR = a(0xe1),
  WETH = a(0xc0),
  USDC = a(0xd0),
  VDEBT = a(0xd1),
  AWETH = a(0xa0),
  POOL = a(0x9001),
  ROUTER = a(0x7001),
  MORPHO = a(0x8001)
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
const openPlan = (over: Partial<OpenPlan> = {}): OpenPlan => ({
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
const closePlan = (over: Partial<ClosePlan> = {}): ClosePlan => ({
  chainId: 8453,
  executor: EXECUTOR,
  user: USER,
  collateral: WETH,
  debt: USDC,
  aToken: AWETH,
  full: false,
  repayAmount: 1_000_000_000n,
  collateralToWithdraw: 5n * 10n ** 17n,
  collateralToSell: 5n * 10n ** 17n,
  aTokensNeeded: 5n * 10n ** 17n,
  aTokenAllowance: 0n,
  quote: quote(5n * 10n ** 17n),
  flashLender: MORPHO,
  minHealthFactor: 12n * 10n ** 17n,
  ...over,
})

/** Simulates the allowances a batch leaves: replays every approve / approveDelegation, then the executor spending `spent`. */
function finalAllowances(calls: BatchCall[], start: Record<string, bigint>, spent: Record<string, bigint>) {
  const state = { ...start }
  for (const c of calls) {
    if (c.to === EXECUTOR) {
      for (const [k, v] of Object.entries(spent)) {
        if (state[k] < v) throw new Error(`executor cannot spend ${k}`)
        state[k] -= v
      }
      continue
    }
    try {
      const d = decodeFunctionData({ abi: erc20Abi, data: c.data })
      if (d.functionName === 'approve') {
        expect(d.args[0]).toBe(EXECUTOR)
        state[c.to] = d.args[1] as bigint
        continue
      }
    } catch {
      // not this ABI
    }
    try {
      const d = decodeFunctionData({ abi: debtTokenAbi, data: c.data })
      if (d.functionName === 'approveDelegation') {
        expect(d.args[0]).toBe(EXECUTOR)
        state[c.to] = d.args[1] as bigint
        continue
      }
    } catch {
      // not this ABI
    }
  }
  return state
}

describe('openBatchCalls', () => {
  it('approves and delegates the exact amounts around open, then puts both back', () => {
    const calls = openBatchCalls(openPlan(), { collateral: 0n, borrow: 0n })
    expect(calls.map((c) => c.to)).toEqual([WETH, VDEBT, EXECUTOR, VDEBT, WETH])
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([EXECUTOR, 10n ** 18n])
    expect(decodeFunctionData({ abi: debtTokenAbi, data: calls[1].data }).args).toEqual([EXECUTOR, 2_000_000_000n])
    const open = decodeFunctionData({ abi: executorAbi, data: calls[2].data })
    expect(open.functionName).toBe('open')
    expect(open.args[0]).toMatchObject({
      collateralAsset: WETH,
      debtAsset: USDC,
      capitalToken: WETH,
      capitalAmount: 10n ** 18n,
      capitalSteps: [],
      debtAmount: 2_000_000_000n,
      steps: [{ router: ROUTER, tokenOut: WETH, data: '0xdeadbeef', minOut: 9n }],
      guard: { minHealthFactor: 0n },
    })
    const deadline = (open.args[0] as { guard: { deadline: bigint } }).guard.deadline
    const now = BigInt(Math.floor(Date.now() / 1000))
    expect(deadline > now && deadline <= now + 1200n).toBe(true)
    expect(decodeFunctionData({ abi: debtTokenAbi, data: calls[3].data }).args).toEqual([EXECUTOR, 0n])
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[4].data }).args).toEqual([EXECUTOR, 0n])
  })
  it('v1 executor: same batch with the v1 parameters', () => {
    const calls = openBatchCalls(openPlan({ version: 1 }), { collateral: 0n, borrow: 0n })
    const open = decodeFunctionData({ abi: executorAbiV1, data: calls[2].data })
    expect(open.args[0]).toMatchObject({ initialCollateral: 10n ** 18n, swap: { router: ROUTER, minOut: 9n } })
  })
  it('passes the health factor guard', () => {
    const calls = openBatchCalls(openPlan({ minHealthFactor: 11n * 10n ** 17n }), { collateral: 0n, borrow: 0n })
    expect(decodeFunctionData({ abi: executorAbi, data: calls[2].data }).args[0]).toMatchObject({ guard: { minHealthFactor: 11n * 10n ** 17n } })
  })
  it('switches eMode first, inside the batch', () => {
    const calls = openBatchCalls(openPlan({ eModeTarget: 1 }), { collateral: 0n, borrow: 0n })
    expect(calls[0].to).toBe(POOL)
    expect(decodeFunctionData({ abi: poolAbi, data: calls[0].data }).args).toEqual([1])
  })
  it('touches nothing already allowed, and uses only the plan, never an unbounded amount', () => {
    expect(openBatchCalls(openPlan(), { collateral: maxUint256, borrow: maxUint256 }).map((c) => c.to)).toEqual([EXECUTOR])
    for (const c of openBatchCalls(openPlan(), { collateral: 5n, borrow: 7n })) expect(c.data.toLowerCase()).not.toContain('f'.repeat(64))
  })
  it('never leaves an allowance above what it was (any starting values)', () => {
    for (const col of [0n, 1n, 10n ** 17n, 10n ** 18n, 10n ** 19n])
      for (const bor of [0n, 3n, 2_000_000_000n, 10n ** 12n]) {
        const calls = openBatchCalls(openPlan(), { collateral: col, borrow: bor })
        const end = finalAllowances(calls, { [WETH]: col, [VDEBT]: bor }, { [WETH]: 10n ** 18n, [VDEBT]: 2_000_000_000n })
        expect(end[WETH]).toBeLessThanOrEqual(col)
        expect(end[VDEBT]).toBeLessThanOrEqual(bor)
      }
  })
  it('refuses a simulated quote or one for another amount', () => {
    expect(() => openBatchCalls(openPlan({ quote: quote(2_000_000_000n, { simulated: true }) }), { collateral: 0n, borrow: 0n })).toThrow(/simulé/)
    expect(() => openBatchCalls(openPlan({ quote: quote(1n) }), { collateral: 0n, borrow: 0n })).toThrow(/autre montant/)
  })
  it('opens without capital (lever an existing position): no collateral approval', () =>
    expect(openBatchCalls(openPlan({ initialCollateral: 0n }), { collateral: 0n, borrow: 0n }).map((c) => c.to)).toEqual([VDEBT, EXECUTOR, VDEBT]))
})

describe('closeBatchCalls', () => {
  it('partial close: exact aToken approval around close, back to its value', () => {
    const calls = closeBatchCalls(closePlan(), 0n)
    expect(calls.map((c) => c.to)).toEqual([AWETH, EXECUTOR, AWETH])
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([EXECUTOR, 5n * 10n ** 17n])
    const close = decodeFunctionData({ abi: executorAbi, data: calls[1].data })
    expect(close.functionName).toBe('close')
    expect(close.args[0]).toMatchObject({
      repayAmount: 1_000_000_000n,
      collateralToSell: 5n * 10n ** 17n,
      steps: [{ router: ROUTER, tokenOut: USDC, minOut: 9n }],
      flashLender: MORPHO,
      guard: { minHealthFactor: 12n * 10n ** 17n },
    })
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([EXECUTOR, 0n])
  })
  it('v1 executor: the v1 close, no lender needed', () => {
    const calls = closeBatchCalls(closePlan({ version: 1, flashLender: undefined }), 0n)
    expect(decodeFunctionData({ abi: executorAbiV1, data: calls[1].data }).args[0]).toMatchObject({ swap: { router: ROUTER, minOut: 9n } })
  })
  it('v2 refuses a close without a chosen flash lender', () => expect(() => closeBatchCalls(closePlan({ flashLender: undefined }), 0n)).toThrow(/Prêteur/))
  it('full close: 0,1 % headroom for interest, max repay and withdraw, approval back after', () => {
    const calls = closeBatchCalls(closePlan({ full: true, aTokensNeeded: 10n ** 18n }), 0n)
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([EXECUTOR, 1001n * 10n ** 15n])
    expect(decodeFunctionData({ abi: executorAbi, data: calls[1].data }).args[0]).toMatchObject({
      repayAmount: maxUint256,
      collateralToWithdraw: maxUint256,
      guard: { minHealthFactor: 0n },
    })
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([EXECUTOR, 0n])
  })
  it('a smaller existing allowance goes through 0 first and comes back exactly', () => {
    const calls = closeBatchCalls(closePlan(), 3n)
    expect(calls.map((c) => decodeFunctionData({ abi: c.to === EXECUTOR ? executorAbi : erc20Abi, data: c.data }).args.at(-1))).toEqual([
      0n,
      5n * 10n ** 17n,
      expect.anything(),
      3n,
    ])
  })
  it('refuses a simulated quote or one for another amount', () => {
    expect(() => closeBatchCalls(closePlan({ quote: quote(5n * 10n ** 17n, { simulated: true }) }), 0n)).toThrow(/simulé/)
    expect(() => closeBatchCalls(closePlan({ quote: quote(1n) }), 0n)).toThrow(/autre montant/)
  })
})
