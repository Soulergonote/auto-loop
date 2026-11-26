import { describe, expect, it } from 'vitest'
import { lastCollateral, supplyLosses } from './marketInfo'

const day = 86_400
const pt = (t: number, assets: bigint, shares: bigint, collateral?: bigint) => ({
  timestamp: t * day,
  total_supply_assets: String(assets),
  total_supply_shares: String(shares),
  total_borrow_assets: '0',
  total_borrow_shares: '0',
  ...(collateral !== undefined && { total_collateral_assets: String(collateral) }),
})
const S = 10n ** 24n

describe('market details', () => {
  it('finds the days the supply share lost value, not deposits, withdrawals or interest', () => {
    const points = [
      pt(1, 1_000_000n, S),
      // a deposit doubles both sides, interest raises the price: no loss
      pt(2, 2_000_100n, 2n * S),
      // 10 % of the supply written off
      pt(3, 1_800_090n, 2n * S),
      pt(4, 900_045n, S),
    ]
    const losses = supplyLosses(points)
    expect(losses).toHaveLength(1)
    expect(losses[0].at).toBe(3 * day)
    expect(losses[0].share).toBeCloseTo(0.1, 6)
    expect(losses[0].assets).toBe(200_010n)
  })

  it('reads the collateral deposited at the last point', () => {
    expect(lastCollateral([pt(2, 1n, 1n, 7n), pt(1, 1n, 1n, 5n)])).toBe(7n)
    expect(lastCollateral([pt(1, 1n, 1n)])).toBeUndefined()
    expect(lastCollateral([])).toBeUndefined()
  })
})
