import { rateOf, type AdjustedRate } from '../../../domain/irm'
import { fmtPct } from '../../../ui/format'
import { Metric } from '../../../ui/primitives'

/** a gap under this (0.1 point) is not shown: the « avant » line would only repeat the rate */
const SHOWN_GAP = 0.001

export type RateSide = { label: string; rate: AdjustedRate }

const moved = (r: AdjustedRate) => r.after !== undefined && Math.abs(r.after - r.now) >= SHOWN_GAP

/** « 4,12 % (avant 3,98 %) », or the rate alone when the trade barely moves it */
export const fmtAdjusted = (r: AdjustedRate) => (moved(r) ? `${fmtPct(rateOf(r))} (avant ${fmtPct(r.now)})` : fmtPct(rateOf(r)))

const NAMES = { borrow: 'Emprunt', supply: 'Dépôt' } as const

/**
 * The rate the screen computes with, large: right after the trade when the curve is known (its own borrow raises the
 * utilization, its supply lowers it), with today's rate under it. `lead` is the side shown large (the borrow by
 * default), the other side when given goes on the line under it.
 */
export function RateMetric({ borrow, supply, lead = 'borrow' }: { borrow?: RateSide; supply?: RateSide; lead?: 'borrow' | 'supply' }) {
  const main = lead === 'borrow' ? borrow : supply
  const other = lead === 'borrow' ? supply : borrow
  if (!main) return null
  const known = main.rate.after !== undefined || other?.rate.after !== undefined
  const otherName = lead === 'borrow' ? 'dépôt' : 'emprunt'
  return (
    <Metric
      label={`${NAMES[lead]} ${main.label}${known ? ' après' : ''}`}
      value={fmtPct(rateOf(main.rate))}
      sub={
        <>
          {moved(main.rate) ? `avant : ${fmtPct(main.rate.now)}` : known ? 'inchangé par l’opération' : 'taux actuel'}
          {other && (
            <>
              <br />
              {otherName} {other.label} {fmtAdjusted(other.rate)}
            </>
          )}
        </>
      }
    />
  )
}
