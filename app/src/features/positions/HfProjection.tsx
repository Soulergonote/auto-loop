import { PROJECTION_DAYS, projectHealthFactor, type Leg } from '../../domain/projection'
import { fmtHf } from '../../ui/format'
import { PositionBar } from '../../ui/PositionBar'

/**
 * One line of a position card (I6): the health factor in 30 and 90 days if prices stay where they are and rates
 * where they are today, and at a PT's maturity when it comes first. Information, not an alert. With `bar`, the position
 * bar (J1) above it, values in base units (1e8 = 1 $).
 */
export function HfProjection({
  healthFactor,
  collateral,
  debt,
  ptDaysLeft,
  bar,
}: {
  healthFactor: number
  collateral: Leg[]
  debt: Leg[]
  ptDaysLeft?: number
  /** the position bar above the line (J1): liquidation threshold (weighted) or LLTV, and the pair type */
  bar?: { liquidationThreshold: number; correlated: boolean }
}) {
  if (!Number.isFinite(healthFactor) || debt.every((l) => l.value <= 0)) return null
  const at = (days: number) => fmtHf(Math.max(0, projectHealthFactor(healthFactor, collateral, debt, days)))
  const maturity = ptDaysLeft !== undefined && ptDaysLeft > 0 && ptDaysLeft < PROJECTION_DAYS[PROJECTION_DAYS.length - 1] ? Math.ceil(ptDaysLeft) : undefined
  const sum = (legs: Leg[]) => legs.reduce((a, l) => a + l.value, 0) / 1e8
  return (
    <>
      {bar && (
        <PositionBar
          healthFactor={healthFactor}
          liquidationThreshold={bar.liquidationThreshold}
          correlated={bar.correlated}
          projectedHf={projectHealthFactor(healthFactor, collateral, debt, 90)}
          amounts={{ collateral: sum(collateral), debt: sum(debt) }}
        />
      )}
      <p className="muted small hf-projection">
        Aux taux du jour et prix inchangés, health factor {PROJECTION_DAYS.map((d) => `${at(d)} dans ${d} j`).join(', ')}
        {maturity !== undefined && `, ${at(maturity)} à l’échéance du PT (${maturity} j)`}.
      </p>
    </>
  )
}
