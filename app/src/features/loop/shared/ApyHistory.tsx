import { useState } from 'react'
import { HISTORY_WINDOWS, apyRegime, lastDays, loopApyHistory, seriesStats, type HistoryWindow, type RatePoint } from '../../../domain/apyHistory'
import { LineChart } from '../../../ui/LineChart'
import { Fold, Segmented, Skel } from '../../../ui/primitives'
import { fmtDate, fmtPct, fmtX } from '../../../ui/format'
import { apyTone } from '../../../ui/tone'

type Props = {
  /** daily borrow rate of the debt */
  borrow?: RatePoint[]
  /** daily lending rate of the collateral; undefined when it earns none (Morpho) */
  supply?: RatePoint[]
  leverage: number
  /** token yield and Merkl of the loop, already levered, at today's level */
  extra: number
  pending: boolean
  /** where the rates come from, for the note */
  source: string
}

const fmtDay = (t: number) => fmtDate(t / 1000)

/**
 * 30 or 90-day history of the loop's net APY at today's leverage (I3): tells a two-day spike from a regime. Nothing
 * when the source has no history for the pair (SparkLend, a market the API does not follow).
 */
export function ApyHistory({ borrow, supply, leverage, extra, pending, source }: Props) {
  const [window, setWindow] = useState<HistoryWindow>(30)
  if (pending)
    return (
      <Fold title="Historique" value={<Skel w={10} />}>
        <Skel w={20} />
      </Fold>
    )
  if (!borrow?.length || !Number.isFinite(leverage)) return null
  const all = loopApyHistory(borrow, supply, leverage, extra)
  const points = lastDays(all, window)
  const stats = seriesStats(points)
  const month = seriesStats(lastDays(all, 30))
  if (!stats || !month || points.length < 2) return null
  const regime = apyRegime(month)
  return (
    <Fold
      title="Historique"
      value={
        <>
          moyenne 30 j <span className={apyTone(month.average)}>{fmtPct(month.average)}</span>
          {regime === 'spike' ? ' · pic du jour' : regime === 'dip' ? ' · creux du jour' : ''}
        </>
      }
    >
      <div className="linechart-range">
        <Segmented
          value={String(window) as `${HistoryWindow}`}
          options={HISTORY_WINDOWS.map((w) => ({ value: String(w) as `${HistoryWindow}`, label: `${w} j` }))}
          onChange={(v) => setWindow(Number(v) as HistoryWindow)}
        />
      </div>
      <LineChart
        points={points}
        format={(v) => fmtPct(v, 1)}
        formatX={fmtDay}
        tone={apyTone}
        label={`APY net de la boucle à ${fmtX(leverage)}, par jour, sur ${window} jours`}
        reference={{ value: stats.average, label: `moyenne ${fmtPct(stats.average, 1)}` }}
      />
      <p className="small">
        Sur {stats.days} j : moyenne <span className={apyTone(stats.average)}>{fmtPct(stats.average)}</span>, plus bas{' '}
        <span className={apyTone(stats.min.v)}>{fmtPct(stats.min.v)}</span> ({fmtDay(stats.min.t)}), plus haut{' '}
        <span className={apyTone(stats.max.v)}>{fmtPct(stats.max.v)}</span> ({fmtDay(stats.max.t)}).
        {regime === 'spike' && <> L’APY du jour dépasse nettement sa moyenne sur 30 jours : c’est un pic, pas un régime.</>}
        {regime === 'dip' && <> L’APY du jour est nettement sous sa moyenne sur 30 jours.</>}
      </p>
      <p className="small muted">
        Taux de chaque jour ({source}) au levier de la boucle ({fmtX(leverage)}).
        {extra !== 0 && ' Rendement du token et Merkl comptés à leur niveau du jour : leur historique n’est pas lu.'}
      </p>
    </Fold>
  )
}
