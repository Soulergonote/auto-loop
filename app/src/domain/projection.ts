/**
 * Health factor of a position in the coming weeks if nothing moves but interest (I6): each supplied asset grows at its
 * own rate (lending rate and the token's own yield, which its oracle follows), each debt at its borrow rate plus the
 * yield of a yield-bearing debt. A PT priced on a linear-discount feed (Aave) climbs to par at maturity, then stays.
 * Market prices are taken as unchanged: this shows the drift of the carry, not a price risk.
 */

/** One asset of the position: its value now (any unit, the same for all) and how it grows. */
export type Leg = {
  value: number
  /** yearly growth of its value (rates + own yield) */
  apy: number
  /** a PT: days to maturity, and its feed's yearly discount when the price follows one (Aave) */
  pt?: { daysLeft: number; discount?: number }
}

const compound = (apy: number, days: number) => Math.pow(1 + apy, days / 365)

/** Factor by which the leg's value grows in `days`. */
export function legGrowth(l: Leg, days: number): number {
  if (!l.pt) return compound(l.apy, days)
  const left = Math.max(0, l.pt.daysLeft)
  if (l.pt.discount !== undefined) {
    // price = 1 - discount x time left, in the underlying; the underlying's own yield on top
    const now = 1 - (l.pt.discount * left) / 365
    const then = 1 - (l.pt.discount * Math.max(0, left - days)) / 365
    return now > 0 ? (then / now) * compound(l.apy, days) : 1
  }
  // no known feed: the fixed yield until maturity, nothing after
  return compound(l.apy, Math.min(days, left))
}

const grown = (legs: Leg[], days: number) => {
  const total = legs.reduce((s, l) => s + l.value, 0)
  return total > 0 ? legs.reduce((s, l) => s + l.value * legGrowth(l, days), 0) / total : 1
}

/** Health factor in `days`: today's, times the collateral's growth over the debt's. */
export function projectHealthFactor(healthFactor: number, collateral: Leg[], debt: Leg[], days: number): number {
  if (!Number.isFinite(healthFactor)) return healthFactor
  return (healthFactor * grown(collateral, days)) / grown(debt, days)
}

/** Days shown in Positions. */
export const PROJECTION_DAYS = [30, 90] as const
