import { kinkOf, rateOf, type AdjustedRate, type RateCurve } from '../../../domain/irm'
import { fmtDollars, fmtPct } from '../../../ui/format'
import { Metric } from '../../../ui/primitives'

/** a gap under this (0.1 point) is not shown: the « avant » line would only repeat the rate */
const SHOWN_GAP = 0.001

export type RateSide = { label: string; rate: AdjustedRate }

const moved = (r: AdjustedRate) => r.after !== undefined && Math.abs(r.after - r.now) >= SHOWN_GAP

/** « 4,12 % (avant 3,98 %) », or the rate alone when the trade barely moves it */
export const fmtAdjusted = (r: AdjustedRate) => (moved(r) ? `${fmtPct(rateOf(r))} (avant ${fmtPct(r.now)})` : fmtPct(rateOf(r)))

/** A3: what can still be borrowed on the venue, by anyone, once the trade is done, before the curve's kink; its rate */
export type Kink = { room: number; borrowApy: number }

/** the kink once `addedBorrowUsd` is borrowed; `premium` scales its rate like the borrow (Aave v4's risk premium) */
export function kinkAfter(curve: RateCurve | undefined, addedBorrowUsd: number, premium = 0): Kink | undefined {
  if (!curve) return undefined
  const k = kinkOf(curve)
  return { room: k.room - Math.max(0, addedBorrowUsd), borrowApy: k.borrowApy * (1 + premium) }
}

/** « encore 1,2 M$ avant le coude (5,2 %) », amber once the venue is past it */
export function KinkNote({ kink }: { kink: Kink }) {
  return kink.room > 0 ? (
    <span title="Emprunt encore possible sur la réserve, tous emprunteurs, avant que le taux ne prenne sa pente forte">
      encore {fmtDollars(kink.room, true)} avant le coude ({fmtPct(kink.borrowApy)})
    </span>
  ) : (
    <span className="warn-text" title="Utilisation au-delà de l’optimum : chaque emprunt de plus fait monter le taux vite">
      au-delà du coude ({fmtPct(kink.borrowApy)}) : le taux monte vite
    </span>
  )
}

const NAMES = { borrow: 'Emprunt', supply: 'Dépôt' } as const

/**
 * The rate the screen computes with, large: right after the trade when the curve is known (its own borrow raises the
 * utilization, its supply lowers it), with today's rate under it. `lead` is the side shown large (the borrow by
 * default), the other side when given goes on the line under it, then the borrow's distance to its kink (A3).
 */
export function RateMetric({
  borrow,
  supply,
  lead = 'borrow',
  kink,
}: {
  borrow?: RateSide
  supply?: RateSide
  lead?: 'borrow' | 'supply'
  /** A3, for the borrow */
  kink?: Kink
}) {
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
          {kink && (
            <>
              <br />
              <KinkNote kink={kink} />
            </>
          )}
        </>
      }
    />
  )
}
