/** Folds every loop panel ends with: « Réglages », the quote's route, « Étapes ». */
import type { ReactNode } from 'react'
import { AGGREGATORS, type AggregatorChoice } from '../../../config'
import { SLIPPAGES, slippageNote, type SlippageBps } from '../../../domain/slippage'
import type { Quote } from '../../../services/quotes/quotes'
import { fmtBps } from '../../../ui/format'
import { Fold, Segmented, Steps, aggregatorLabel } from '../../../ui/primitives'

/** « Réglages »: aggregator and slippage in the header (then the panel's own `extras`), the fields inside. */
export function SettingsFold(p: {
  aggregator: AggregatorChoice
  slippage: SlippageBps
  auto: Parameters<typeof slippageNote>[0]
  extras?: (string | false | undefined)[]
  children: ReactNode
}) {
  const parts = [`${aggregatorLabel(p.aggregator)} · slippage ${fmtBps(p.slippage)}${slippageNote(p.auto)}`, ...(p.extras ?? []).filter(Boolean)]
  return (
    <Fold title="Réglages" value={parts.join(' · ')}>
      {p.children}
    </Fold>
  )
}

export function SlippageField({ slippage, setSlippage }: { slippage: SlippageBps; setSlippage: (s: SlippageBps) => void }) {
  return (
    <div className="field">
      <span>Slippage max</span>
      <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtBps(s) }))} />
    </div>
  )
}

/** The legs of a routed quote (aggregator then Pendle, say), nothing for a single swap. */
export function QuoteRoute({ quote: q }: { quote: Quote }) {
  if (!q.route) return null
  return (
    <p className="small">
      Route : {q.route.map((l) => `${l.sell.symbol} → ${l.buy.symbol} (${l.via === 'pendle' ? 'Pendle' : AGGREGATORS[l.via].label})`).join(', ')}.
    </p>
  )
}

/** « Étapes »: what the wallet will be asked, one confirmation for a batch. */
export function StepsFold({ steps, batch, children }: { steps: { label: string }[]; batch: boolean; children?: ReactNode }) {
  return (
    <Fold title="Étapes" value={batch ? 'une seule confirmation' : `${steps.length} étape${steps.length > 1 ? 's' : ''}`}>
      <Steps steps={steps} />
      {children}
    </Fold>
  )
}
