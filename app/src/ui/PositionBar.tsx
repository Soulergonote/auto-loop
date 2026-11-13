import { barGeometry } from '../domain/positionBar'
import { fmtDollars, fmtHf, fmtPct } from './format'
import { hfTone } from './tone'

type Props = {
  healthFactor: number
  /** weighted liquidation threshold (Aave) or LLTV (Morpho), as a fraction */
  liquidationThreshold: number
  correlated: boolean
  /** health factor at the marker (in 90 days at today's rates) */
  projectedHf?: number
  /** what the marker stands for, e.g. « dans 90 j » */
  projectedLabel?: string
  /** values in USD, when known: shown under the bar */
  amounts?: { collateral: number; debt: number }
}

/**
 * The position in one picture (J1): the bar is the collateral, filled with the debt (coloured like the health factor),
 * then the margin up to the liquidation line, then the part that can never be borrowed. A marker shows the debt in
 * 90 days at today's rates.
 */
export function PositionBar({ healthFactor, liquidationThreshold, correlated, projectedHf, projectedLabel = 'dans 90 j', amounts }: Props) {
  const g = barGeometry(healthFactor, liquidationThreshold, projectedHf)
  if (!g) return null
  const tone = hfTone(healthFactor, correlated) ?? 'good'
  const pc = (x: number) => `${(x * 100).toFixed(2)}%`
  const margin = amounts ? amounts.collateral * g.liquidation - amounts.debt : undefined
  return (
    <div className="posbar">
      <div
        className="posbar-track"
        role="img"
        aria-label={`Dette à ${fmtPct(g.debt, 0)} du collatéral, liquidation à ${fmtPct(g.liquidation, 0)}, health factor ${fmtHf(healthFactor)}`}
      >
        <span className={`posbar-debt ${tone}`} style={{ width: pc(g.debt) }} />
        <span className="posbar-margin" style={{ left: pc(g.debt), width: pc(Math.max(0, g.liquidation - g.debt)) }} />
        <span className="posbar-rest" style={{ left: pc(g.liquidation) }} />
        <span className="posbar-liq" style={{ left: pc(g.liquidation) }} />
        {g.projected !== undefined && Math.abs(g.projected - g.debt) > 0.002 && (
          <span className="posbar-marker" style={{ left: pc(g.projected) }} title={`Health factor ${fmtHf(projectedHf!)} ${projectedLabel}`} />
        )}
      </div>
      <div className="posbar-legend small muted">
        <span>
          <i className={`posbar-key ${tone}`} /> dette {amounts ? fmtDollars(amounts.debt) : fmtPct(g.debt, 0)}
        </span>
        <span>
          <i className="posbar-key posbar-key-margin" /> marge {margin !== undefined ? fmtDollars(Math.max(0, margin)) : fmtPct(g.liquidation - g.debt, 0)}
        </span>
        <span>
          <i className="posbar-key posbar-key-liq" /> liquidation à {fmtPct(g.liquidation, 0)}
        </span>
        {g.projected !== undefined && Math.abs(g.projected - g.debt) > 0.002 && (
          <span>
            <i className="posbar-key posbar-key-marker" /> {projectedLabel} : {fmtHf(projectedHf!)}
          </span>
        )}
      </div>
    </div>
  )
}
