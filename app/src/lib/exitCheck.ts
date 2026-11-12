/**
 * Before opening, the way out: the collateral a full close would sell to repay the whole debt is quoted against the
 * debt asset. No route blocks the open (the app could not close the position); a costly exit or a collateral reserve
 * lent out almost entirely (its withdrawal can be blocked at close) only warn. PTs keep their own check (whole
 * position, through the token their SY gives back).
 */
import { fmtPct } from './format'
import { fromBase, type Side } from './math'
import { WARN_SWAP_LOSS } from './economics'

/** margin over the debt: interest accrued and the slippage of the close */
export const EXIT_MARGIN_BPS = 100n
/** above this share of an Aave reserve lent out, withdrawing it at close may have to wait */
export const HIGH_UTILIZATION = 0.98

/** `x` rounded UP to `digits` significant digits: the exit is never quoted smaller than the debt needs */
function roundUpSignificant(x: bigint, digits: number): bigint {
  const len = x.toString().length
  if (len <= digits) return x
  const unit = 10n ** BigInt(len - digits)
  return ((x + unit - 1n) / unit) * unit
}

/** collateral sold by a full close: what repays the whole debt at the oracle price plus the margin, rounded so it does not re-quote at every block */
export function exitSellAmount(debtBase: bigint, collateral: Side): bigint {
  if (debtBase <= 0n) return 0n
  return roundUpSignificant(fromBase((debtBase * (10_000n + EXIT_MARGIN_BPS)) / 10_000n, collateral), 2)
}

export type ExitState = {
  sell: string
  buy: string
  /** the quote failed, or only an oracle-priced stand-in exists (no aggregator route) */
  noRoute: boolean
  reason?: string
  /** value lost by the exit swap at oracle prices, fraction */
  loss?: number
  /** share of the collateral's Aave reserve that is borrowed */
  utilization?: number
}

export function exitIssues(s: ExitState): { problems: string[]; warnings: string[] } {
  const problems: string[] = []
  const warnings: string[] = []
  if (s.noRoute)
    problems.push(
      `Sortie impossible : aucun agrégateur ne revend ${s.sell} contre ${s.buy} pour rembourser cette dette${s.reason ? ` (${s.reason})` : ''}. L’app ne pourrait pas fermer la position.`,
    )
  else if (s.loss !== undefined && s.loss > WARN_SWAP_LOSS)
    warnings.push(
      `Sortie : revendre ${s.sell} contre ${s.buy} pour rembourser la dette perd aujourd’hui ${fmtPct(s.loss, 1)} au prix de l’oracle (coût de fermeture).`,
    )
  if (s.utilization !== undefined && s.utilization >= HIGH_UTILIZATION)
    warnings.push(
      `${s.sell} est emprunté à ${fmtPct(s.utilization, 1)} sur Aave : tant que l’utilisation reste aussi haute, retirer le collatéral à la fermeture peut être bloqué.`,
    )
  return { problems, warnings }
}

/** borrowed share of a reserve, from its totals (base units) */
export const utilization = (totalSupplyBase: bigint, totalDebtBase: bigint) => (totalSupplyBase > 0n ? Number(totalDebtBase) / Number(totalSupplyBase) : 0)
