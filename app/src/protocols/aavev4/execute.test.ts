import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, hashTypedData, type Address } from 'viem'
import { v4ExecutorAbi, v4SpokeAbi, v4TakerAbi } from '../../chain/abi'
import { getV4Net, V4_NETWORKS, v4NetOfSpoke, v4Serves } from '../../config'
import type { Quote } from '../../services/quotes/quotes'
import {
  decodeV4Outcome,
  encodeV4Action,
  NO_PERMIT,
  setupCalls,
  takerPermitTypedData,
  v4CloseBatch,
  v4OpenArgs,
  v4OpenBatch,
  v4SwapCollateralAction,
  v4SwapCollateralArgs,
  v4SwapCollateralBatch,
  v4SwapDebtArgs,
  v4SwapDebtBatch,
  V4_ALL,
  type V4ClosePlan,
  type V4OpenPlan,
  type V4SwapCollateralPlan,
  type V4SwapDebtPlan,
} from './execute'

const EXECUTOR: Address = '0x00000000000000000000000000000000000000e1'
const USER: Address = '0x00000000000000000000000000000000000000a1'
const SPOKE: Address = '0x94e7A5dCbE816e498b89aB752661904E2F56c485'
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC: Address = '0xa0b86991c6218b36C1D19D4a54C71c4d7dA9A8Cd'
const net = { ...getV4Net('v4-ethereum'), executor: EXECUTOR }

const base = {
  net,
  executor: EXECUTOR,
  user: USER,
  spoke: SPOKE,
  collateralId: 0,
  debtId: 7,
  collateralToken: WETH,
  debtToken: USDC,
  minHealthFactor: 1_100_000_000_000_000_000n,
}
const open = (over: Partial<V4OpenPlan> = {}): V4OpenPlan => ({
  ...base,
  setup: { giver: true, taker: true, collateral: true },
  capitalToken: WETH,
  capitalAmount: 10n ** 18n,
  capitalAllowance: 0n,
  debtAmount: 0n,
  borrowAllowance: 0n,
  ...over,
})
const close = (over: Partial<V4ClosePlan> = {}): V4ClosePlan => ({
  ...base,
  setup: { giver: false, taker: false, collateral: false },
  repayAmount: 0n,
  collateralToWithdraw: 5n * 10n ** 17n,
  collateralToSell: 0n,
  withdrawAllowance: 0n,
  ...over,
})
const WSTETH: Address = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'
const USDT: Address = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const ROUTER: Address = '0x00000000000000000000000000000000000000c1'
const quote = (sellAmount: bigint, minOut: bigint): Quote => ({
  aggregator: 'velora',
  router: ROUTER,
  data: '0x1234',
  sellAmount,
  buyAmount: minOut + 10n,
  minOut,
  simulated: false,
  fetchedAt: 0,
})
// WETH (0) → wstETH (1), the debt USDC (7) unchanged
const swapColl = (over: Partial<V4SwapCollateralPlan> = {}): V4SwapCollateralPlan => ({
  ...base,
  collateralId: 1,
  collateralToken: WSTETH,
  setup: { giver: false, taker: false, collateral: true },
  fromId: 0,
  fromToken: WETH,
  full: true,
  fromAmount: 10n ** 18n,
  quote: quote(10n ** 18n, 8n * 10n ** 17n),
  toAmount: 8n * 10n ** 17n,
  withdrawAllowance: 0n,
  ...over,
})
// USDC (7) → USDT (8), the collateral WETH (0) unchanged
const swapDebt = (over: Partial<V4SwapDebtPlan> = {}): V4SwapDebtPlan => ({
  ...base,
  debtId: 8,
  debtToken: USDT,
  setup: { giver: false, taker: false, collateral: false },
  fromId: 7,
  fromToken: USDC,
  full: false,
  newDebtAmount: 1_010_000_000n,
  minRepaid: 1_000_000_000n,
  quote: quote(1_010_000_000n, 1_000_000_000n),
  borrowAllowance: 0n,
  ...over,
})
const names = (calls: { to: Address; data: `0x${string}` }[]) =>
  calls.map((c) => {
    for (const abi of [v4SpokeAbi, v4TakerAbi, v4ExecutorAbi]) {
      try {
        return decodeFunctionData({ abi: abi as typeof v4SpokeAbi, data: c.data }).functionName as string
      } catch {
        // next abi
      }
    }
    return 'approve'
  })

describe('v4 config', () => {
  it('gives the Sentora spokes their own position managers and every other Ethereum spoke the main ones', () => {
    const sentora = V4_NETWORKS.find((n) => n.id === 'v4-ethereum-sentora')!
    const main = V4_NETWORKS.find((n) => n.id === 'v4-ethereum')!
    expect(v4Serves(sentora, sentora.spokes![0])).toBe(true)
    expect(v4Serves(main, sentora.spokes![0])).toBe(false)
    expect(v4Serves(main, SPOKE)).toBe(true)
    expect(v4NetOfSpoke(1, sentora.spokes![2])?.id).toBe('v4-ethereum-sentora')
    expect(v4NetOfSpoke(1, SPOKE)?.id).toBe('v4-ethereum')
    expect(v4NetOfSpoke(8453, SPOKE)?.id).toBe('v4-base')
  })
})

describe('v4 setup', () => {
  it('only sends what is missing', () => {
    expect(names(setupCalls(open()))).toEqual(['setUserPositionManager', 'setUserPositionManager', 'setUsingAsCollateral'])
    expect(setupCalls(open({ setup: { giver: false, taker: false, collateral: true } }))).toHaveLength(1)
  })
})

describe('v4 open', () => {
  it('batches setup, exact capital approval, the call, then the approval back', () => {
    const calls = v4OpenBatch(open())
    expect(names(calls)).toEqual(['setUserPositionManager', 'setUserPositionManager', 'setUsingAsCollateral', 'approve', 'open', 'approve'])
    expect(calls[4].to).toBe(EXECUTOR)
  })
  it('skips what is already in place', () => {
    const calls = v4OpenBatch(open({ setup: { giver: false, taker: false, collateral: false }, capitalAllowance: 10n ** 18n }))
    expect(names(calls)).toEqual(['open'])
  })
  it('refuses a borrow without a live quote of the same amount, and a capital outside the pair', () => {
    expect(() => v4OpenArgs(open({ debtAmount: 1000n }))).toThrow(/Devis/)
    expect(() => v4OpenArgs(open({ capitalToken: USER }))).toThrow(/capital/)
    expect(() => v4OpenArgs(open({ debtToken: WETH }))).toThrow(/identiques/)
  })
})

describe('v4 close', () => {
  it('wraps the call between the withdraw allowance and its reset, never the collateral flag', () => {
    const calls = v4CloseBatch(close({ setup: { giver: true, taker: false, collateral: true } }))
    expect(names(calls)).toEqual(['setUserPositionManager', 'approveWithdraw', 'close', 'approveWithdraw'])
    const reset = decodeFunctionData({ abi: v4TakerAbi, data: calls[3].data })
    expect(reset.args?.[3]).toBe(0n)
  })
  it('uses an allowance already in place', () => {
    expect(names(v4CloseBatch(close({ collateralToWithdraw: V4_ALL, withdrawAllowance: V4_ALL })))).toEqual(['close'])
  })
})

describe('taker permit', () => {
  it('hashes under the Taker domain, borrow and withdraw apart', () => {
    const m = { spoke: SPOKE, reserveId: 7n, owner: USER, spender: EXECUTOR, amount: 5n, nonce: 0n, deadline: 100n }
    const b = takerPermitTypedData('BorrowPermit', 1, net.taker, m)
    expect(b.domain).toEqual({ name: 'TakerPositionManager', version: '1', chainId: 1, verifyingContract: net.taker })
    const w = takerPermitTypedData('WithdrawPermit', 1, net.taker, m)
    expect(hashTypedData(b as never)).not.toBe(hashTypedData(w as never))
  })
})

describe('v4 swap collateral', () => {
  it('flags the new collateral, wraps the call in the withdraw allowance of the old one', () => {
    const calls = v4SwapCollateralBatch(swapColl())
    expect(names(calls)).toEqual(['setUsingAsCollateral', 'approveWithdraw', 'swapCollateral', 'approveWithdraw'])
    const flag = decodeFunctionData({ abi: v4SpokeAbi, data: calls[0].data })
    expect(flag.args?.[0]).toBe(1n)
    const allow = decodeFunctionData({ abi: v4TakerAbi, data: calls[1].data })
    // the old collateral's reserve, and room for the interest of a full switch
    expect(allow.args?.[1]).toBe(0n)
    expect(allow.args?.[3]).toBe(10n ** 18n + 10n ** 15n + 1n)
  })
  it('sends all of it as max, the new collateral as the reserve to supply', () => {
    const a = v4SwapCollateralArgs(swapColl())
    expect(a.fromAmount).toBe(V4_ALL)
    expect(a.toId).toBe(1n)
    expect(a.steps[0].tokenOut).toBe(WSTETH)
    expect(v4SwapCollateralArgs(swapColl({ full: false })).fromAmount).toBe(10n ** 18n)
  })
  it('refuses a flash loan above the quote and a quote for another amount', () => {
    expect(() => v4SwapCollateralArgs(swapColl({ toAmount: 9n * 10n ** 17n }))).toThrow(/flash/)
    expect(() => v4SwapCollateralArgs(swapColl({ fromAmount: 1n }))).toThrow(/montant/)
    expect(() => v4SwapCollateralArgs(swapColl({ quote: { ...quote(10n ** 18n, 1n), simulated: true } }))).toThrow(/simulé/)
  })
  it('passes the permit with the call', () => {
    const data = encodeV4Action(v4SwapCollateralAction(swapColl()), { ...NO_PERMIT, amount: 5n, signature: '0xabcd' })
    const d = decodeFunctionData({ abi: v4ExecutorAbi, data })
    expect(d.functionName).toBe('swapCollateral')
    expect((d.args?.[1] as { amount: bigint }).amount).toBe(5n)
  })
})

describe('v4 swap debt', () => {
  it('borrows the new debt within an exact allowance, never touches the collateral flag', () => {
    const calls = v4SwapDebtBatch(swapDebt({ setup: { giver: true, taker: false, collateral: true } }))
    expect(names(calls)).toEqual(['setUserPositionManager', 'approveBorrow', 'swapDebt', 'approveBorrow'])
    const allow = decodeFunctionData({ abi: v4TakerAbi, data: calls[1].data })
    expect(allow.args?.[1]).toBe(8n)
    expect(allow.args?.[3]).toBe(1_010_000_000n)
  })
  it('asks for the whole debt repaid on a full switch, the quote minimum otherwise', () => {
    expect(v4SwapDebtArgs(swapDebt({ full: true })).minRepaid).toBe(V4_ALL)
    expect(v4SwapDebtArgs(swapDebt()).minRepaid).toBe(1_000_000_000n)
    expect(() => v4SwapDebtArgs(swapDebt({ minRepaid: 2_000_000_000n }))).toThrow(/minimum/)
    expect(() => v4SwapDebtArgs(swapDebt({ debtToken: USDC }))).toThrow(/identiques/)
  })
})

describe('v4 outcome', () => {
  it('reads the switch events of the executor for the user', () => {
    const topics = encodeEventTopics({ abi: v4ExecutorAbi, eventName: 'DebtSwapped', args: { user: USER, spoke: SPOKE } })
    const result = { type: 'tuple', components: ['repaid', 'borrowed', 'returned', 'healthFactor'].map((name) => ({ name, type: 'uint256' })) }
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, result], [7n, 8n, { repaid: 1n, borrowed: 2n, returned: 3n, healthFactor: 4n }])
    const log = { address: EXECUTOR, topics, data }
    expect(decodeV4Outcome([log as never], EXECUTOR, USER)).toEqual({ kind: 'swapDebt', repaid: 1n, borrowed: 2n, returned: 3n, healthFactor: 4n })
    expect(decodeV4Outcome([log as never], EXECUTOR, EXECUTOR)).toBeUndefined()
  })
})
