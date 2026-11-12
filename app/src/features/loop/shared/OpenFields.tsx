/** Fields and tiles the Aave and Morpho « Ouvrir » panels share. */
import type { ReactNode } from 'react'
import { HORIZONS } from '../../../domain/economics'
import { SLIPPAGES, type SlippageBps } from '../../../domain/slippage'
import { fmtAmount, fmtBps, fmtDate, fmtDays, fmtDollars, fmtPct } from '../../../ui/format'
import { Metric, NA, Segmented } from '../../../ui/primitives'
import { apyTone } from '../../../ui/tone'

/** Capital amount with the wallet balance as a shortcut, an optional token choice, and its value in dollars. */
export function CapitalField(p: {
  label: ReactNode
  balance?: bigint
  decimals: number
  amountText: string
  setAmountText: (s: string) => void
  /** the token choice, when there is one */
  tokenSelect?: ReactNode
  /** value of the amount in dollars, once it parses */
  usd?: string
}) {
  return (
    <div className="field">
      <span>
        {p.label}
        {p.balance !== undefined && (
          <button className="link" onClick={() => p.setAmountText(fmtAmount(p.balance!, p.decimals, 8).replace(/\s/g, '').replace(',', '.'))}>
            solde {fmtAmount(p.balance, p.decimals)}
          </button>
        )}
      </span>
      <div className="inputrow">
        {p.tokenSelect}
        <input aria-label="Montant du capital" inputMode="decimal" value={p.amountText} onChange={(e) => p.setAmountText(e.target.value)} />
      </div>
      {p.usd !== undefined && <span className="muted small">≈ {p.usd}</span>}
    </div>
  )
}

/**
 * Yield tiles: fixed APY and maturity for a PT, otherwise days to break even and the gain over the planned duration.
 * `unreal`: the position cannot be opened as set, so no figure is shown.
 */
export function YieldMetrics(p: {
  pt?: { expiry: Parameters<typeof fmtDate>[0] }
  ptExpired: boolean
  ptDays?: number
  fixedApy?: number
  /** what to do with an expired PT, in this protocol's words */
  expiredHint: string
  horizon: number
  horizonYield?: number
  horizonGain?: number
  breakEven?: number
  hasCosts: boolean
  unreal: boolean
}) {
  const { pt, ptExpired, ptDays, horizon, horizonYield, horizonGain, breakEven, hasCosts, unreal } = p
  if (pt)
    return (
      <>
        <Metric
          label="APY fixe"
          value={p.fixedApy !== undefined ? fmtPct(p.fixedApy) : ptExpired ? '—' : undefined}
          sub={ptExpired ? 'PT échu' : `jusqu’au ${fmtDate(pt.expiry)}`}
          tone={apyTone(p.fixedApy)}
        />
        <Metric
          label="Échéance"
          value={ptExpired ? 'échu' : fmtDays(Math.floor(ptDays!))}
          sub={
            ptExpired ? p.expiredHint : horizonYield !== undefined ? `${fmtDate(pt.expiry)} · APY coûts compris ${fmtPct(horizonYield)}` : fmtDate(pt.expiry)
          }
          tone={ptExpired ? 'bad' : ptDays! < 14 ? 'warn' : undefined}
        />
      </>
    )
  return (
    <>
      <Metric
        label="Rentable après"
        value={
          unreal || (hasCosts && breakEven === undefined)
            ? NA
            : breakEven === undefined
              ? undefined
              : Number.isFinite(breakEven)
                ? fmtDays(Math.max(1, Math.ceil(breakEven)))
                : 'jamais'
        }
        sub="coûts d’entrée et de sortie payés"
        tone={breakEven !== undefined && !unreal ? (!Number.isFinite(breakEven) ? 'bad' : breakEven > horizon ? 'warn' : undefined) : undefined}
      />
      <Metric
        label={`Gain sur ${fmtDays(horizon)}`}
        value={unreal || (hasCosts && horizonGain === undefined) ? NA : horizonGain !== undefined ? fmtDollars(horizonGain) : undefined}
        sub={horizonYield !== undefined && !unreal ? `${fmtPct(horizonYield)} par an, coûts compris` : 'coûts compris'}
        tone={apyTone(horizonYield)}
      />
    </>
  )
}

/** Slippage choice and, except for a PT (held to maturity), the planned duration the costs are spread over. */
export function SlippageHorizonFields(p: {
  slippage: SlippageBps
  setSlippage: (s: SlippageBps) => void
  pt: boolean
  horizonText: string
  setHorizon: (s: string) => void
}) {
  return (
    <div className="grid2">
      <div className="field">
        <span>Slippage max</span>
        <Segmented value={p.slippage} onChange={p.setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtBps(s) }))} />
      </div>
      {!p.pt && (
        <div className="field">
          <span>Durée prévue</span>
          <Segmented value={p.horizonText} onChange={p.setHorizon} options={HORIZONS.map((h) => ({ value: String(h), label: fmtDays(h) }))} />
        </div>
      )}
    </div>
  )
}
