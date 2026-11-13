/**
 * Price history of tokens from DefiLlama (coins.llama.fi/chart, every chain of the app, CORS open, no key), for the
 * risk signals (domain/riskSignals.ts). A token DefiLlama does not price is left out.
 */
import { LLAMA_CHAIN } from '../config'
import type { PricePoint } from '../domain/riskSignals'
import { tokenKey, type TokenRef } from './yield/copies'

/** DefiLlama answers at most this many points per request, all coins together */
const MAX_POINTS = 500
const CONCURRENCY = 6

export type ChartOptions = { days: number; period: '6h' | '1d' }

/** Prices over the last `days`, one point per `period`, by `chainId:address`. */
export async function fetchPriceCharts(tokens: TokenRef[], { days, period }: ChartOptions, signal?: AbortSignal): Promise<Map<string, PricePoint[]>> {
  const out = new Map<string, PricePoint[]>()
  const named = [...new Map(tokens.filter((t) => LLAMA_CHAIN[t.chainId]).map((t) => [tokenKey(t), t])).values()]
  const span = Math.ceil((days * 24) / (period === '6h' ? 6 : 24))
  const size = Math.max(1, Math.floor(MAX_POINTS / span))
  const batches: TokenRef[][] = []
  for (let i = 0; i < named.length; i += size) batches.push(named.slice(i, i + size))
  const one = async (batch: TokenRef[]) => {
    const ids = batch.map((t) => `${LLAMA_CHAIN[t.chainId]}:${t.address.toLowerCase()}`)
    const res = await fetch(`https://coins.llama.fi/chart/${ids.join(',')}?span=${span}&period=${period}`, { signal }).catch(() => undefined)
    if (!res?.ok) return
    const body = (await res.json()) as { coins?: Record<string, { prices?: PricePoint[] }> }
    batch.forEach((t, i) => {
      const prices = body.coins?.[ids[i]]?.prices
      if (prices?.length) out.set(tokenKey(t), prices)
    })
  }
  // a few requests at a time: the Scanner can need dozens
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
      for (let i = next++; i < batches.length; i = next++) await one(batches[i])
    }),
  )
  return out
}

export const priceChartsQuery = (tokens: TokenRef[], opts: ChartOptions) => ({
  queryKey: ['price-charts', opts.days, opts.period, tokens.map(tokenKey).sort()],
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchPriceCharts(tokens, opts, signal),
  enabled: tokens.length > 0,
  staleTime: 30 * 60_000,
  retry: 1,
})
