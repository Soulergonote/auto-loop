/**
 * Overview at the top of Positions (J5): where the net value sits (by network and by protocol) and the real gain of
 * every position added up. Pure, tested.
 */

export type PortfolioPart = { network: string; protocol: string; /** net value, USD */ usd: number }
export type Share = { label: string; usd: number; share: number }

/** Net value grouped by `key`, biggest first; parts worth nothing (or less) are left out, as is a total of zero. */
export function shares(parts: PortfolioPart[], key: 'network' | 'protocol'): Share[] {
  const sums = new Map<string, number>()
  for (const p of parts) if (p.usd > 0) sums.set(p[key], (sums.get(p[key]) ?? 0) + p.usd)
  const total = [...sums.values()].reduce((s, x) => s + x, 0)
  if (total <= 0) return []
  return [...sums].map(([label, usd]) => ({ label, usd, share: usd / total })).sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label))
}

/** What a position's « Gain réel » fold gave: a gain, still reading, or nothing usable (failed, incomplete history). */
export type GainState = { usd: number; since: number } | 'pending' | 'none'

export type TotalGain = { usd: number; since?: number; counted: number; pending: number; positions: number }

/** Sum of the known gains, the earliest opening among them, and how many positions are counted out of `positions`. */
export function totalGain(states: GainState[]): TotalGain {
  let usd = 0
  let since: number | undefined
  let counted = 0
  let pending = 0
  for (const s of states) {
    if (s === 'pending') pending++
    else if (s !== 'none') {
      usd += s.usd
      counted++
      since = since === undefined ? s.since : Math.min(since, s.since)
    }
  }
  return { usd, since, counted, pending, positions: states.length }
}
