import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { DEMO } from '../../config'
import { aaveLegKey, readAaveSeriesBatch, type AaveSeriesLeg } from '../../protocols/aave/rateSeries'
import { morphoSeriesKey, readMorphoBorrowBatch } from '../../protocols/morpho/rateSeries'
import { sparkSeries, type RatePoint } from '../../domain/apyHistory'

/** Where a Scanner line's rate history is read: Aave's API (official markets only) or Morpho's. */
export type SeriesSource =
  { kind: 'aave'; chainId: number; pool: Address; collateral: Address; debt: Address } | { kind: 'morpho'; chainId: number; marketId: string }

const legs = (s: Extract<SeriesSource, { kind: 'aave' }>): [AaveSeriesLeg, AaveSeriesLeg] => [
  { chainId: s.chainId, pool: s.pool, token: s.collateral, side: 'supply' },
  { chainId: s.chainId, pool: s.pool, token: s.debt, side: 'borrow' },
]

/**
 * 30-day mini-curves of the shown lines (J3), two requests whatever their number (one per API). `lines` gives each
 * line's source, leverage and today's APY; the answer maps a line key to its points (absent = no history).
 */
export function useSparklines(lines: { key: string; series?: SeriesSource; leverage: number; apy: number }[]) {
  const sources = lines.flatMap((l) => (l.series ? [l.series] : []))
  const aave = sources.flatMap((s) => (s.kind === 'aave' ? legs(s) : []))
  const morpho = sources.flatMap((s) => (s.kind === 'morpho' ? [s] : []))
  const aaveKeys = [...new Set(aave.map(aaveLegKey))].sort()
  const morphoKeys = [...new Set(morpho.map(morphoSeriesKey))].sort()
  const a = useQuery({
    queryKey: ['aaveSparks', ...aaveKeys],
    queryFn: ({ signal }) => readAaveSeriesBatch(aave, signal),
    enabled: !DEMO && aaveKeys.length > 0,
    staleTime: 3 * 3_600_000,
    retry: 1,
    placeholderData: (prev) => prev,
  })
  const m = useQuery({
    queryKey: ['morphoSparks', ...morphoKeys],
    queryFn: ({ signal }) => readMorphoBorrowBatch([...new Map(morpho.map((x) => [morphoSeriesKey(x), x])).values()], signal),
    enabled: !DEMO && morphoKeys.length > 0,
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
  return { points: out, failed: { aave: a.isError, morpho: m.isError } }
}
