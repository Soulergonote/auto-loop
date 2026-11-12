/**
 * Scanner with an amount: what a pair earns a year on that capital, and how long until the one-off costs are paid.
 * Costs are estimated without quoting (the Boucle quotes them): the entry and exit swaps of the borrowed amount, each
 * at a typical cost for the kind of pair (the default slippage: 0,05 % between stablecoins, 0,1 % correlated, 0,3 %
 * otherwise or through Pendle).
 */
import { defaultSlippage, type PairKind } from '../../domain/slippage'

/** entry and exit swaps of (leverage − 1) × capital, in USD */
export function estimatedRoundTripUsd(kind: PairKind, leverage: number, equityUsd: number): number {
  const bps = Number(defaultSlippage(kind))
  return (2 * (leverage - 1) * equityUsd * bps) / 10_000
}

export const gainPerYearUsd = (apy: number, equityUsd: number) => apy * equityUsd

/** days of yield that pay the costs; undefined when the loop does not earn */
export function paybackDays(costUsd: number, apy: number, equityUsd: number): number | undefined {
  const perDay = (apy * equityUsd) / 365
  return perDay > 0 ? costUsd / perDay : undefined
}

/** amount typed in the Scanner (« 25 000 », « 25k », « 1,5 M »), USD; undefined when empty or unreadable */
export function parseAmountUsd(text: string): number | undefined {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[\s  $]/g, '')
    .replace(',', '.')
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t)
  if (!m) return undefined
  const v = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1)
  return v > 0 ? v : undefined
}
