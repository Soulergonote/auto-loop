import { waterfallRange, type WaterfallStep } from '../domain/waterfall'
import { fmtPct } from './format'
import { apyTone } from './tone'

/**
 * Waterfall of an APY (J2): one row per step, a floating bar from the running total before to the one after (green
 * up, red down), totals from zero coloured like any APY (tone.ts), a zero line. Values stay in text colours.
 */
export function Waterfall({ steps, label }: { steps: WaterfallStep[]; label: string }) {
  if (steps.length < 2) return null
  const { lo, hi } = waterfallRange(steps)
  const at = (x: number) => ((x - lo) / (hi - lo)) * 100
  const signed = (s: WaterfallStep) => (s.kind === 'total' ? fmtPct(s.value) : `${s.value < 0 ? '−' : '+'}${fmtPct(Math.abs(s.value))}`)
  return (
    <table className="waterfall" aria-label={label}>
      <tbody>
        {steps.map((s, i) => {
          const left = at(Math.min(s.start, s.end))
          const width = Math.max(0.5, Math.abs(at(s.end) - at(s.start)))
          const tone = s.kind === 'total' ? (apyTone(s.value) ?? 'good') : s.kind === 'up' ? 'good' : 'bad'
          return (
            <tr key={i} className={s.kind === 'total' ? 'total' : undefined}>
              <th scope="row">{s.label}</th>
              <td className="waterfall-track" aria-hidden="true">
                <span className="waterfall-zero" style={{ left: `${at(0)}%` }} />
                <span className={`waterfall-bar ${tone} ${s.kind}`} style={{ left: `${left}%`, width: `${width}%` }} />
              </td>
              <td className={`num ${s.kind === 'total' ? apyTone(s.value) : ''}`}>{signed(s)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
