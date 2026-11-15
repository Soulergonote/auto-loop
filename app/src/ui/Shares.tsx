import type { Share } from '../domain/portfolio'
import { fmtDollars, fmtPct } from './format'
import { Logo } from './Logo'

/** Where the net value sits (J5): one row per group, a bar for its share, its value. Palette colours only. */
export function Shares({ title, shares }: { title: string; shares: Share[] }) {
  if (shares.length === 0) return null
  return (
    <div className="split">
      <div className="metric-label">{title}</div>
      {shares.map((s) => (
        <div className="share-row" key={s.label}>
          <span className="share-label">
            <Logo name={s.label} />
            {s.label}
          </span>
          <span className="share-track" role="img" aria-label={`${s.label} : ${fmtPct(s.share, 0)}`}>
            <span className="share-fill" style={{ width: `${(s.share * 100).toFixed(2)}%` }} />
          </span>
          <span className="num">{fmtPct(s.share, 0)}</span>
          <span className="num muted">{fmtDollars(s.usd, true)}</span>
        </div>
      ))}
    </div>
  )
}
