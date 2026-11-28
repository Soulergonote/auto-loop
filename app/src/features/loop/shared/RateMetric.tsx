import { rateOf, type AdjustedRate } from '../../../domain/irm'
import { fmtPct } from '../../../ui/format'
import { Metric } from '../../../ui/primitives'

/** a gap under this (0.1 point) is not shown: the « avant » line would only repeat the rate */
const SHOWN_GAP = 0.001

export type RateSide = { label: string; rate: AdjustedRate }

const moved = (r: AdjustedRate) => r.after !== undefined && Math.abs(r.after - r.now) >= SHOWN_GAP

/** « 4,12 % (avant 3,98 %) », or the rate alone when the trade barely moves it */
export const fmtAdjusted = (r: AdjustedRate) => (moved(r) ? `${fmtPct(rateOf(r))} (avant ${fmtPct(r.now)})` : fmtPct(rateOf(r)))

/**
 * The borrow rate the screen computes with, large: right after the trade when the curve is known (its own borrow raises
 * the utilization), with today's rate under it; the collateral's lending rate on the same tile when it has one.
 */
export function RateMetric({ borrow, supply }: { borrow: RateSide; supply?: RateSide }) {
  const known = borrow.rate.after !== undefined || supply?.rate.after !== undefined
  return (
    <Metric
      label={`Emprunt ${borrow.label}${known ? ' après' : ''}`}
      value={fmtPct(rateOf(borrow.rate))}
      sub={
        <>
          {moved(borrow.rate) ? `avant : ${fmtPct(borrow.rate.now)}` : known ? 'inchangé par l’opération' : 'taux actuel'}
          {supply && (
            <>
              <br />
              dépôt {supply.label} {fmtAdjusted(supply.rate)}
            </>
          )}
        </>
      }
    />
  )
}
