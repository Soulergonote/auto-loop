import { PROJECTION_DAYS, projectHealthFactor, type Leg } from '../../domain/projection'
import { fmtHf } from '../../ui/format'

/**
 * One line of a position card (I6): the health factor in 30 and 90 days if prices stay where they are and rates
 * where they are today, and at a PT's maturity when it comes first. Information, not an alert.
 */
export function HfProjection({ healthFactor, collateral, debt, ptDaysLeft }: { healthFactor: number; collateral: Leg[]; debt: Leg[]; ptDaysLeft?: number }) {
  if (!Number.isFinite(healthFactor) || debt.every((l) => l.value <= 0)) return null
  const at = (days: number) => fmtHf(Math.max(0, projectHealthFactor(healthFactor, collateral, debt, days)))
  const maturity = ptDaysLeft !== undefined && ptDaysLeft > 0 && ptDaysLeft < PROJECTION_DAYS[PROJECTION_DAYS.length - 1] ? Math.ceil(ptDaysLeft) : undefined
  return (
    <p className="muted small hf-projection">
      Aux taux du jour et prix inchangés, health factor {PROJECTION_DAYS.map((d) => `${at(d)} dans ${d} j`).join(', ')}
      {maturity !== undefined && `, ${at(maturity)} à l’échéance du PT (${maturity} j)`}.
    </p>
  )
}
