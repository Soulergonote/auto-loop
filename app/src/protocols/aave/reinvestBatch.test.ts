import { describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import f from '../../test/fixtures/swaps.json'
import { debtTokenAbi, erc20Abi, executorAbi } from '../../chain/abi'
import { AGGREGATORS } from '../../config'
import { swapTerms, walletSwapProblem } from '../../services/quotes/swapCalldata'
import { buildReinvestBatch, swapCapital, type ReinvestBatch } from './reinvestBatch'
import { MERKL_DISTRIBUTOR } from './reinvest'
import type { Quote } from '../../services/quotes/quotes'

// real calldatas built by the Velora and KyberSwap APIs for this wallet, selling 47.107… MORPHO for WETH on Base
const USER = getAddress('0xeb06e61af307b38a0ec9946e807c7cf964307881')
const MORPHO = { address: getAddress('0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842'), symbol: 'MORPHO', name: 'MORPHO', decimals: 18 }
const WETH = { address: getAddress('0x4200000000000000000000000000000000000006'), symbol: 'WETH', name: 'WETH', decimals: 18 }
const USDC = { address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), symbol: 'USDC', name: 'USDC', decimals: 6 }
const AMOUNT = 47107195667203259006n
const VELORA_MIN = 43322563627592104n
const KYBER_MIN = 43756591013726721n
const EXECUTOR = getAddress('0x00000000000000000000000000000000000000e1')
const VDEBT = getAddress('0x00000000000000000000000000000000000000d1')
const POOL = getAddress('0x00000000000000000000000000000000000000a1')

const quote = (aggregator: 'velora' | 'kyber', minOut: bigint, over: Partial<Quote> = {}): Quote => ({
  aggregator,
  router: getAddress(AGGREGATORS[aggregator].router),
  data: (aggregator === 'velora' ? f.velora : f.kyber) as Hex,
  sellAmount: AMOUNT,
  buyAmount: minOut,
  minOut,
  simulated: false,
  fetchedAt: 0,
  ...over,
})

describe('swapTerms', () => {
  it('reads Velora and KyberSwap calldata', () => {
    expect(swapTerms('velora', f.velora as Hex, USER)).toEqual({
      sell: MORPHO.address,
      buy: WETH.address,
      amount: AMOUNT,
      pulled: AMOUNT,
      minOut: VELORA_MIN,
      recipient: USER,
      fee: 0n,
    })
    expect(swapTerms('kyber', f.kyber as Hex, USER)).toEqual({
      sell: MORPHO.address,
      buy: WETH.address,
      amount: AMOUNT,
      pulled: AMOUNT,
      minOut: KYBER_MIN,
      recipient: USER,
      fee: 0n,
    })
  })
  it('reads 1inch calldata (generic swap, output to the sender)', () => {
    const t = swapTerms('oneinch', f.oneinch as Hex, USER)!
    expect({ ...t, minOut: undefined }).toEqual({
      sell: MORPHO.address,
      buy: WETH.address,
      amount: AMOUNT,
      pulled: AMOUNT,
      minOut: undefined,
      recipient: USER,
      fee: 0n,
    })
    // 1 % slippage on the 0.04571… WETH quoted
    expect(t.minOut).toBe((45719292387524939n * 99n) / 100n)
  })
  it('refuses an unknown method', () => {
    expect(swapTerms('velora', '0x12345678', USER)).toBeUndefined()
    expect(walletSwapProblem('velora', '0x095ea7b3' as Hex, { sell: MORPHO.address, buy: WETH.address, amount: AMOUNT, user: USER, minOut: 1n })).toBe(
      'méthode de swap inconnue',
    )
  })
})

describe('walletSwapProblem', () => {
  const ok = { sell: MORPHO.address, buy: WETH.address, amount: AMOUNT, user: USER, minOut: VELORA_MIN }
  it('accepts the calldata that matches', () => expect(walletSwapProblem('velora', f.velora as Hex, ok)).toBeUndefined())
  it('refuses output paid to another address', () =>
    expect(walletSwapProblem('kyber', f.kyber as Hex, { ...ok, minOut: 0n, user: getAddress('0x0000000000000000000000000000000000000bad') })).toMatch(
      /autre adresse/,
    ))
  it('refuses another amount, other tokens or a lower minimum', () => {
    expect(walletSwapProblem('velora', f.velora as Hex, { ...ok, amount: AMOUNT - 1n })).toMatch(/montant/)
    expect(walletSwapProblem('velora', f.velora as Hex, { ...ok, buy: USDC.address })).toMatch(/tokens/)
    expect(walletSwapProblem('velora', f.velora as Hex, { ...ok, minOut: VELORA_MIN + 1n })).toMatch(/minimum/)
  })
})

const base = (over: Partial<ReinvestBatch> = {}): ReinvestBatch => ({
  user: USER,
  rewards: [
    { token: MORPHO.address, symbol: 'MORPHO', decimals: 18, cumulative: AMOUNT * 2n, amount: AMOUNT, proofs: ['0x' + '11'.repeat(32)] as Hex[], price: 2 },
  ],
  pool: POOL,
  withdrawals: [],
  swaps: [{ sell: MORPHO, amount: AMOUNT, quote: quote('velora', VELORA_MIN), allowance: 0n }],
  capitalDirect: 5n,
  collateral: WETH,
  debt: USDC,
  variableDebtToken: VDEBT,
  executor: EXECUTOR,
  collateralAllowance: 0n,
  borrowAllowance: 0n,
  debtAmount: 100_000_000n,
  leverQuote: { ...quote('velora', 1n), sellAmount: 100_000_000n, data: '0xdeadbeef' },
  ...over,
})

const decodeApprove = (data: Hex) => decodeFunctionData({ abi: erc20Abi, data }).args as readonly [Address, bigint]

describe('buildReinvestBatch', () => {
  it('claims, swaps with an exact approval reset after, then levers with exact allowances reset after', () => {
    const { calls, capital } = buildReinvestBatch(base())
    expect(capital).toBe(VELORA_MIN + 5n)
    expect(calls.map((c) => c.to)).toEqual([
      MERKL_DISTRIBUTOR,
      MORPHO.address,
      getAddress(AGGREGATORS.velora.router),
      MORPHO.address,
      WETH.address,
      VDEBT,
      EXECUTOR,
      VDEBT,
      WETH.address,
    ])
    expect(decodeApprove(calls[1].data)).toEqual([getAddress(AGGREGATORS.velora.router), AMOUNT])
    expect(decodeApprove(calls[3].data)).toEqual([getAddress(AGGREGATORS.velora.router), 0n])
    expect(decodeApprove(calls[4].data)).toEqual([EXECUTOR, VELORA_MIN + 5n])
    expect(decodeFunctionData({ abi: debtTokenAbi, data: calls[5].data }).args).toEqual([EXECUTOR, 100_000_000n])
    const open = decodeFunctionData({ abi: executorAbi, data: calls[6].data })
    expect(open.functionName).toBe('open')
    expect((open.args[0] as { capitalAmount: bigint }).capitalAmount).toBe(VELORA_MIN + 5n)
    expect(decodeFunctionData({ abi: debtTokenAbi, data: calls[7].data }).args).toEqual([EXECUTOR, 0n])
    expect(decodeApprove(calls[8].data)).toEqual([EXECUTOR, 0n])
  })
  it('skips approvals already covered and puts a smaller one back to its value (zero first, for USDT-like tokens)', () => {
    const { calls } = buildReinvestBatch(
      base({
        swaps: [{ sell: MORPHO, amount: AMOUNT, quote: quote('velora', VELORA_MIN), allowance: 7n }],
        collateralAllowance: 10n ** 30n,
        borrowAllowance: 10n ** 30n,
      }),
    )
    expect(calls.map((c) => c.to)).toEqual([MERKL_DISTRIBUTOR, MORPHO.address, MORPHO.address, getAddress(AGGREGATORS.velora.router), MORPHO.address, EXECUTOR])
    expect(decodeApprove(calls[1].data)[1]).toBe(0n)
    expect(decodeApprove(calls[2].data)[1]).toBe(AMOUNT)
    expect(decodeApprove(calls[4].data)[1]).toBe(7n)
  })
  it('refuses a swap that would pay someone else, a simulated or mismatched lever quote', () => {
    const kyber = [{ sell: MORPHO, amount: AMOUNT, quote: quote('kyber', KYBER_MIN), allowance: 0n }]
    expect(() => buildReinvestBatch(base({ swaps: kyber, user: getAddress('0x0000000000000000000000000000000000000bad') }))).toThrow(/autre adresse/)
    expect(() =>
      buildReinvestBatch(base({ swaps: [{ sell: MORPHO, amount: AMOUNT, quote: quote('velora', VELORA_MIN, { simulated: true }), allowance: 0n }] })),
    ).toThrow(/simulé/)
    expect(() => buildReinvestBatch(base({ leverQuote: { ...quote('velora', 1n), sellAmount: 1n } }))).toThrow(/autre montant/)
    expect(() => buildReinvestBatch(base({ leverQuote: undefined }))).toThrow(/levier/)
  })
  it('only claims when nothing is to lever', () => {
    const { calls } = buildReinvestBatch(base({ swaps: [], capitalDirect: 0n, debtAmount: 0n, leverQuote: undefined }))
    expect(calls.map((c) => c.to)).toEqual([MERKL_DISTRIBUTOR])
  })
  it('counts the minimum written in the calldata, not the quote', () =>
    expect(swapCapital([{ sell: MORPHO, amount: AMOUNT, quote: quote('kyber', KYBER_MIN - 10n), allowance: 0n }], WETH.address, USER)).toBe(KYBER_MIN))
})
