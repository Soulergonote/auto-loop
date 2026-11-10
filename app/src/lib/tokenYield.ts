/**
 * Current intrinsic yield of yield-bearing tokens (sUSDe, syrupUSDC, sUSDS, wstETH…), from the freshest source that
 * knows the token. Sources, best first:
 *
 * 1. `rate`: the rate the token's contract publishes (sDAI, sUSDS, stUSDS), read on-chain, see ONCHAIN_RATES.
 * 2. `pendle`: the underlying yield Pendle's API shows for the token when Pendle has a market on it (recent average).
 * 3. `morpho`: the asset yield of Morpho's API (Ethereum tokens mostly).
 *
 * A token missing from every source is looked up again through its copies on other chains (SAME_TOKEN). Callers fall
 * back to their own figure when nothing is found: Aave's CAPO average for Aave reserves (nativeYield.ts).
 *
 * The sources are only read here; adding a token is a line in yieldTokens.ts, adding a source is one reader below
 * plus its place in SOURCE_ORDER.
 */
import { readContracts } from '@wagmi/core'
import { getAddress, isAddress, parseAbi, type Address } from 'viem'
import { pendleChain } from '../config'
import { wagmiConfig } from '../wagmi'
import { gql } from './morphoApi'
import type { NativeYield, YieldSource } from './nativeYield'
import { ONCHAIN_RATES, SAME_TOKEN } from './yieldTokens'

const YEAR = 365 * 86_400
const TTL_MS = 30 * 60_000
const PENDLE_API = 'https://api-v2.pendle.finance/core'

/** What a source found for one token: its yield and, for a published rate, the rate's name (DSR, SSR…). */
export type Found = { apy: number; via?: string }
/** `chainId:address` (lower case) → what the source found. */
export type SourceData = Map<string, Found>
type Sources = Partial<Record<Exclude<YieldSource, 'aave' | 'pt'>, SourceData>>

export const SOURCE_ORDER = ['rate', 'pendle', 'morpho'] as const

export const tokenKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

/** A yield worth showing: a token earning 0 % or over 100 % a year is a missing or broken feed, not a yield. */
export const plausible = (apy: number | undefined): apy is number => apy !== undefined && Number.isFinite(apy) && apy > 0 && apy < 1

/** The token itself first, then its copies on other chains. */
export function tokenCopies(chainId: number, address: string): { chainId: number; address: string }[] {
  const self = { chainId, address: address.toLowerCase() }
  const group = Object.values(SAME_TOKEN).find((g) => g[chainId]?.toLowerCase() === self.address)
  if (!group) return [self]
  const others = Object.entries(group)
    .map(([c, a]) => ({ chainId: Number(c), address: a.toLowerCase() }))
    .filter((t) => t.chainId !== chainId)
  return [self, ...others]
}

/** Best yield for a token from already-read sources: by source order, the token itself before its copies. */
export function pickTokenYield(chainId: number, address: string, sources: Sources): NativeYield | undefined {
  const copies = tokenCopies(chainId, address)
  for (const source of SOURCE_ORDER) {
    for (const t of copies) {
      const f = sources[source]?.get(tokenKey(t.chainId, t.address))
      if (f && plausible(f.apy)) return { apy: f.apy, source, via: f.via, ...(t.chainId !== chainId && { fromChain: t.chainId }) }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Readers. Each one answers with what it could read; a failure is an empty map, never an error.
// ---------------------------------------------------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: Promise<SourceData> }>()
function cached(key: string, read: () => Promise<SourceData>): Promise<SourceData> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = read().catch(() => new Map() as SourceData)
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Per-second ray rate → compounded annual yield. */
export const rayRateToApy = (perSecond: bigint) => Math.expm1(Math.log1p(Number(perSecond - 10n ** 27n) / 1e27) * YEAR)
/** Annual rate compounded daily, how a vault's daily accrual adds up. */
export const aprToApy = (apr: number) => Math.expm1(365 * Math.log1p(apr / 365))

const rateAbi = parseAbi(['function dsr() view returns (uint256)', 'function ssr() view returns (uint256)', 'function str() view returns (uint256)'])

function readOnchainRates(): Promise<SourceData> {
  return cached('rate', async () => {
    const r = await readContracts(wagmiConfig, {
      contracts: ONCHAIN_RATES.map((x) => ({ chainId: x.chainId, address: x.source, abi: rateAbi, functionName: x.fn }) as const),
      allowFailure: true,
    })
    const out: SourceData = new Map()
    ONCHAIN_RATES.forEach((x, i) => {
      const v = r[i].result as bigint | undefined
      if (v !== undefined && v >= 10n ** 27n) out.set(tokenKey(x.chainId, x.token), { apy: rayRateToApy(v), via: x.label })
    })
    return out
  })
}

type PendleMarket = { underlyingAsset?: { address?: string }; underlyingInterestApy?: number; liquidity?: { usd?: number } }

/** Pendle markets → underlying token's yield (interest only, not reward tokens); the deepest market wins for a token. */
export function parsePendleYields(chainId: number, markets: PendleMarket[]): SourceData {
  const best = new Map<string, { apy: number; depth: number }>()
  for (const m of markets) {
    const a = m.underlyingAsset?.address
    const apy = m.underlyingInterestApy
    if (!a || !isAddress(a) || !plausible(apy)) continue
    const k = tokenKey(chainId, a)
    const depth = m.liquidity?.usd ?? 0
    if (!best.has(k) || best.get(k)!.depth < depth) best.set(k, { apy, depth })
  }
  return new Map([...best].map(([k, v]) => [k, { apy: v.apy }]))
}

function readPendleYields(chainId: number): Promise<SourceData> {
  if (!pendleChain(chainId)) return Promise.resolve(new Map())
  return cached(`pendle:${chainId}`, async () => {
    const markets: PendleMarket[] = []
    for (let skip = 0; skip < 1_000; skip += 100) {
      const res = await fetch(`${PENDLE_API}/v1/${chainId}/markets?is_expired=false&limit=100&skip=${skip}`, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) break
      const body = (await res.json()) as { total?: number; results?: PendleMarket[] }
      markets.push(...(body.results ?? []))
      if (!body.results?.length || markets.length >= (body.total ?? 0)) break
    }
    return parsePendleYields(chainId, markets)
  })
}

function readMorphoYields(chainId: number, addresses: string[]): Promise<SourceData> {
  const list = [...new Set(addresses)].sort()
  if (list.length === 0) return Promise.resolve(new Map())
  return cached(`morpho:${chainId}:${list.join(',')}`, async () => {
    const data = await gql<{ assets: { items: { address: string; yield?: { apr?: number | null } | null }[] } }>(
      `query($chain: [Int!], $addresses: [String!]) { assets(first: 1000, where: { chainId_in: $chain, address_in: $addresses }) { items { address yield { apr } } } }`,
      { chain: [chainId], addresses: list.map((a) => getAddress(a)) },
      AbortSignal.timeout(8_000),
    )
    const out: SourceData = new Map()
    for (const a of data.assets.items) {
      const apr = a.yield?.apr
      if (typeof apr === 'number') out.set(tokenKey(chainId, a.address), { apy: aprToApy(apr) })
    }
    return out
  })
}

/** Current intrinsic yields of these tokens, by lower-cased address; tokens no source knows are left out. */
export async function readTokenYields(chainId: number, addresses: readonly Address[]): Promise<Map<string, NativeYield>> {
  const out = new Map<string, NativeYield>()
  if (addresses.length === 0) return out
  // every chain where the tokens or their copies live, with the addresses to ask Morpho about there
  const byChain = new Map<number, string[]>()
  for (const a of addresses) for (const t of tokenCopies(chainId, a)) byChain.set(t.chainId, [...(byChain.get(t.chainId) ?? []), t.address])
  const chains = [...byChain.keys()]
  const [rate, pendle, morpho] = await Promise.all([
    readOnchainRates(),
    Promise.all(chains.map(readPendleYields)),
    Promise.all(chains.map((c) => readMorphoYields(c, byChain.get(c)!))),
  ])
  const merge = (maps: SourceData[]): SourceData => new Map(maps.flatMap((m) => [...m]))
  const sources: Sources = { rate, pendle: merge(pendle), morpho: merge(morpho) }
  for (const a of addresses) {
    const y = pickTokenYield(chainId, a, sources)
    if (y) out.set(a.toLowerCase(), y)
  }
  return out
}
