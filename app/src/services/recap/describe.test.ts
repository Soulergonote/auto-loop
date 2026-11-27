import { describe, expect, it } from 'vitest'
import { encodeFunctionData, getAddress, maxUint256, type Address } from 'viem'
import { erc20Abi, poolAbi } from '../../chain/abi'
import { openBatchCalls } from '../../protocols/aave/batch'
import type { OpenPlan } from '../../protocols/aave/execute'
import { takerPermitTypedData, v4OpenBatch, type V4OpenPlan } from '../../protocols/aavev4/execute'
import { authorizationTypedData } from '../../protocols/morpho/markets'
import { getV4Net } from '../../config'
import { addressesIn, eModeSet, describeBatch, describeCall, describeTypedData, type RecapContext } from './describe'
import type { Name, Token } from './names'

const a = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const USER = a(0x11),
  EXECUTOR = a(0xe1),
  STRANGER = a(0xbad),
  WETH = a(0xc0),
  USDC = a(0xd0),
  VDEBT = a(0xd1),
  POOL = a(0x9001),
  ROUTER = a(0x7001),
  SPOKE = a(0x5001),
  MORPHO = a(0x8001)
const NOW = 1_800_000_000

const NAMES: Record<string, Name> = {
  [EXECUTOR]: { label: 'contrat Auto-loop V2 · Aave · Base', ours: true },
  [POOL]: { label: 'pool Aave · Base' },
  [ROUTER]: { label: 'routeur Velora' },
  [SPOKE]: { label: 'spoke Aave v4 Main' },
  [MORPHO]: { label: 'Morpho Blue' },
}
const TOKENS: Record<string, Token> = {
  [WETH]: { symbol: 'WETH', decimals: 18 },
  [USDC]: { symbol: 'USDC', decimals: 6 },
  [VDEBT]: { symbol: 'variableDebtBasUSDC', decimals: 6 },
}
const ctx: RecapContext = {
  chainId: 8453,
  user: USER,
  nowSec: NOW,
  name: (x) => NAMES[getAddress(x)],
  token: (x) => TOKENS[getAddress(x)],
  eMode: (_, id) => (id === 1 ? 'ETH correlated' : undefined),
  v4Reserve: (spoke, id) =>
    getAddress(spoke) === SPOKE ? [TOKENS[WETH], undefined, undefined, undefined, undefined, undefined, undefined, TOKENS[USDC]][Number(id)] : undefined,
}

const openPlan: OpenPlan = {
  chainId: 8453,
  executor: EXECUTOR,
  user: USER,
  collateral: WETH,
  debt: USDC,
  variableDebtToken: VDEBT,
  initialCollateral: 10n ** 18n,
  debtAmount: 2_000_000_000n,
  quote: {
    aggregator: 'velora',
    router: ROUTER,
    data: '0xdeadbeef',
    sellAmount: 2_000_000_000n,
    buyAmount: 10n ** 18n,
    minOut: 99n * 10n ** 16n,
    simulated: false,
    fetchedAt: 0,
  },
  collateralAllowance: 0n,
  borrowAllowance: 0n,
  pool: POOL,
  minHealthFactor: 105n * 10n ** 16n,
}

describe('describeTypedData', () => {
  it('reads an Aave credit delegation: spender, amount, validity', () => {
    const r = describeTypedData(ctx, {
      domain: { name: 'Aave Base Variable Debt USDC', verifyingContract: VDEBT },
      primaryType: 'DelegationWithSig',
      message: { delegatee: EXECUTOR, value: 2_000_000_000n, nonce: 3n, deadline: BigInt(NOW + 1200) },
    })
    expect(r.title).toBe('Délégation de crédit Aave')
    expect(r.sentence).toContain('contrat Auto-loop V2')
    expect(r.sentence).toContain('2\u202f000.00 variableDebtBasUSDC')
    expect(r.sentence).toContain('dans 20 min')
    expect(r.warnings).toEqual([])
  })

  it('warns about an unknown spender, an unlimited amount and a long validity', () => {
    const r = describeTypedData(ctx, {
      domain: { verifyingContract: WETH },
      primaryType: 'Permit',
      message: { owner: USER, spender: STRANGER, value: maxUint256, nonce: 0n, deadline: BigInt(NOW + 86_400) },
    })
    expect(r.sentence).toContain('un montant illimité')
    expect(r.warnings).toHaveLength(3)
  })

  it('reads the Morpho grant and its revocation', () => {
    const base = { authorizer: USER, authorized: EXECUTOR, deadline: BigInt(NOW + 1200) }
    const grant = describeTypedData(ctx, authorizationTypedData(8453, MORPHO, { ...base, isAuthorized: true, nonce: 7n }) as never)
    const revoke = describeTypedData(ctx, authorizationTypedData(8453, MORPHO, { ...base, isAuthorized: false, nonce: 8n }) as never)
    expect(grant.title).toBe('Autorisation Morpho')
    expect(grant.sentence).toContain('nonce 7')
    expect(revoke.title).toBe('Retrait de l’autorisation Morpho')
    expect(revoke.warnings).toEqual([])
  })

  it('names the reserve of an Aave v4 Taker permit', () => {
    const td = takerPermitTypedData('BorrowPermit', 1, getV4Net('v4-ethereum').taker, {
      spoke: SPOKE,
      reserveId: 7n,
      owner: USER,
      spender: EXECUTOR,
      amount: 5_000_000n,
      nonce: 0n,
      deadline: BigInt(NOW + 600),
    })
    const r = describeTypedData(ctx, td as never)
    expect(r.title).toBe('Autorisation d’emprunt Aave v4')
    expect(r.sentence).toContain('5 USDC')
    expect(r.lines.find((l) => l.label === 'Réserve')?.value).toBe('USDC (n° 7)')
  })
})

describe('describeCall', () => {
  it('reads an exact approval and flags an unknown spender', () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [STRANGER, 10n ** 18n] })
    const r = describeCall(ctx, { to: WETH, data })
    expect(r.sentence).toContain('1 WETH')
    expect(r.warnings[0]).toContain('pas un contrat Auto-loop')
  })

  it('reads the executor call of an Aave open, with its swap, health factor floor and deadline', () => {
    const calls = openBatchCalls(openPlan, { collateral: 0n, borrow: 0n })
    const main = describeCall(
      ctx,
      calls.find((c) => c.to === EXECUTOR)!,
    )
    expect(main.title).toBe('Ouvrir ou augmenter la boucle')
    const value = (label: string) => main.lines.find((l) => l.label === label)?.value
    expect(value('Capital versé')).toBe('1 WETH')
    expect(value('Emprunt')).toBe('2\u202f000.00 USDC')
    expect(value('Swap')).toBe('routeur Velora, au moins 0.99 WETH')
    expect(value('Health factor final minimum')).toBe('1.05')
    expect(main.warnings).toEqual([])
  })

  it('reads a whole batch in order, every warning gathered', () => {
    const calls = openBatchCalls(openPlan, { collateral: 0n, borrow: 0n })
    const r = describeBatch(ctx, calls)
    expect(r.calls?.map((c) => c.title)).toEqual(calls.map((c) => describeCall(ctx, c).title))
    expect(r.kind).toBe(`Lot de ${calls.length} opérations`)
    expect(r.warnings).toEqual([])
  })

  it('reads an Aave v4 open batch: the spoke setup, the Taker allowance, the call', () => {
    const plan: V4OpenPlan = {
      net: { ...getV4Net('v4-ethereum'), executor: EXECUTOR },
      executor: EXECUTOR,
      user: USER,
      spoke: SPOKE,
      collateralId: 0,
      debtId: 7,
      collateralToken: WETH,
      debtToken: USDC,
      minHealthFactor: 11n * 10n ** 17n,
      setup: { giver: false, taker: false, collateral: false },
      capitalToken: WETH,
      capitalAmount: 10n ** 18n,
      capitalAllowance: 0n,
      debtAmount: 0n,
      borrowAllowance: 0n,
    }
    const r = describeBatch(ctx, v4OpenBatch(plan))
    const call = r.calls!.find((c) => c.title === 'Ouvrir ou augmenter la boucle')!
    expect(call.lines.find((l) => l.label === 'Spoke Aave v4')?.value).toContain('spoke Aave v4 Main')
    expect(call.lines.find((l) => l.label === 'Capital versé')?.value).toBe('1 WETH')
  })

  it('names the eMode category a call sets', () => {
    const data = encodeFunctionData({ abi: poolAbi, functionName: 'setUserEMode', args: [1] })
    expect(eModeSet({ to: POOL, data })).toBe(1)
    expect(describeCall(ctx, { to: POOL, data }).sentence).toBe(
      'Passe ton compte dans la catégorie eMode « ETH correlated » (n° 1) sur pool Aave · Base (0x0000…9001).',
    )
  })

  it('says when it cannot read a call', () => {
    const r = describeCall(ctx, { to: STRANGER, data: '0x12345678' })
    expect(r.title).toBe('Appel non reconnu')
    expect(r.warnings).toHaveLength(1)
  })
})

describe('addressesIn', () => {
  it('finds every address in nested arguments', () => {
    const found = addressesIn([{ x: WETH, y: [USDC, 'nope', 5n] }, EXECUTOR.toLowerCase() as Address])
    expect([...found].sort()).toEqual([WETH, USDC, EXECUTOR].sort())
  })
})
