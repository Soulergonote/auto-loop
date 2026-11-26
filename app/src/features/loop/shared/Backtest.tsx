import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import type { RatePoint } from '../../../domain/apyHistory'
import { BACKTEST_DAYS, backtest, priceRatio } from '../../../domain/backtest'
import { priceChartsQuery } from '../../../services/priceHistory'
import { tokenKey } from '../../../services/yield/copies'
import { LineChart } from '../../../ui/LineChart'
import { Metric, Skel } from '../../../ui/primitives'
import { fmtDate, fmtDollars, fmtHf, fmtPct, fmtX } from '../../../ui/format'
import { apyTone, hfTone } from '../../../ui/tone'
import { SIGNAL_DAYS } from './RiskSignals'

/** the pair and the loop to replay; the rates come from the history above it */
export type ReplayPair = {
  chainId: number
  collateral: { address: Address; symbol: string }
  debt: { address: Address; symbol: string }
  /** fraction (0.95) */
  liquidationThreshold: number
  correlated: boolean
  /** the capital typed, in dollars; 10 000 $ when none */
  capitalUsd?: number
}

const DEFAULT_CAPITAL = 10_000
const fmtDay = (t: number) => fmtDate(t / 1000)

/**
 * « Rejouer sur 90 j » (A1): the loop opened 90 days ago at today's leverage and left alone, with each day's rates
 * and market price. Read on demand: the prices are the risk signals' (same 90-day, 6-hour query, often cached).
 */
export function Backtest({ pair, borrow, supply, leverage }: { pair: ReplayPair; borrow: RatePoint[]; supply?: RatePoint[]; leverage: number }) {
  const [on, setOn] = useState(false)
  const c = { chainId: pair.chainId, address: pair.collateral.address }
  const d = { chainId: pair.chainId, address: pair.debt.address }
  const charts = useQuery({ ...priceChartsQuery([c, d], { days: SIGNAL_DAYS, period: '6h' }), enabled: on })
  if (!on)
    return (
      <div className="actions">
        <button type="button" className="btn small" onClick={() => setOn(true)}>
          Rejouer sur {BACKTEST_DAYS} j
        </button>
        <span className="muted small">la boucle ouverte il y a {BACKTEST_DAYS} jours à ce levier, taux et prix de chaque jour</span>
      </div>
    )
  if (charts.isPending) return <Skel w={20} />
  const a = charts.data?.get(tokenKey(c))
  const b = charts.data?.get(tokenKey(d))
  const capitalUsd = pair.capitalUsd && pair.capitalUsd > 0 ? pair.capitalUsd : DEFAULT_CAPITAL
  const r = a && b ? backtest({ borrow, supply, ratio: priceRatio(a, b), leverage, liquidationThreshold: pair.liquidationThreshold, capitalUsd }) : undefined
  if (!r)
    return (
      <p className="small muted">
        Rejeu impossible :{' '}
        {charts.isError
          ? 'DefiLlama injoignable'
          : !a || !b
            ? `pas de prix historique pour ${!a ? pair.collateral.symbol : pair.debt.symbol} sur DefiLlama`
            : 'moins de 7 jours de données'}
        .
      </p>
    )
  const liquidated = r.liquidatedAt !== undefined
  return (
    <div className="backtest">
      <div className="apy-detail-title">
        Rejeu du {fmtDay(r.start)} au {fmtDay(r.end)} · {fmtDollars(capitalUsd, true)} à {fmtX(leverage)}
      </div>
      <div className="metrics">
        <Metric label="Gain net" value={fmtDollars(r.gainUsd)} tone={r.gainUsd < 0 ? 'bad' : 'good'} sub={`sur ${r.days} j`} />
        <Metric label="APY réalisé" value={fmtPct(r.apy)} tone={apyTone(r.apy)} />
        <Metric label="HF le plus bas" value={fmtHf(r.minHf.v)} tone={hfTone(r.minHf.v, pair.correlated)} sub={`le ${fmtDay(r.minHf.t)}`} />
        <Metric
          label={liquidated ? 'Liquidée' : 'HF final'}
          value={liquidated ? `le ${fmtDay(r.liquidatedAt!)}` : fmtHf(r.finalHf)}
          tone={liquidated ? 'bad' : hfTone(r.finalHf, pair.correlated)}
        />
      </div>
      <LineChart
        points={r.hf}
        format={(v) => fmtHf(v)}
        formatX={fmtDay}
        tone={(v) => hfTone(v, pair.correlated)}
        label={`Health factor de la boucle rejouée, par jour, sur ${r.days} jours`}
        reference={{ value: 1, label: 'liquidation', tone: 'bad' }}
      />
      <p className="small muted">
        Ouverte le {fmtDay(r.start)} puis laissée telle quelle : chaque jour, la dette grossit au taux d’emprunt du jour
        {supply ? ', le collatéral au taux de dépôt du jour' : ''}, et le collatéral vaut son prix de marché en {pair.debt.symbol} (DefiLlama, rendement propre
        du token compris). Health factor au prix du marché : un oracle fixé sur un taux de change peut lire plus haut. Gain mesuré en {pair.debt.symbol}
        {liquidated ? ', arrêté à la liquidation (avant sa pénalité)' : ''}. Non comptés : Merkl, coûts d’entrée et de sortie.
      </p>
    </div>
  )
}
