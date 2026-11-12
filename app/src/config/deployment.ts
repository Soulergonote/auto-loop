import { getAddress, type Address } from 'viem'
import { AGGREGATORS, aggregatorsFor, type AggregatorId } from './aggregators'
import { MORPHO_BLUE } from './morpho'
import { PENDLE_ROUTER, pendleChain } from './pendle'

/** Free flash lenders a new executor registers on a chain (kind 1 = Morpho), fixed for good like the routers. */
export function executorLenders(chainId: number): { kind: number; lender: Address }[] {
  const m = MORPHO_BLUE[chainId]
  return m ? [{ kind: 1, lender: getAddress(m) }] : []
}

/** Routers a new executor whitelists on a chain (fixed for good): the aggregators that quote there, and Pendle's where PT loops are offered. */
export function executorRouters(chainId: number): { id: AggregatorId | 'pendle'; label: string; router: Address }[] {
  const seen = new Set<string>()
  const aggregators = aggregatorsFor(chainId).map((id) => ({ id, label: AGGREGATORS[id].label, router: getAddress(AGGREGATORS[id].router) }))
  const pendle = pendleChain(chainId) ? [{ id: 'pendle' as const, label: 'Pendle', router: getAddress(PENDLE_ROUTER) }] : []
  return [...aggregators, ...pendle].filter((r) => !seen.has(r.router) && !!seen.add(r.router))
}
