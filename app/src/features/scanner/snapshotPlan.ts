/**
 * What the Scanner reads with every filter open (D1): the same queries, keys and fetchers, so a snapshot taken by
 * GitHub Actions lands in the page's cache exactly where the Scanner looks. Used by the Scanner itself (its lists of
 * markets) and by app/scripts/scanner-snapshot.ts.
 */
import type { QueryKey } from '@tanstack/react-query'
import { AAVE_V4_CHAINS, MARKETS, MORPHO_NETWORKS, aggregatorsFor, getMarket } from '../../config'
import { snapshotQuery } from '../../protocols/aave/snapshot'
import { morphoMarketsQuery, type MorphoMarket } from '../../protocols/morpho/markets'
import { ptInfosQuery } from '../../protocols/pendle/pt'
import { v4ReservesQuery } from '../../protocols/aavev4/reserves'
import { merklQuery, morphoCampaignsQuery } from '../../services/merkl'

/** Markets the app can loop on: an aggregator quotes there. */
export const SCANNABLE = MARKETS.filter((m) => !m.soon && aggregatorsFor(m.chain.id).length > 0)
export const SCANNABLE_MORPHO = MORPHO_NETWORKS.filter((n) => aggregatorsFor(n.chain.id).length > 0)

/** The PT collaterals of a network's listed Morpho markets, in the order the Scanner asks Pendle for them. */
export const ptTokensOf = (list: MorphoMarket[] | undefined) => [
  ...new Set((list ?? []).filter((m) => /^PT-/i.test(m.collateral.symbol)).map((m) => m.collateral.address)),
]

export type SnapshotEntry = { key: QueryKey; data: unknown }

type Query = { queryKey: QueryKey; queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown>; enabled?: boolean }

/** Reads every source; one that fails is left out (the page reads it live). `log` names each failure. */
export async function readScannerSources(signal: AbortSignal, log: (msg: string) => void = () => {}): Promise<SnapshotEntry[]> {
  const out: SnapshotEntry[] = []
  const run = async (q: Query) => {
    if (q.enabled === false) return
    try {
      out.push({ key: q.queryKey, data: await q.queryFn({ signal }) })
    } catch (e) {
      log(`${JSON.stringify(q.queryKey)} : ${(e as Error).message?.split('\n')[0]}`)
    }
  }
  const chains = [...new Set(SCANNABLE.map((m) => m.chain.id))]
  await Promise.all([
    ...SCANNABLE.map((m) => run(snapshotQuery(getMarket(m.id)) as Query)),
    ...chains.map((id) => run(merklQuery(id) as Query)),
    ...SCANNABLE_MORPHO.map((n) => run(morphoCampaignsQuery(n.chain.id) as Query)),
    run(v4ReservesQuery(AAVE_V4_CHAINS) as Query),
    ...SCANNABLE_MORPHO.map(async (n) => {
      const q = morphoMarketsQuery(n.chain.id, false) as Query
      await run(q)
      const list = out.find((e) => e.key === q.queryKey)?.data as MorphoMarket[] | undefined
      const tokens = ptTokensOf(list)
      if (tokens.length) await run(ptInfosQuery(n.chain.id, tokens) as Query)
    }),
  ])
  return out
}
