/** Fields and tiles the Aave and Morpho « Ouvrir » panels share. */
import type { ReactNode } from 'react'
import { HORIZONS } from '../../../domain/economics'
import { SLIPPAGES, type SlippageBps } from '../../../domain/slippage'
import { fmtAmount, fmtBps, fmtDate, fmtDays, fmtDollars, fmtPct } from '../../../ui/format'
import { Metric, NA, Segmented } from '../../../ui/primitives'
import { apyTone } from '../../../ui/tone'

/** Shares of the wallet balance offered as one-tap amounts; the whole balance is « Max ». */
const SHARES = [25, 50] as const

/** An amount as the input expects it: no grouping spaces, a dot, at most 8 decimals. */
const inputText = (amount: bigint, decimals: number) => fmtAmount(amount, decimals, 8).replace(/\s/g, '').replace(',', '.')

/**
 * Capital amount with the wallet balance as a shortcut (the whole balance, or 25 / 50 / 100 % of it), an optional token
 * choice, and its value in dollars.
 */
export function CapitalField(p: {
  label: ReactNode
  balance?: bigint
  decimals: number
  amountText: string
  setAmountText: (s: string) => void
  /** the token choice, when there is one, on the right of the number */
  tokenSelect?: ReactNode
  /** the token, shown inside the field when there is no choice */
  symbol?: string
  /** value of the amount in dollars, once it parses */
  usd?: string
  /** a line under the field (the gas reserve of a native capital) */
  note?: string
}) {
  const balance = p.balance
  const set = (share: bigint) => balance !== undefined && p.setAmountText(inputText((balance * share) / 100n, p.decimals))
  return (
    <div className="field">
      <span>{p.label}</span>
      {/* the number on the left, the token on the right inside the field */}
      <div className="inputrow amount-row">
        <input aria-label="Montant du capital" inputMode="decimal" value={p.amountText} onChange={(e) => p.setAmountText(e.target.value)} />
        {p.tokenSelect || (p.symbol && <span className="amount-unit">{p.symbol}</span>)}
      </div>
      <div className="amount-foot">
        <span className="muted small">{p.usd !== undefined ? `≈ ${p.usd}` : ''}</span>
        {balance !== undefined && (
          <span className="shares" role="group" aria-label="Part du solde">
            <span className="muted small">solde {fmtAmount(balance, p.decimals)}</span>
            {balance > 0n &&
              SHARES.map((share) => (
                <button key={share} type="button" className="chip" onClick={() => set(BigInt(share))}>
                  {share} %
                </button>
              ))}
            {balance > 0n && (
              <button type="button" className="chip" onClick={() => set(100n)}>
                Max
              </button>
            )}
          </span>
        )}
      </div>
      {p.note && <span className="muted small">{p.note}</span>}
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
