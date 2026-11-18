import type { ReactNode } from 'react'
import type { Tone } from './tone'

/** Arc length as a share of the circle: empty at 1.0, full at 1.5 (charte v3), full without debt. */
export const ringFill = (hf: number) => (!Number.isFinite(hf) ? 1 : Math.min(1, Math.max(0, (hf - 1) / 0.5)))

/** The value a ring shows, read from a formatted health factor (« 1.46 », « 1.48 → 1.46 », « ∞ »): the last one. */
export function ringValue(text: ReactNode): number | undefined {
  if (typeof text !== 'string') return undefined
  if (/∞\s*$/.test(text)) return Infinity
  const m = text.match(/(\d+(?:\.\d+)?)\s*$/)
  return m ? Number(m[1]) : undefined
}

const SIZES = { lg: { box: 128, track: 10 }, mini: { box: 72, track: 12 } } as const

/**
 * Health factor ring, the signature of the app: a white disc with a hard shadow, a pale track, an arc in the colour of
 * the threshold from the top, clockwise, filled once on first appearance; the number stays in ink in the middle.
 * `value`: undefined while read (a loading frame), null when not computable (a dash).
 */
export function HfRing({ value, hf, tone, size = 'lg', label }: { value?: ReactNode; hf?: number; tone?: Tone; size?: keyof typeof SIZES; label?: string }) {
  const { box, track } = SIZES[size]
  const r = (box - 4 - track) / 2
  const c = 2 * Math.PI * r
  const x = hf ?? ringValue(value)
  const fill = x === undefined || value === null ? 0 : ringFill(x)
  const arc = x !== undefined && !Number.isFinite(x) ? 'good' : tone
  return (
    <div className={`ring ring-${size}`} role="img" aria-label={`${label ?? 'Health factor'} ${typeof value === 'string' ? value : ''}`.trim()}>
      <svg viewBox={`0 0 ${box - 4} ${box - 4}`} aria-hidden="true">
        <circle cx={(box - 4) / 2} cy={(box - 4) / 2} r={r} className="ring-track" strokeWidth={track} />
        {fill > 0 && (
          <circle
            cx={(box - 4) / 2}
            cy={(box - 4) / 2}
            r={r}
            className={`ring-arc ${arc ?? ''}`}
            strokeWidth={track}
            strokeDasharray={`${(fill * c).toFixed(2)} ${c.toFixed(2)}`}
            style={{ ['--c' as string]: c.toFixed(2) }}
          />
        )}
      </svg>
      <span className="ring-value">
        {value === undefined ? (
          <span className="skel" style={{ width: size === 'lg' ? 56 : 32 }} aria-label="chargement" />
        ) : value === null ? (
          <span className="na">—</span>
        ) : (
          value
        )}
        <small>{label ?? (size === 'lg' ? 'health factor' : 'HF')}</small>
      </span>
    </div>
  )
}
