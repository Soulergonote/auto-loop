import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, getAddress, maxUint256, toFunctionSelector, type Address } from 'viem'
import { mainnet } from 'viem/chains'
import { morphoExecutorAbi, poolAbi } from '../../chain/abi'
import { addr, emode, reserve, USD } from '../../test/testReserves'
import type { Snapshot } from '../aave/snapshot'
import { aaveAccountAfter, aaveBorrowRoomBase, aavePair, aaveSupplyRoomBase } from './refinance'
import { NO_AAVE_SIG, encodeAction, morphoRefinanceArgs, refinanceAction, refinanceBatchCalls, withInterestMargin, type MorphoRefinancePlan } from './execute'

vi.mock('../../chain/wagmi', () => ({ wagmiConfig: {} }))

const WETH = reserve(0, 'WETH', { price: 3000n * USD, lt: 8300, ltv: 8000 })
const USDC = reserve(1, 'USDC')
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({ market: {} as Snapshot['market'], reserves: [WETH, USDC], emodes: [], premiumBps: 5n, ...o })
const E = 10n ** 18n

describe('aavePair', () => {
  it('the pair at the reserve parameters, none when Aave does not list both', () => {
    const p = aavePair(snap(), WETH.token.address, USDC.token.address, 0, true)!
    expect(p.ltBps).toBe(8300)
    expect(p.switchTo).toBeUndefined()
    expect(aavePair(snap(), WETH.token.address, addr(1), 0, true)).toBeUndefined()
  })
  it('switches an empty account to the best eMode, keeps a used one in its own', () => {
    const cat = emode(3, [0], [1], 9000, 9300)
    expect(aavePair(snap({ emodes: [cat] }), WETH.token.address, USDC.token.address, 0, true)).toMatchObject({ ltBps: 9300, switchTo: 3 })
    expect(aavePair(snap({ emodes: [cat] }), WETH.token.address, USDC.token.address, 0, false)).toMatchObject({ ltBps: 8300, switchTo: undefined })
    // an empty account in a category the pair does not fit goes back to none
    const other = emode(4, [5], [6])
    expect(aavePair(snap({ emodes: [other] }), WETH.token.address, USDC.token.address, 4, true)).toMatchObject({ ltBps: 8300, switchTo: 0 })
  })
  it('none when the debt cannot be borrowed in the account’s eMode, or the collateral is frozen', () => {
    const cat = emode(2, [0], [7])
    expect(aavePair(snap({ emodes: [cat] }), WETH.token.address, USDC.token.address, 2, false)).toBeUndefined()
    const frozen = { ...WETH, config: { ...WETH.config, frozen: true } }
    expect(aavePair(snap({ reserves: [frozen, USDC] }), WETH.token.address, USDC.token.address, 0, true)).toBeUndefined()
  })
})

describe('aaveAccountAfter', () => {
  const empty = { collateralBase: 0n, debtBase: 0n, liquidationThresholdBps: 0n, ltvBps: 0n }
  it('adding 1 WETH and 2000 USDC to an empty account: HF 3000 x 0.83 / 2000', () => {
    const a = aaveAccountAfter(empty, E, WETH.side, 8300, 8000, 2000n * E, USDC.side, 1)
    expect(a.healthFactor).toBeCloseTo(1.245, 6)
    expect(a.ltvOk).toBe(true)
    // 2500 USDC is above 80 % of 3000: Aave refuses the borrow
    expect(aaveAccountAfter(empty, E, WETH.side, 8300, 8000, 2500n * E, USDC.side, 1).ltvOk).toBe(false)
  })
  it('taking the pair out leaves the rest of the account', () => {
    // 2 WETH-worth of collateral at 83 %, 3000 of debt; 1 WETH and 2000 USDC leave
    const acc = { collateralBase: 6000n * USD, debtBase: 3000n * USD, liquidationThresholdBps: 8300n, ltvBps: 8000n }
    const a = aaveAccountAfter(acc, E, WETH.side, 8300, 8000, 2000n * E, USDC.side, -1)
    expect(a.debtBase).toBe(1000n * USD)
    expect(a.healthFactor).toBeCloseTo(2.49, 6)
    expect(aaveAccountAfter(acc, 2n * E, WETH.side, 8300, 8000, 3000n * E, USDC.side, -1).healthFactor).toBe(Infinity)
  })
})

describe('Aave room', () => {
  it('cash, borrow cap and supply cap', () => {
    expect(aaveBorrowRoomBase(reserve(1, 'USDC', { cashBase: 500n * USD }))).toBe(500n * USD)
    expect(aaveBorrowRoomBase(reserve(1, 'USDC', { cashBase: 500n * USD, borrowCap: 1000n, totalDebtBase: 800n * USD }))).toBe(200n * USD)
    expect(aaveSupplyRoomBase(USDC)).toBeUndefined()
    expect(aaveSupplyRoomBase(reserve(0, 'WETH', { price: 3000n * USD, supplyCap: 10n, totalSupplyBase: 27_000n * USD }))).toBe(3000n * USD)
  })
})

describe('refinance plan', () => {
  const executor = getAddress('0x2222222222222222222222222222222222222222')
  const user = getAddress('0x3333333333333333333333333333333333333333')
  const pool = getAddress('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2')
  const market = { loanToken: USDC.token.address, collateralToken: WETH.token.address, oracle: addr(9), irm: addr(10), lltv: 860000000000000000n }
  const plan = (o: Partial<MorphoRefinancePlan> = {}): MorphoRefinancePlan => ({
    net: { chain: mainnet, morpho: getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb') } as unknown as MorphoRefinancePlan['net'],
    executor,
    user,
    authorized: false,
    minHealthFactor: 1_100_000_000_000_000_000n,
    pool,
    market,
    toMorpho: true,
    debtAmount: maxUint256,
    collateralAmount: maxUint256,
    aave: { token: WETH.aToken, need: withInterestMargin(E), allowance: 0n },
    ...o,
  })

  it('refuses the same token on both sides or nothing to move', () => {
    expect(() => morphoRefinanceArgs(plan({ market: { ...market, loanToken: market.collateralToken } }))).toThrow()
    expect(() => morphoRefinanceArgs(plan({ debtAmount: 0n }))).toThrow()
  })
  it('encodes refinanceWithAuth with an empty Aave signature by default', () => {
    const auth = {
      nonce: 0n,
      deadline: 1n,
      grant: { v: 27, r: `0x${'1'.repeat(64)}`, s: `0x${'2'.repeat(64)}` },
      revoke: { v: 28, r: `0x${'3'.repeat(64)}`, s: `0x${'4'.repeat(64)}` },
    } as const
    const data = encodeAction(refinanceAction(plan()), auth)
    const d = decodeFunctionData({ abi: morphoExecutorAbi, data })
    expect(d.functionName).toBe('refinanceWithAuth')
    expect((d.args as readonly unknown[])[2]).toMatchObject({ deadline: NO_AAVE_SIG.deadline })
    expect(encodeAction(refinanceAction(plan())).slice(0, 10)).toBe(
      toFunctionSelector(morphoExecutorAbi.find((x) => x.type === 'function' && x.name === 'refinance')!),
    )
  })
  it('batch to Morpho: aToken approval, grant, call, revoke, approval back', () => {
    const calls = refinanceBatchCalls(plan())
    expect(calls.map((c) => c.to)).toEqual([WETH.aToken, plan().net.morpho, executor, plan().net.morpho, WETH.aToken] as Address[])
  })
  it('batch to Aave: eMode first, then the exact delegation', () => {
    const calls = refinanceBatchCalls(
      plan({ toMorpho: false, eModeTarget: 1, aave: { token: USDC.variableDebtToken, need: 2000n * E, allowance: 0n }, authorized: true }),
    )
    expect(calls.map((c) => c.to)).toEqual([pool, USDC.variableDebtToken, executor, USDC.variableDebtToken] as Address[])
    expect(decodeFunctionData({ abi: poolAbi, data: calls[0].data }).args).toEqual([1])
  })
})

describe('aaveAccountAfter, rounding', () => {
  it('a remainder of a few cents after taking the whole pair out is no position', () => {
    const acc = { collateralBase: 3000n * USD + 3n, debtBase: 2000n * USD + 40_000n, liquidationThresholdBps: 8300n, ltvBps: 8000n }
    const a = aaveAccountAfter(acc, E, WETH.side, 8300, 8000, 2000n * E, USDC.side, -1)
    expect(a.debtBase).toBe(0n)
    expect(a.healthFactor).toBe(Infinity)
  })
})
