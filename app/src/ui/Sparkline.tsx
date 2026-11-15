import type { LinePoint } from './LineChart'
import { fmtPct } from './format'

const W = 64
const H = 16

/** Mini-curve of a Scanner line (J3): 30 days of net APY, no axis; the dot is today. Palette colour only (--muted). */
export function Sparkline({ points }: { points: LinePoint[] }) {
  if (points.length < 2) return null
  const t0 = points[0].t
  const t1 = points[points.length - 1].t
  const vs = points.map((p) => p.v)
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const span = hi - lo || Math.abs(hi) || 0.01
  const x = (t: number) => ((t - t0) / (t1 - t0)) * (W - 2) + 1
  const y = (v: number) => H - 2 - ((v - lo) / span) * (H - 4)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const last = points[points.length - 1]
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`30 j : de ${fmtPct(lo)} à ${fmtPct(hi)}`}>
      <title>{`30 j : de ${fmtPct(lo)} à ${fmtPct(hi)}`}</title>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.t)} cy={y(last.v)} r="1.75" fill="currentColor" />
    </svg>
  )
}
