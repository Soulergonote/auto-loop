/**
 * Geometry of the position bar (J1), as fractions of the collateral's value: the debt, the liquidation threshold (debt
 * at which the position is liquidated) and, as a marker, the debt then if the health factor moves to `projectedHf`.
 * HF = collateral × LT / debt, so the debt is LT / HF of the collateral.
 */
export type BarGeometry = { debt: number; liquidation: number; projected?: number }

const clamp = (x: number) => Math.min(1, Math.max(0, x))

export function barGeometry(healthFactor: number, liquidationThreshold: number, projectedHf?: number): BarGeometry | undefined {
  if (!Number.isFinite(healthFactor) || healthFactor <= 0 || !(liquidationThreshold > 0)) return undefined
  const lt = clamp(liquidationThreshold)
  const projected = projectedHf !== undefined && Number.isFinite(projectedHf) && projectedHf > 0 ? clamp(lt / projectedHf) : undefined
  return { debt: clamp(lt / healthFactor), liquidation: lt, ...(projected !== undefined && { projected }) }
}

/** Weighted liquidation threshold of an account from its health factor and values (Aave): LT = HF × debt / collateral. */
export const thresholdOf = (healthFactor: number, collateral: number, debt: number) => (collateral > 0 && debt > 0 ? (healthFactor * debt) / collateral : 0)

/** Health factor when the collateral's price moves by `move` (−0.2 = −20 %) against the debt, everything else equal. */
export const hfAtPriceMove = (healthFactor: number, move: number) => healthFactor * (1 + move)
