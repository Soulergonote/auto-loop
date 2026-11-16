import { describe, expect, it } from 'vitest'
import { decodeFunctionData, maxUint256, zeroAddress, type Address } from 'viem'
import { debtTokenAbi, erc20Abi, morphoAbi, poolAbi, v4ExecutorAbi, v4SpokeAbi, v4TakerAbi } from '../../chain/abi'
import { getV4Net } from '../../config'
import { placeArgs, v4RefinanceArgs, v4RefinanceBatch, type V4RefinancePlan } from './refinance'

const EXECUTOR: Address = '0x00000000000000000000000000000000000000e1'
const USER: Address = '0x00000000000000000000000000000000000000a1'
const SPOKE: Address = '0x94e7A5dCbE816e498b89aB752661904E2F56c485'
const SPOKE2: Address = '0x00000000000000000000000000000000000000b2'
const POOL: Address = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const ATOKEN: Address = '0x00000000000000000000000000000000000000a7'
const VDEBT: Address = '0x00000000000000000000000000000000000000d7'
const MARKET = {
  loanToken: '0x0000000000000000000000000000000000000001' as Address,
  collateralToken: '0x0000000000000000000000000000000000000002' as Address,
  oracle: '0x0000000000000000000000000000000000000003' as Address,
  irm: '0x0000000000000000000000000000000000000004' as Address,
  lltv: 860_000_000_000_000_000n,
}
const net = { ...getV4Net('v4-ethereum'), executor: EXECUTOR }
const here = { venue: 'v4', spoke: SPOKE, collateralId: 0, debtId: 7 } as const

const plan = (over: Partial<V4RefinancePlan> = {}): V4RefinancePlan => ({
  net,
  executor: EXECUTOR,
  user: USER,
  minHealthFactor: 1_050_000_000_000_000_000n,
  from: here,
  to: { venue: 'aave', pool: POOL },
  fromSetup: { giver: false, taker: false, collateral: true },
  exit: { need: 100n, allowance: 0n },
  enter: { need: 50n, allowance: 0n, debtToken: VDEBT },
  ...over,
})
const names = (calls: { data: `0x${string}` }[]) =>
  calls.map((c) => {
    for (const abi of [v4SpokeAbi, v4TakerAbi, v4ExecutorAbi, morphoAbi, poolAbi, debtTokenAbi, erc20Abi]) {
      try {
        return decodeFunctionData({ abi: abi as typeof v4SpokeAbi, data: c.data }).functionName as string
      } catch {
        // next abi
      }
    }
    return '?'
  })

describe('v4 refinance places', () => {
  it('maps each venue to the contract’s Place', () => {
    expect(placeArgs(here)).toMatchObject({ venue: 0, target: SPOKE, collateralId: 0n, debtId: 7n })
    expect(placeArgs({ venue: 'aave', pool: POOL })).toMatchObject({ venue: 1, target: POOL, collateralId: 0n })
    const m = placeArgs({ venue: 'morpho', market: MARKET })
    expect(m).toMatchObject({ venue: 2, target: zeroAddress, market: MARKET })
  })
  it('moves the whole position, and only with an Aave v4 side', () => {
    const a = v4RefinanceArgs(plan())
    expect(a.debtAmount).toBe(maxUint256)
    expect(a.collateralAmount).toBe(maxUint256)
    expect(() => v4RefinanceArgs(plan({ from: { venue: 'aave', pool: POOL }, to: { venue: 'morpho', market: MARKET } }))).toThrow(/Aave v4/)
    expect(() => v4RefinanceArgs(plan({ to: here }))).toThrow(/identiques/)
  })
})

describe('v4 refinance batch', () => {
  it('v4 → Aave: withdraw allowance, delegation, the call, both back; no collateral flag at the source', () => {
    const calls = v4RefinanceBatch(plan())
    expect(names(calls)).toEqual(['approveWithdraw', 'approveDelegation', 'refinance', 'approveDelegation', 'approveWithdraw'])
    const call = decodeFunctionData({ abi: v4ExecutorAbi, data: calls[2].data })
    const auth = call.args?.[1] as { exit: { signature: string }; morpho: { deadline: bigint } }
    expect(auth.exit.signature).toBe('0x')
    expect(auth.morpho.deadline).toBe(0n)
  })
  it('Aave → v4: eMode first, aToken allowance, setup and flag of the target spoke, Taker borrow allowance', () => {
    const calls = v4RefinanceBatch(
      plan({
        from: { venue: 'aave', pool: POOL },
        to: here,
        fromSetup: undefined,
        toSetup: { giver: true, taker: true, collateral: true },
        exit: { need: 100n, allowance: 0n, aToken: ATOKEN },
        enter: { need: 50n, allowance: 0n },
      }),
    )
    expect(names(calls)).toEqual([
      'setUserPositionManager',
      'setUserPositionManager',
      'setUsingAsCollateral',
      'approve',
      'approveBorrow',
      'refinance',
      'approveBorrow',
      'approve',
    ])
  })
  it('switches an empty Aave account to the pair’s eMode before anything else of Aave', () => {
    const calls = v4RefinanceBatch(plan({ eModeTarget: 1 }))
    expect(names(calls).slice(0, 2)).toEqual(['setUserEMode', 'approveWithdraw'])
  })
  it('v4 → Morpho: authorizes the executor on Morpho around the call only', () => {
    const calls = v4RefinanceBatch(plan({ to: { venue: 'morpho', market: MARKET }, enter: { need: 0n, allowance: 0n } }))
    expect(names(calls)).toEqual(['approveWithdraw', 'setAuthorization', 'refinance', 'setAuthorization', 'approveWithdraw'])
    expect(calls[1].to).toBe(net.morpho)
    expect(names(v4RefinanceBatch(plan({ to: { venue: 'morpho', market: MARKET }, morphoAuthorized: true, exit: { need: 1n, allowance: 1n } })))).toEqual([
      'refinance',
    ])
  })
  it('spoke → spoke: each side’s setup, withdraw out of one and borrow into the other', () => {
    const calls = v4RefinanceBatch(
      plan({
        to: { venue: 'v4', spoke: SPOKE2, collateralId: 1, debtId: 0 },
        fromSetup: { giver: true, taker: false, collateral: true },
        toSetup: { giver: false, taker: false, collateral: true },
        enter: { need: 50n, allowance: 0n },
      }),
    )
    expect(names(calls)).toEqual([
      'setUserPositionManager',
      'setUsingAsCollateral',
      'approveWithdraw',
      'approveBorrow',
      'refinance',
      'approveBorrow',
      'approveWithdraw',
    ])
    expect(calls[0].to).toBe(SPOKE)
    expect(calls[1].to).toBe(SPOKE2)
    const borrow = decodeFunctionData({ abi: v4TakerAbi, data: calls[3].data })
    expect(borrow.args?.slice(0, 2)).toEqual([SPOKE2, 0n])
  })
})
