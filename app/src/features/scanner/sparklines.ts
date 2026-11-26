import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { DEMO } from '../../config'
import { aaveLegKey, readAaveSeriesBatch, type AaveSeriesLeg } from '../../protocols/aave/rateSeries'
import { morphoSeriesKey, readMorphoBorrowBatch } from '../../protocols/morpho/rateSeries'
import { sparkSeries, type RatePoint } from '../../domain/apyHistory'

/** Where a Scanner line's rate history is read: Aave's API (official markets only) or Morpho's. */
export type SeriesSource =
  { kind: 'aave'; chainId: number; pool: Address; collateral: Address; debt: Address } | { kind: 'morpho'; chainId: number; marketId: string }

/**
 * Aliases per request: Aave's API refuses more than 10 top-level aliases (checked 2026-11-26, so 20 lines' 40 legs
 * never got an answer), Morpho's answers HTTP 400 at 40 markets. The Scanner can ask for hundreds of lines (A6).
 */
const CHUNK = 10
const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))
/**
 * Reads by chunks, a few at a time, and merges the answers. A chunk the API refuses (one market it does not know can
 * fail the whole request) leaves its lines without history; only when every chunk fails is it an error.
 */
async function inChunks<T>(xs: T[], read: (part: T[]) => Promise<Map<string, RatePoint[]>>): Promise<Map<string, RatePoint[]>> {
  const out = new Map<string, RatePoint[]>()
  const parts = chunks(xs)
  let failure: unknown
  let failed = 0
  for (let i = 0; i < parts.length; i += 6)
    for (const r of await Promise.allSettled(parts.slice(i, i + 6).map(read)))
      if (r.status === 'fulfilled') r.value.forEach((v, k) => out.set(k, v))
      else [failure, failed] = [r.reason, failed + 1]
  if (parts.length > 0 && failed === parts.length) throw failure
  return out
}

const legs = (s: Extract<SeriesSource, { kind: 'aave' }>): [AaveSeriesLeg, AaveSeriesLeg] => [
  { chainId: s.chainId, pool: s.pool, token: s.collateral, side: 'supply' },
  { chainId: s.chainId, pool: s.pool, token: s.debt, side: 'borrow' },
]

/**
 * 30-day mini-curves of the shown lines (J3), one request per 10 Aave legs and one per Morpho market (all the filtered lines when the
 * Scanner sorts by history, A6). `ready` false holds the reading back (A6: until every network answered, so the
 * whole list is not read again at each arrival). `lines` gives each
 * line's source, leverage and today's APY; the answer maps a line key to its points (absent = no history).
 */
export function useSparklines(lines: { key: string; series?: SeriesSource; leverage: number; apy: number }[], ready = true) {
  const sources = lines.flatMap((l) => (l.series ? [l.series] : []))
  const aave = sources.flatMap((s) => (s.kind === 'aave' ? legs(s) : []))
  const morpho = sources.flatMap((s) => (s.kind === 'morpho' ? [s] : []))
  const aaveKeys = [...new Set(aave.map(aaveLegKey))].sort()
  const morphoKeys = [...new Set(morpho.map(morphoSeriesKey))].sort()
  const a = useQuery({
    queryKey: ['aaveSparks', ...aaveKeys],
    queryFn: ({ signal }) => inChunks([...new Map(aave.map((l) => [aaveLegKey(l), l])).values()], (part) => readAaveSeriesBatch(part, signal)),
    enabled: ready && !DEMO && aaveKeys.length > 0,
    staleTime: 3 * 3_600_000,
    retry: 1,
    placeholderData: (prev) => prev,
  })
  const m = useQuery({
    queryKey: ['morphoSparks', ...morphoKeys],
    queryFn: ({ signal }) => inChunks([...new Map(morpho.map((x) => [morphoSeriesKey(x), x])).values()], (part) => readMorphoBorrowBatch(part, signal)),
    enabled: ready && !DEMO && morphoKeys.length > 0,
    staleTime: 3 * 3_600_000,
    retry: 1,
    placeholderData: (prev) => prev,
  })
  const out = new Map<string, RatePoint[]>()
  for (const l of lines) {
    const s = l.series
    if (!s) continue
    const points =
      s.kind === 'aave'
        ? a.data && sparkSeries(a.data.get(aaveLegKey(legs(s)[1])) ?? [], a.data.get(aaveLegKey(legs(s)[0])) ?? [], l.leverage, l.apy)
        : m.data && sparkSeries(m.data.get(morphoSeriesKey(s)) ?? [], undefined, l.leverage, l.apy)
    if (points?.length) out.set(l.key, points)
  }
  return { points: out, failed: { aave: a.isError, morpho: m.isError }, pending: a.isFetching || m.isFetching }
}
