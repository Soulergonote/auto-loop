import { describe, expect, it } from 'vitest'
import { claimables, rewardAction, type Claimable, type MerklClaimData } from './reinvest'
import { addr, reserve } from '../../test/testReserves'

const usde = reserve(0, 'USDe')
const gho = reserve(1, 'GHO')
const WXPL = addr(0x777)
const reward = (token: string, amount: string, claimed: string, price = 1, proofs = ['0x01']) => ({
  amount,
  claimed,
  pending: '0',
  proofs,
  token: { address: token, symbol: 'X', decimals: 18, price },
})
const api = (rewards: ReturnType<typeof reward>[], chainId = 9745): MerklClaimData => [{ chain: { id: chainId }, rewards }] as never

describe('reinvest: what is claimable', () => {
  it('pays the cumulative amount minus what the Distributor already paid, the chain winning over the API', () => {
    const data = api([reward(usde.aToken, '5000', '1000'), reward(WXPL, '300', '300')])
    expect(claimables(data, 9745, new Map()).map((c) => [c.amount, c.cumulative])).toEqual([[4000n, 5000n]])
    // claimed on-chain a minute ago, the API does not know yet
    expect(claimables(data, 9745, new Map([[usde.aToken.toLowerCase(), 5000n]]))).toEqual([])
    expect(claimables(data, 8453, new Map())).toEqual([])
  })

  it('skips a reward without proofs (not in the tree yet)', () => {
    expect(claimables(api([reward(WXPL, '10', '0', 1, [])]), 9745, new Map())).toEqual([])
  })
})

describe('reinvest: what each reward becomes', () => {
  const c = (token: string, units: number, price = 1): Claimable => ({
    token: token as never,
    symbol: 'X',
    decimals: 18,
    cumulative: 0n,
    amount: BigInt(units) * 10n ** 18n,
    proofs: [],
    price,
  })
  const reserves = [usde, gho]

  it('leaves the collateral aToken where it is and takes the collateral itself as capital', () => {
    expect(rewardAction(c(usde.aToken, 10), reserves, usde.token.address).kind).toBe('deposited')
    expect(rewardAction(c(usde.token.address, 10), reserves, usde.token.address).kind).toBe('capital')
  })

  it('withdraws another aToken (here the debt asset) and swaps any other token, if worth at least 1 $', () => {
    const a = rewardAction(c(gho.aToken, 5, 0), reserves, usde.token.address)
    expect(a.kind).toBe('withdraw')
    expect(a.kind === 'withdraw' && a.reserve.token.symbol).toBe('GHO')
    expect(rewardAction(c(WXPL, 50, 0.1), reserves, usde.token.address).kind).toBe('swap')
    expect(rewardAction(c(WXPL, 5, 0.1), reserves, usde.token.address).kind).toBe('keep')
    // a token Merkl gives no price for cannot be checked against a minimum: it stays in the wallet
    expect(rewardAction(c(WXPL, 1000, 0), reserves, usde.token.address).kind).toBe('keep')
  })
})
