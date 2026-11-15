import { useQuery } from '@tanstack/react-query'
import { DEMO } from '../../config'
import { DAY_MS, type RatePoint } from '../../domain/apyHistory'
import { gql } from './api'

/** Daily borrow rate of a Morpho Blue market over the last 90 days (Morpho API `historicalState`), for the loop history (I3). */
export async function readMorphoBorrowSeries(chainId: number, marketId: string, signal?: AbortSignal, now = Date.now()): Promise<RatePoint[]> {
  const end = Math.floor(now / 1000)
  const start = end - 91 * (DAY_MS / 1000)
  const data = await gql<{ marketById: { historicalState?: { borrowApy?: { x: number; y: number | null }[] | null } | null } | null }>(
    `query($id: String!, $chainId: Int!, $start: Int!, $end: Int!) { marketById(marketId: $id, chainId: $chainId) { historicalState { borrowApy(options: { startTimestamp: $start, endTimestamp: $end, interval: DAY }) { x y } } } }`,
    { id: marketId, chainId, start, end },
    signal,
  )
  return (data.marketById?.historicalState?.borrowApy ?? []).flatMap((p) => (p.y !== null && Number.isFinite(p.y) ? [{ t: p.x * 1000, v: p.y }] : []))
}

export function useMorphoBorrowSeries(chainId: number, marketId: string, enabled = true) {
  return useQuery({
    queryKey: ['morphoBorrowSeries', chainId, marketId],
    queryFn: ({ signal }) => readMorphoBorrowSeries(chainId, marketId, signal),
    enabled: enabled && !DEMO,
    staleTime: 3 * 3_600_000,
    retry: 1,
  })
}

/** Daily borrow rates of several markets over the last 31 days in one request (one alias each): the Scanner's mini-curves (J3). */
export async function readMorphoBorrowBatch(markets: { chainId: number; marketId: string }[], signal?: AbortSignal, now = Date.now()) {
  const out = new Map<string, RatePoint[]>()
  if (!markets.length) return out
  const end = Math.floor(now / 1000)
  const start = end - 31 * (DAY_MS / 1000)
  const fields = markets.map(
    (m, i) =>
      `m${i}: marketById(marketId: "${m.marketId}", chainId: ${m.chainId}) { historicalState { borrowApy(options: { startTimestamp: ${start}, endTimestamp: ${end}, interval: DAY }) { x y } } }`,
  )
  type Answer = Record<string, { historicalState?: { borrowApy?: { x: number; y: number | null }[] | null } | null } | null>
  const data = await gql<Answer>(`query { ${fields.join(' ')} }`, {}, signal)
  markets.forEach((m, i) =>
    out.set(
      morphoSeriesKey(m),
      (data[`m${i}`]?.historicalState?.borrowApy ?? []).flatMap((p) => (p.y !== null && Number.isFinite(p.y) ? [{ t: p.x * 1000, v: p.y }] : [])),
    ),
  )
  return out
}
export const morphoSeriesKey = (m: { chainId: number; marketId: string }) => `${m.chainId}:${m.marketId}`.toLowerCase()
