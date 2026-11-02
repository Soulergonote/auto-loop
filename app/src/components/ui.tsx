import { AGGREGATORS, type Market } from '../config'
import type { Quote } from '../lib/quotes'
import { fmtAmount } from '../lib/format'
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

/** Link to a transaction on the market's block explorer. */
export function TxLink({ market, hash }: { market: Market; hash: string }) {
  const explorer = market.chain.blockExplorers?.default
  if (!explorer) return null
  return (
    <a href={`${explorer.url}/tx/${hash}`} target="_blank" rel="noreferrer">
      Voir sur {explorer.name}
    </a>
  )
}

/** "Meilleur prix" mode: what each aggregator offered, the chosen one first. */
export function QuoteCompare({ quote, token }: { quote?: Quote; token: { symbol: string; decimals: number } }) {
  if (!quote?.alternatives || quote.alternatives.length < 2) return null
  const sorted = [...quote.alternatives].sort((a, b) => (a.aggregator === quote.aggregator ? -1 : b.aggregator === quote.aggregator ? 1 : 0))
  return (
    <p className="muted small">
      Devis comparés :{' '}
      {sorted.map((a, i) => (
        <span key={a.aggregator}>
          {i > 0 && ' · '}
          {a.aggregator === quote.aggregator && !quote.simulated ? <strong>{AGGREGATORS[a.aggregator].label}</strong> : AGGREGATORS[a.aggregator].label}{' '}
          {a.buyAmount !== undefined ? `${fmtAmount(a.buyAmount, token.decimals)} ${token.symbol}` : `indisponible (${a.error})`}
        </span>
      ))}
    </p>
  )
}
