import { describe, expect, it } from 'vitest'
import { decodeFunctionData, hashTypedData, type Address } from 'viem'
import { v4ExecutorAbi, v4SpokeAbi, v4TakerAbi } from '../../chain/abi'
import { getV4Net, V4_NETWORKS, v4NetOfSpoke, v4Serves } from '../../config'
import { setupCalls, takerPermitTypedData, v4CloseBatch, v4OpenArgs, v4OpenBatch, V4_ALL, type V4ClosePlan, type V4OpenPlan } from './execute'

const EXECUTOR: Address = '0x00000000000000000000000000000000000000e1'
const USER: Address = '0x00000000000000000000000000000000000000a1'
const SPOKE: Address = '0x94e7A5dCbE816e498b89aB752661904E2F56c485'
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a54c71C4D7dA9a8cD'
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
