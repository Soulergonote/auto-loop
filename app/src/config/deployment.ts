import { getAddress, type Address } from 'viem'
import { AGGREGATORS, routerOf, supportsChain, type AggregatorId } from './aggregators'
import { MORPHO_BLUE } from './morpho'
import { PENDLE_ROUTER, pendleChain } from './pendle'

/** Free flash lenders a new executor registers on a chain (kind 1 = Morpho), fixed for good like the routers. */
export function executorLenders(chainId: number): { kind: number; lender: Address }[] {
  const m = MORPHO_BLUE[chainId]
  return m ? [{ kind: 1, lender: getAddress(m) }] : []
}

/**
 * Routers a new executor whitelists on a chain (fixed for good): every aggregator that quotes there, whether or not
 * this build can quote with it (the list, hence the shared contract's address, must not depend on an API key), and
 * Pendle's where PT loops are offered. `without` gives an earlier list (see SHARED_BEFORE).
 */
export function executorRouters(chainId: number, without: AggregatorId[] = []): { id: AggregatorId | 'pendle'; label: string; router: Address }[] {
  const seen = new Set<string>()
  const ids = (Object.keys(AGGREGATORS) as AggregatorId[]).filter((id) => supportsChain(id, chainId) && !without.includes(id))
  const aggregators = ids.map((id) => ({ id, label: AGGREGATORS[id].label, router: routerOf(id, chainId) }))
  const pendle = pendleChain(chainId) ? [{ id: 'pendle' as const, label: 'Pendle', router: getAddress(PENDLE_ROUTER) }] : []
  return [...aggregators, ...pendle].filter((r) => !seen.has(r.router) && !!seen.add(r.router))
}

/**
 * Router lists of earlier shared contracts, newest first: adding an aggregator changes the CREATE2 address, so a
 * shared contract deployed before (same code, fewer routers) is still found at its old address. Before Tycho (2026-11-27).
 */
export const SHARED_BEFORE: AggregatorId[][] = [['tycho']]
