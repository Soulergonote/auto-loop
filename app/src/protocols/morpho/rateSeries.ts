import { useQuery } from '@tanstack/react-query'
import { DAY_MS, type RatePoint } from '../../domain/apyHistory'
import { marketStateHistory, type Lookback, type RestStatePoint } from './api'
import { morphoStateHistoryQuery } from './marketInfo'

const YEAR = 365 * 86_400

/**
 * Borrow rate actually paid each day, from a market's daily totals: the growth of the borrow share's price
 * (total borrow assets / total borrow shares) from one point to the next, compounded to a year. Morpho's REST API
 * only gives smoothed APY averages (30-day windows over 90 days), while this matches the daily rates of the former
 * GraphQL API (within 0.2 point on a USDC market of Ethereum, checked 2026-11-26). Points without debt are skipped.
 */
export function realizedBorrowSeries(points: RestStatePoint[]): RatePoint[] {
  const out: RatePoint[] = []
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp)
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]
    const b = sorted[i]
    const dt = b.timestamp - a.timestamp
    const [sa, sb] = [sharePrice(a), sharePrice(b)]
    if (dt <= 0 || !sa || !sb) continue
    const apy = Math.expm1(Math.log(sb / sa) * (YEAR / dt))
    if (Number.isFinite(apy) && apy >= 0 && apy < 10) out.push({ t: b.timestamp * 1000, v: apy })
  }
  return out
}

/** Loan units per borrow share (scaled to 1e18 shares so that small numbers keep their precision). */
function sharePrice(p: RestStatePoint): number | undefined {
  const shares = BigInt(p.total_borrow_shares)
  const assets = BigInt(p.total_borrow_assets)
  if (shares === 0n || assets === 0n) return undefined
  return Number((assets * 10n ** 36n) / shares) / 1e18
}

const readSeries = (chainId: number, marketId: string, lookback: Lookback, days: number, signal?: AbortSignal, now = Date.now()) =>
  marketStateHistory(chainId, marketId, lookback, signal).then((p) => realizedBorrowSeries(p).filter((x) => x.t >= now - days * DAY_MS))

/**
 * Daily borrow rate of a Morpho Blue market over the last 90 days, for the loop history (I3) and the replay (A1), from the
 * market's 90-day totals shared with its details (marketInfo.ts): one request for both.
 */
export function useMorphoBorrowSeries(chainId: number, marketId: string, enabled = true) {
  return useQuery({
    ...morphoStateHistoryQuery(chainId, marketId, enabled),
    select: (points: RestStatePoint[]) => realizedBorrowSeries(points).filter((x) => x.t >= Date.now() - 91 * DAY_MS),
  })
}

/**
 * Daily borrow rates of several markets over the last 31 days, for the Scanner's mini-curves (J3): one request per
 * market (the REST API has no batch), queued by api.ts. A market that fails is left out; all failing is an error.
 */
export async function readMorphoBorrowBatch(markets: { chainId: number; marketId: string }[], signal?: AbortSignal, now = Date.now()) {
  const out = new Map<string, RatePoint[]>()
  const res = await Promise.allSettled(markets.map((m) => readSeries(m.chainId, m.marketId, 'thirty_days', 31, signal, now)))
  res.forEach((r, i) => r.status === 'fulfilled' && out.set(morphoSeriesKey(markets[i]), r.value))
  if (markets.length && !out.size) throw (res[0] as PromiseRejectedResult).reason
  return out
}
export const morphoSeriesKey = (m: { chainId: number; marketId: string }) => `${m.chainId}:${m.marketId}`.toLowerCase()
