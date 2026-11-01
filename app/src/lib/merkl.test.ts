import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchIncentives, rewardsFor } from './merkl'

const A_TOKEN = '0x00000000000000000000000000000000000000a1'
const DEBT_TOKEN = '0x00000000000000000000000000000000000000d1'
const UNDERLYING = '0x00000000000000000000000000000000000000c1'

afterEach(() => vi.unstubAllGlobals())

describe('fetchIncentives', () => {
  it('adds up LEND and BORROW rewards by aToken / debt token, ignores the rest', async () => {
    const list = [
      { action: 'LEND', identifier: A_TOKEN, apr: 2.5, tokens: [{ address: UNDERLYING }] },
      { action: 'LEND', explorerAddress: A_TOKEN.toUpperCase().replace('0X', '0x'), apr: 1 },
      { action: 'BORROW', identifier: DEBT_TOKEN, apr: 0.8 },
      { action: 'POOL', identifier: A_TOKEN, apr: 50 },
      { action: 'LEND', identifier: A_TOKEN, apr: 0 },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(list))))
    const inc = await fetchIncentives(8453, new AbortController().signal)
    const r = rewardsFor(inc, A_TOKEN, DEBT_TOKEN)
    expect(r.supply).toBeCloseTo(0.035)
    expect(r.borrow).toBeCloseTo(0.008)
    expect(rewardsFor(inc, UNDERLYING, UNDERLYING).borrow).toBe(0)
  })
})
