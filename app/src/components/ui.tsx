import type { ReactNode } from 'react'

export function Card({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      {(title || aside) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; disabled?: boolean; hint?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          disabled={o.disabled}
          title={o.hint}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.hint && o.disabled && <span className="soon">{o.hint}</span>}
        </button>
      ))}
    </div>
  )
}

export type Tone = 'good' | 'warn' | 'bad' | undefined

export function Metric({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  )
}

export function Notice({ tone = 'warn', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>
}

export function Steps({ steps }: { steps: { label: string; done?: boolean }[] }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={i} className={s.done ? 'done' : ''}>
          {s.label}
        </li>
      ))}
    </ol>
  )
}

export function hfTone(hf: number, target: number): Tone {
  if (!Number.isFinite(hf) || hf >= target) return 'good'
  if (hf >= 1.1) return 'warn'
  return 'bad'
}
