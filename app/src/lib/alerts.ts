/**
 * Alerts on open positions: health factor under the amber threshold, net APY below zero, counted Merkl campaign
 * ending soon. Pure functions over what the positions dashboard already computes, so the daily check
 * (scripts/alerts.ts) says exactly what the Positions screen shows.
 */
import { daysLeft } from './merkl'
import type { PositionSummary } from './positions'
import { fmtDate, fmtHf, fmtPct } from './format'
import { hfThresholds, hfTone } from './tone'

export type AlertKind = 'hf' | 'apy' | 'merkl'

export type Alert = {
  kind: AlertKind
  /** bad: red on the Positions screen, warn: amber */
  level: 'bad' | 'warn'
  market: string
  text: string
}

/** Same window as the amber banner of the Positions screen. */
export const MERKL_ENDING_DAYS = 7

export type PositionInput = {
  market: string
  summary: PositionSummary
  healthFactor: number
  correlated: boolean
}

export function positionAlerts({ market, summary: s, healthFactor, correlated }: PositionInput, nowMs = Date.now()): Alert[] {
  const out: Alert[] = []
  if (s.debtBase > 0n) {
    const tone = hfTone(healthFactor, correlated)
    if (tone === 'bad' || tone === 'warn') {
      const { bad, ok } = hfThresholds(correlated)
      const limit = fmtHf(tone === 'bad' ? bad : ok)
      out.push({
        kind: 'hf',
        level: tone,
        market,
        text: `Health factor ${fmtHf(healthFactor)}, sous ${limit}${correlated ? ' (paire corrélée)' : ''}. Réduire le levier ou ajouter du collatéral.`,
      })
    }
  }
  if (Number.isFinite(s.apy) && s.apy < 0) {
    out.push({ kind: 'apy', level: 'bad', market, text: `APY net ${fmtPct(s.apy)} : la position perd de l’argent. Réduire ou fermer la boucle.` })
  }
  for (const c of s.campaigns) {
    if (c.apy <= 0 || c.campaign.endsAt === undefined) continue
    const left = daysLeft(c.campaign, nowMs)
    if (left <= 0 || left >= MERKL_ENDING_DAYS) continue
    out.push({
      kind: 'merkl',
      level: 'warn',
      market,
      text: `Campagne Merkl « ${c.campaign.name} » : fin le ${fmtDate(c.campaign.endsAt, new Date(nowMs))} (${Math.floor(left)} j). Sans renouvellement, l’APY tombe à ${fmtPct(s.apy - c.apy)}.`,
    })
  }
  return out
}

/** Plain-text report: one line per alert, red ones first, then the networks that could not be read. */
export function alertReport(alerts: Alert[], unreadable: string[]): string {
  const lines = [...alerts]
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1))
    .map((a) => `${a.level === 'bad' ? '🔴' : '🟠'} ${a.market} : ${a.text}`)
  if (lines.length === 0) lines.push('Aucune alerte.')
  if (unreadable.length > 0) lines.push(`Non lus : ${unreadable.join(', ')} (RPC qui ne répond pas).`)
  return lines.join('\n')
}
