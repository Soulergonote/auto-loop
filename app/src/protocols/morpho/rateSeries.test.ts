import { describe, expect, it } from 'vitest'
import { realizedBorrowSeries } from './rateSeries'
import { queryString } from './api'

const day = 86_400
const pt = (t: number, assets: bigint, shares: bigint) => ({
  timestamp: t,
  total_supply_assets: '0',
  total_supply_shares: '0',
  total_borrow_assets: String(assets),
  total_borrow_shares: String(shares),
})

describe('realizedBorrowSeries', () => {
  it('annualises the daily growth of the borrow share price', () => {
    // 10 % a year compounded: the share price grows by 1.1^(1/365) a day, whatever new borrows add
    const g = Math.pow(1.1, 1 / 365)
    const shares = 10n ** 24n
    const p0 = 1_000_000_000_000n
    const p1 = BigInt(Math.round(Number(p0) * g))
    const s = realizedBorrowSeries([pt(2 * day, p1 * 3n, shares * 3n), pt(day, p0, shares)])
    expect(s).toHaveLength(1)
    expect(s[0].t).toBe(2 * day * 1000)
    expect(s[0].v).toBeCloseTo(0.1, 4)
  })

  it('skips points without debt', () => {
    expect(realizedBorrowSeries([pt(day, 0n, 0n), pt(2 * day, 5n, 5n), pt(3 * day, 0n, 0n)])).toEqual([])
  })
})

describe('queryString', () => {
  it('repeats array keys and drops undefined values', () => {
    expect(queryString({ chain_ids: [1, 8453], listed: true, cursor: undefined })).toBe('?chain_ids=1&chain_ids=8453&listed=true')
    expect(queryString({})).toBe('')
  })
})
