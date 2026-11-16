/**
 * What an Aave v4 position can switch to: another collateral or another debt of its spoke, the same pair on another
 * spoke. Pure helpers, tested; the transactions live in execute.ts and refinance.ts.
 */
import type { Address } from 'viem'
import type { V4Reserve } from './reserves'
import type { V4Pair } from './state'

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()
const inSpoke = (r: V4Reserve, spoke: Address) => same(r.spoke.address, spoke)

/** Collaterals of the spoke the position can move to: accepted as collateral, neither its collateral nor its debt token. */
export const v4CollateralTargets = (reserves: V4Reserve[], pair: V4Pair): V4Reserve[] =>
  reserves.filter(
    (r) =>
      inSpoke(r, pair.collateral.spoke.address) &&
      r.canCollateral &&
      r.collateralFactor > 0 &&
      !same(r.token.address, pair.collateral.token.address) &&
      !same(r.token.address, pair.debt.token.address),
  )

/** Debts of the spoke the position can move to: borrowable, neither its debt nor its collateral token. */
export const v4DebtTargets = (reserves: V4Reserve[], pair: V4Pair): V4Reserve[] =>
  reserves.filter(
    (r) =>
      inSpoke(r, pair.collateral.spoke.address) &&
      r.canBorrow &&
      !same(r.token.address, pair.debt.token.address) &&
      !same(r.token.address, pair.collateral.token.address),
  )

/**
 * The same two tokens on the other spokes of these position managers, one pair per spoke (the first collateral and
 * debt reserves of each token, two hubs aside). `canLand`: the pair takes a position (collateral accepted, debt
 * borrowable); a pair that cannot may still hold one to move out of.
 */
export function v4SamePairs(reserves: V4Reserve[], pair: V4Pair): (V4Pair & { canLand: boolean })[] {
  const out: (V4Pair & { canLand: boolean })[] = []
  const spokes = [...new Set(reserves.map((r) => r.spoke.address.toLowerCase()))]
  for (const s of spokes) {
    if (same(s as Address, pair.collateral.spoke.address)) continue
    const own = reserves.filter((r) => same(r.spoke.address, s as Address))
    const cs = own.filter((r) => same(r.token.address, pair.collateral.token.address))
    const ds = own.filter((r) => same(r.token.address, pair.debt.token.address))
    const c = cs.find((r) => r.canCollateral && r.collateralFactor > 0) ?? cs[0]
    const d = ds.find((r) => r.canBorrow) ?? ds[0]
    if (!c || !d) continue
    out.push({ collateral: c, debt: d, canLand: c.canCollateral && c.collateralFactor > 0 && d.canBorrow })
  }
  return out
}

/**
 * Health factor from the collaterals' values and collateral factors and the debt's value (same unit): what the spoke
 * computes, every collateral counted at its factor. Infinity without debt.
 */
export function v4Hf(collaterals: { value: bigint; factor: number }[], debtValue: bigint): number {
  if (debtValue <= 0n) return Infinity
  const weighted = collaterals.reduce((s, c) => s + Number(c.value > 0n ? c.value : 0n) * c.factor, 0)
  return weighted / Number(debtValue)
}
