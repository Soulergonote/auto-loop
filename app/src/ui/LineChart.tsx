import { useId, useState, type PointerEvent } from 'react'

/**
 * One series (over time, or any x), as a thin line (UI charter, I3): recessive grid, zero line when the series crosses it,
 * crosshair and tooltip on hover or touch, values in a table for screen readers. Labels are HTML so they keep their
 * size at any width; the SVG stretches.
 */
export type LinePoint = { t: number; v: number }

type Props = {
  points: LinePoint[]
  /** formats a value (axis, tooltip) */
  format: (v: number) => string
  /** formats an x value, a date for a time series (axis, tooltip) */
  formatX: (t: number) => string
  /** tone class of a value in the tooltip (tone.ts) */
  tone?: (v: number) => string | undefined
  /** names the series for screen readers */
  label: string
  /** x of a point kept marked when nothing is hovered (today on a curve of price moves) */
  mark?: number
  /** a horizontal reference line (an average), drawn dashed */
  reference?: { value: number; label: string; tone?: 'bad' }
}

const W = 600
const H = 140

export function LineChart({ points, format, formatX, tone, label, reference, mark }: Props) {
  const [hover, setHover] = useState<number>()
  const id = useId()
  if (points.length < 2) return null
  const t0 = points[0].t
  const t1 = points[points.length - 1].t
  const values = points.map((p) => p.v).concat(reference ? [reference.value] : [])
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  // a zero line only when the series itself changes sign
  const crossesZero = lo < 0 && hi > 0
  if (lo > 0 && lo < hi * 0.5) lo = 0
  const pad = (hi - lo || Math.abs(hi) || 0.01) * 0.08
  lo -= pad
  hi += pad
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const pct = (v: number) => `${((y(v) / H) * 100).toFixed(2)}%`
  const h = hover !== undefined ? points[hover] : mark !== undefined ? points.find((p) => p.t === mark) : undefined

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0)
    let best = 0
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i
    setHover(best)
  }

  return (
    <figure className="linechart" aria-labelledby={`${id}-cap`}>
      <div className="linechart-plot" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(undefined)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <line className="linechart-grid" x1={0} x2={W} y1={0.5} y2={0.5} />
          <line className="linechart-grid" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
          {crossesZero && <line className="linechart-zero" x1={0} x2={W} y1={y(0)} y2={y(0)} />}
          {reference && <line className={`linechart-ref ${reference.tone ?? ''}`} x1={0} x2={W} y1={y(reference.value)} y2={y(reference.value)} />}
          <path className="linechart-line" d={path} />
          {h && <line className="linechart-cross" x1={x(h.t)} x2={x(h.t)} y1={0} y2={H} />}
        </svg>
        <span className="linechart-y" style={{ top: 0 }}>
          {format(hi - pad)}
        </span>
        <span className="linechart-y" style={{ top: '100%', transform: 'translateY(-100%)' }}>
          {format(lo + pad)}
        </span>
        {crossesZero && (
          <span className="linechart-y" style={{ top: pct(0), transform: 'translateY(-50%)' }}>
            0
          </span>
        )}
        {h && <span className="linechart-dot" style={{ left: `${(x(h.t) / W) * 100}%`, top: pct(h.v) }} aria-hidden="true" />}
        {h && (
          <div className={`linechart-tip ${x(h.t) > W / 2 ? 'left' : ''}`} style={{ left: `${(x(h.t) / W) * 100}%` }}>
            <span className="muted">{formatX(h.t)}</span> <b className={tone?.(h.v)}>{format(h.v)}</b>
          </div>
        )}
      </div>
      <div className="linechart-x small muted">
        <span>{formatX(t0)}</span>
        {reference && (
          <span>
            <span className={`linechart-key ${reference.tone ?? ''}`} aria-hidden="true" /> {reference.label}
          </span>
        )}
        <span>{formatX(t1)}</span>
      </div>
      <figcaption id={`${id}-cap`} className="sr-only">
        {label}
      </figcaption>
      <table className="sr-only">
        <tbody>
          {points.map((p) => (
            <tr key={p.t}>
              <th scope="row">{formatX(p.t)}</th>
              <td>{format(p.v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
