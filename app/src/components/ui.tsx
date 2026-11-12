import { useEffect, useId, useState, type ReactNode } from 'react'
import { AGGREGATORS, supportsChain, type AggregatorChoice, type AggregatorId, type Market } from '../config'
import type { Quote } from '../lib/quotes'
import { fmtAmount, fmtBps, fmtDollars, fmtX } from '../lib/format'
import { extraWorstCaseUsd, isSlippageFailure, nextSlippage, type SlippageBps } from '../lib/slippage'
import type { Tone } from '../lib/tone'
import { useGateStep } from './gate'

export type { Tone }

export function Card({ title, children, aside, className }: { title?: ReactNode; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
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

/** 2 to 4 short exclusive choices in a form. Unavailable choices are not passed: nothing "bientôt" is shown. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A value that cannot be computed (no position, invalid input): a muted dash, never a loading rectangle or a wild number. */
export const NA = null
const shown = (value: ReactNode | undefined, w?: number) => (value === undefined ? <Skel w={w} /> : value === null ? <span className="na">—</span> : value)

/** Tile: label of 3 words at most, a value (undefined = being read, null = not computable), one line of sub-text at most. */
export function Metric({ label, value, sub, tone }: { label: ReactNode; value?: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`metric ${value === null ? '' : (tone ?? '')}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{shown(value)}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  )
}

/** Banner: amber = can change the decision without blocking, red = the action is blocked. */
export function Notice({ tone = 'warn', children }: { tone?: 'warn' | 'bad'; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>
}

/**
 * The banners of an action screen: the first blocking problem only (the list is built in the order balance, market
 * liquidity, health factor, swap), and two warnings at most.
 */
export function Banners({ problems, warnings }: { problems: string[]; warnings: string[] }) {
  return (
    <>
      {problems.length > 0 && <Notice tone="bad">{problems[0]}</Notice>}
      {warnings.slice(0, 2).map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}
    </>
  )
}

/** Leverage: a slider with a mark at each whole x, a field to type it, the bounds written beside. */
export function LeverageSlider({
  label = 'Levier',
  value,
  min,
  max,
  step = 0.05,
  onChange,
  aside,
  floor,
}: {
  label?: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (x: number) => void
  /** after the value: the maximum and where it comes from */
  aside?: ReactNode
  /** why the slider cannot go lower (the current leverage of the position) */
  floor?: string
}) {
  const id = useId()
  const [typed, setTyped] = useState<string>()
  const marks = Array.from({ length: Math.floor(max) - Math.ceil(min) + 1 }, (_, i) => Math.ceil(min) + i)
  const commit = (t: string) => {
    const x = Number(t.replace(',', '.'))
    if (Number.isFinite(x) && x > 0) onChange(Math.min(max, Math.max(min, Math.round(x / step) * step)))
    setTyped(undefined)
  }
  return (
    <div className="field">
      <span>
        <label htmlFor={`${id}-n`}>{label}</label>
        <input
          id={`${id}-n`}
          className="lev-input"
          inputMode="decimal"
          aria-label={`${label} (x)`}
          value={typed ?? String(Math.round(value * 100) / 100).replace('.', ',')}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
        />
        <span className="muted small">{aside}</span>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        list={`${id}-m`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <datalist id={`${id}-m`}>
        {marks.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <span className="lev-bounds muted small">
        <span>{floor ?? fmtX(min)}</span>
        <span>{fmtX(max)}</span>
      </span>
    </div>
  )
}

/** Grey rectangle standing for a value being read. */
export const Skel = ({ w = 4 }: { w?: number }) => <span className="skel" style={{ width: `${w}em` }} aria-label="chargement" />

/** Help bubble: an ⓘ after a label, 2 sentences at most, opened on hover and on tap. */
export function Help({ children }: { children: ReactNode }) {
  return (
    <span className="help" tabIndex={0} role="note">
      ⓘ<span className="tip">{children}</span>
    </span>
  )
}

/** Collapsed block: title and summarised value on the same line. */
export function Fold({ title, value, children, open, plain }: { title: string; value?: ReactNode; children: ReactNode; open?: boolean; plain?: boolean }) {
  return (
    <details className={`fold ${plain ? 'fold-plain' : ''}`} open={open}>
      <summary>
        {title}
        {value !== undefined && <span className="fold-value">{value}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  )
}

export function Tag({ tone, children }: { tone?: 'good' | 'warn'; children: ReactNode }) {
  return <span className={`tag ${tone ?? ''}`}>{children}</span>
}

export function Steps({ steps }: { steps: { label: string }[] }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={i}>{s.label}</li>
      ))}
    </ol>
  )
}

/** Boucle screen: choices on the left, summary fixed on the right (a bar at the bottom on mobile). */
export function LoopLayout({ children, summary }: { children: ReactNode; summary: ReactNode }) {
  return (
    <div className="loop">
      <div className="loop-main">{children}</div>
      {summary}
    </div>
  )
}

export type SummaryItem = {
  label: string
  /** undefined = being read (grey rectangle), null = not computable (a dash) */
  value?: ReactNode
  sub?: ReactNode
  tone?: Tone
  /** kept in the mobile bar */
  key?: boolean
}

/**
 * Summary card: 3 or 4 key values and the screen's single main button, with the reason when it is disabled. Until the
 * wallet is connected, on the right network, with a contract there (`needs`), the button is that next step instead.
 */
export function Summary({
  items,
  action,
  reason,
  children,
  needs = 'contract',
}: {
  items: SummaryItem[]
  action: ReactNode
  reason?: string
  children?: ReactNode
  needs?: 'contract' | 'wallet' | 'none'
}) {
  const gate = useGateStep(needs)
  if (gate) {
    action = (
      <button className="btn primary" disabled={!gate.onClick} onClick={gate.onClick}>
        {gate.label}
      </button>
    )
    reason = gate.reason
  }
  return (
    <aside className="card summary">
      <div className="sum-items">
        {items.map((it) => (
          <div key={it.label} className={`sum-item ${it.value === null ? '' : (it.tone ?? '')} ${it.key ? 'key' : ''}`}>
            <div className="sum-label">{it.label}</div>
            <div className="sum-value">{shown(it.value, 5)}</div>
            {it.sub && <div className="sum-sub">{it.sub}</div>}
          </div>
        ))}
      </div>
      <div className="sum-action">
        {action}
        {reason && <span className={`small sum-reason ${gate?.bad ? 'bad-text' : 'muted'}`}>{reason}</span>}
        {children}
      </div>
    </aside>
  )
}

/** Whether a read has been pending for more than `ms` (15 s): the screen then says so in a banner. */
export function useSlow(pending: boolean, ms = 15_000): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (!pending) return
    const t = setTimeout(() => setSlow(true), ms)
    return () => clearTimeout(t)
  }, [pending, ms])
  return slow
}

/** Aggregator choice: "Meilleur prix" plus the aggregators that quote on this chain, nothing else. */
export function AggregatorPicker({ chainId, value, onChange }: { chainId: number; value: AggregatorChoice; onChange: (a: AggregatorChoice) => void }) {
  const usable = (Object.keys(AGGREGATORS) as AggregatorId[]).filter((id) => supportsChain(id, chainId))
  return (
    <div className="field">
      <span>Agrégateur</span>
      <Segmented
        value={value}
        onChange={onChange}
        options={[
          { value: 'best' as AggregatorChoice, label: 'Meilleur prix' },
          ...usable.map((id) => ({ value: id as AggregatorChoice, label: AGGREGATORS[id].label })),
        ]}
      />
    </div>
  )
}

export const aggregatorLabel = (a: AggregatorChoice) => (a === 'best' ? 'Meilleur prix' : AGGREGATORS[a].label)

/** Link to a transaction on the market's block explorer. */
export function TxLink({ market, hash }: { market: Pick<Market, 'chain'>; hash: string }) {
  const explorer = market.chain.blockExplorers?.default
  if (!explorer) return null
  return (
    <a href={`${explorer.url}/tx/${hash}`} target="_blank" rel="noreferrer">
      Voir sur {explorer.name}
    </a>
  )
}

/** Outcome of a transaction: a green line with the explorer link, or a red banner. */
/** a failed swap's minimum: offer the next wider slippage, with what it can cost at worst */
export type SlippageRetry = { current: SlippageBps; set: (s: SlippageBps) => void; sellUsd?: number }

export function TxResult({
  market,
  result,
  retry,
}: {
  market: Pick<Market, 'chain'>
  result?: { ok: boolean; text: string; hash?: string; details?: string[] }
  retry?: SlippageRetry
}) {
  if (!result) return null
  const next = !result.ok && retry && isSlippageFailure(result.text) ? nextSlippage(retry.current) : undefined
  if (next && retry) {
    const extra = retry.sellUsd ? extraWorstCaseUsd(retry.sellUsd, retry.current, next) : undefined
    return (
      <Notice tone="bad">
        {result.text}{' '}
        <button type="button" className="btn small" onClick={() => retry.set(next)}>
          Passer le slippage à {fmtBps(next)}
        </button>{' '}
        <span className="muted">{extra !== undefined ? `au pire ${fmtDollars(extra)} de moins reçus, ` : ''}nouveau devis puis signer à nouveau</span>
      </Notice>
    )
  }
  return result.ok ? (
    <>
      <p className="success">
        {result.text} {result.hash && <TxLink market={market} hash={result.hash} />}
      </p>
      {result.details && result.details.length > 0 && (
        <div className="outcome">
          <div className="outcome-title">Montants réels</div>
          <ul>
            {result.details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  ) : (
    <Notice tone="bad">{result.text}</Notice>
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
