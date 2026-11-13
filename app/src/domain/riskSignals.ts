/**
 * Risk signals of a pair (I4): facts, each with its colour, never a global score.
 *
 * - gap (« Marché / oracle »): the market price of the collateral against the debt (DefiLlama) compared with the oracle's: a collateral the
 *   market values below its oracle is lost at the exit even without liquidation;
 * - depeg: the largest fall of the collateral / debt price ratio over 90 days (DefiLlama), from its running peak;
 * - exit: what selling the collateral back to repay the whole debt loses today, at the oracle price (quote at the
 *   position's size, exitCheck.ts);
 * - concentration (Morpho): share of the market's debt held by its largest borrower, whose exit moves the rate.
 */
import { fmtPct } from '../ui/format'
import type { Tone } from '../ui/tone'

export type PricePoint = { timestamp: number; price: number }
export type RiskSignalKey = 'gap' | 'depeg' | 'exit' | 'concentration'
export type RiskSignal = { key: RiskSignalKey; label: string; value: string; tone: Tone; detail: string }

/** thresholds, as fractions: [amber from, red from]. An uncorrelated pair's oracle lags the market by its deviation threshold (0.5 % to 1 % for Chainlink) */
export const GAP_LIMITS = { correlated: [0.005, 0.02], uncorrelated: [0.01, 0.03] } as const
/** a correlated pair is meant not to move: a fall of 1 % is already a fact worth seeing */
export const DEPEG_LIMITS = { correlated: [0.01, 0.05], uncorrelated: [0.2, 0.4] } as const
export const EXIT_LIMITS = [0.005, 0.02] as const
export const CONCENTRATION_LIMITS = [0.3, 0.6] as const

const toneOf = (x: number, [warn, bad]: readonly [number, number]): Tone => (x >= bad ? 'bad' : x >= warn ? 'warn' : 'good')

/**
 * Price of `a` in `b` at each point of `a`, `b` taken at its closest point within `maxGap` seconds (DefiLlama gives
 * both on the same grid, give or take a few minutes).
 */
export function ratioSeries(a: PricePoint[], b: PricePoint[], maxGap = 3 * 3600): number[] {
  const out: number[] = []
  let j = 0
  for (const p of a) {
    while (j + 1 < b.length && Math.abs(b[j + 1].timestamp - p.timestamp) <= Math.abs(b[j].timestamp - p.timestamp)) j++
    const q = b[j]
    if (q && Math.abs(q.timestamp - p.timestamp) <= maxGap && q.price > 0 && p.price > 0) out.push(p.price / q.price)
  }
  return out
}

/** Largest fall from a running peak, as a fraction (0 for a series that only rises). */
export function maxDrawdown(series: number[]): number {
  let peak = 0
  let worst = 0
  for (const x of series) {
    if (x > peak) peak = x
    else if (peak > 0) worst = Math.max(worst, 1 - x / peak)
  }
  return worst
}

export const depegTone = (drawdown: number, correlated: boolean) => toneOf(drawdown, DEPEG_LIMITS[correlated ? 'correlated' : 'uncorrelated'])

export type RiskInputs = {
  collateral: string
  debt: string
  correlated: boolean
  /** collateral price in debt units, at the oracle and at the market */
  oracleRatio?: number
  marketRatio?: number
  /** largest fall of the ratio over the window, and the window in days */
  drawdown?: number
  days?: number
  /** exit swap loss at the oracle price, fraction; noRoute when nothing quotes it */
  exitLoss?: number
  exitNoRoute?: boolean
  /** largest borrower's share of the market's debt; mine when it is the connected address */
  topBorrower?: { share: number; mine: boolean }
}

/** The signals that could be read, in a fixed order. */
export function riskSignals(r: RiskInputs): RiskSignal[] {
  const out: RiskSignal[] = []
  if (r.oracleRatio && r.marketRatio && r.oracleRatio > 0) {
    const gap = r.marketRatio / r.oracleRatio - 1
    out.push({
      key: 'gap',
      label: 'Marché / oracle',
      value: Math.abs(gap) < 0.0005 ? 'aucun' : `${gap < 0 ? '−' : '+'}${fmtPct(Math.abs(gap))}`,
      // only a market below the oracle costs: the exit sells at the market
      tone: gap < 0 ? toneOf(-gap, GAP_LIMITS[r.correlated ? 'correlated' : 'uncorrelated']) : 'good',
      detail:
        gap < -0.0005
          ? `Le marché paie ${r.collateral} ${fmtPct(-gap)} sous le prix de l’oracle : perdu à la sortie, même sans liquidation.`
          : `Le marché paie ${r.collateral} au prix de l’oracle ou au-dessus.`,
    })
  }
  if (r.drawdown !== undefined) {
    out.push({
      key: 'depeg',
      label: r.correlated ? 'Découplage passé' : 'Plus forte baisse',
      value: r.drawdown < 0.0005 ? 'aucun' : `−${fmtPct(r.drawdown)}`,
      tone: depegTone(r.drawdown, r.correlated),
      detail: `Plus forte baisse de ${r.collateral} face à ${r.debt} sur ${r.days ?? 90} j, au prix de marché (cours toutes les 6 h).`,
    })
  }
  if (r.exitNoRoute || r.exitLoss !== undefined) {
    out.push({
      key: 'exit',
      label: 'Sortie',
      value: r.exitNoRoute ? 'aucune route' : `−${fmtPct(Math.max(0, r.exitLoss!))}`,
      tone: r.exitNoRoute ? 'bad' : toneOf(Math.max(0, r.exitLoss!), EXIT_LIMITS),
      detail: r.exitNoRoute
        ? `Aucun agrégateur ne revend ${r.collateral} contre ${r.debt} à la taille de la dette.`
        : `Revendre ${r.collateral} pour rembourser toute la dette perd ${fmtPct(Math.max(0, r.exitLoss!))} au prix de l’oracle, à la taille de la position.`,
    })
  }
  if (r.topBorrower) {
    out.push({
      key: 'concentration',
      label: 'Concentration',
      value: fmtPct(r.topBorrower.share, 0),
      tone: r.topBorrower.mine ? 'good' : toneOf(r.topBorrower.share, CONCENTRATION_LIMITS),
      detail: r.topBorrower.mine
        ? 'Part de la dette du marché tenue par le plus gros emprunteur, qui est l’adresse connectée.'
        : 'Part de la dette du marché tenue par le plus gros emprunteur : son départ ou son arrivée déplace le taux.',
    })
  }
  return out
}
