/**
 * What the Morpho GraphQL API told about one market and its REST API no longer does in a list, read for the market
 * open in the Boucle only (one request or one multicall each):
 * - collateral deposited: the last daily point of /state/history (the same request as the 90-day rate history);
 * - losses: a drop of the supply share's price (total supply assets / shares), which only bad debt causes (interest
 *   and fees only raise it), replacing the API's bad debt warnings;
 * - the oracle: made by Morpho's MorphoChainlinkOracleV2 factory, else shaped like Morpho's Chainlink oracles
 *   (BASE_FEED_1 and SCALE_FACTOR answer), else unknown, replacing the API's oracle type.
 */
import { useQuery } from '@tanstack/react-query'
import { readContracts } from '@wagmi/core'
import { parseAbi, type Address } from 'viem'
import { wagmiConfig } from '../../chain/wagmi'
import { DEMO } from '../../config'
import { marketStateHistory, type RestStatePoint } from './api'

/** The 90-day daily totals of a market, shared by the rate history (rateSeries.ts) and the market's details. */
export const morphoStateHistoryQuery = (chainId: number, marketId: string, enabled = true) => ({
  queryKey: ['morphoStateHistory', chainId, marketId.toLowerCase()],
  queryFn: ({ signal }: { signal?: AbortSignal }) => marketStateHistory(chainId, marketId, 'ninety_days', signal),
  enabled: enabled && !DEMO,
  staleTime: 3 * 3_600_000,
  retry: 1,
})

/** Collateral deposited at the last point, in collateral units (undefined without a point). */
export function lastCollateral(points: RestStatePoint[]): bigint | undefined {
  const last = [...points].sort((a, b) => a.timestamp - b.timestamp).at(-1)
  return last?.total_collateral_assets !== undefined ? BigInt(last.total_collateral_assets) : undefined
}

export type SupplyLoss = {
  /** unix seconds of the point after the drop */ at: number
  /** loan units lost by lenders */ assets: bigint
  /** fall of the share price */ share: number
}

/** price drops under this are rounding, not a loss */
const LOSS_TOLERANCE = 1e-6

/** Days the supply share's price fell (bad debt realized), oldest first. Pure, tested. */
export function supplyLosses(points: RestStatePoint[]): SupplyLoss[] {
  const p = [...points].sort((a, b) => a.timestamp - b.timestamp)
  const out: SupplyLoss[] = []
  const price = (x: RestStatePoint) => {
    const shares = BigInt(x.total_supply_shares)
    return shares > 0n ? Number((BigInt(x.total_supply_assets) * 10n ** 36n) / shares) / 1e18 : undefined
  }
  for (let i = 1; i < p.length; i++) {
    const a = price(p[i - 1])
    const b = price(p[i])
    if (!a || !b || b >= a * (1 - LOSS_TOLERANCE)) continue
    const shares = BigInt(p[i].total_supply_shares)
    out.push({ at: p[i].timestamp, share: 1 - b / a, assets: BigInt(Math.round(((a - b) * Number(shares)) / 1e18)) })
  }
  return out
}

/**
 * MorphoChainlinkOracleV2 factory per chain, from Morpho's address list (morpho-org/sdks, morpho-ts addresses.ts,
 * 2026-11-26).
 */
export const MORPHO_ORACLE_FACTORY: Record<number, Address> = {
  1: '0x3A7bB36Ee3f3eE32A60e9f2b33c1e5f2E83ad766',
  8453: '0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d',
  137: '0x1ff7895Eb842794c5d07C4c547b6730e61295215',
  42161: '0x98Ce5D183DC0c176f54D37162F87e7eD7f2E41b5',
  10: '0x1ec408D4131686f727F3Fd6245CF85Bc5c9DAD70',
  130: '0x43269546e1D586a1f7200a0AC07e26f9631f7539',
  999: '0xeb476f124FaD625178759d13557A72394A6f9aF5',
  143: '0xC8659Bcd5279DB664Be973aEFd752a5326653739',
  5042: '0xbFc8D6167a02889D5EB08a023d9aB712B44f7dE8',
  4326: '0x02522D475E7064E1d1E966e3197db050b19b2FC2',
  4663: '0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2',
}

export type OracleKind = 'factory' | 'chainlink' | 'unknown'

const oracleAbi = parseAbi([
  'function isMorphoChainlinkOracleV2(address) view returns (bool)',
  'function BASE_FEED_1() view returns (address)',
  'function SCALE_FACTOR() view returns (uint256)',
])

export async function readOracleKind(chainId: number, oracle: Address): Promise<OracleKind> {
  const factory = MORPHO_ORACLE_FACTORY[chainId]
  const r = await readContracts(wagmiConfig, {
    contracts: [
      ...(factory ? [{ chainId, address: factory, abi: oracleAbi, functionName: 'isMorphoChainlinkOracleV2', args: [oracle] } as const] : []),
      { chainId, address: oracle, abi: oracleAbi, functionName: 'BASE_FEED_1' } as const,
      { chainId, address: oracle, abi: oracleAbi, functionName: 'SCALE_FACTOR' } as const,
    ] as never,
    allowFailure: true,
  })
  const res = r as { status: string; result?: unknown }[]
  const off = factory ? 1 : 0
  if (factory && res[0].result === true) return 'factory'
  return res[off].status === 'success' && res[off + 1].status === 'success' ? 'chainlink' : 'unknown'
}

export const oracleKindQuery = (chainId: number, oracle: Address | undefined) => ({
  queryKey: ['morphoOracleKind', chainId, oracle],
  queryFn: () => readOracleKind(chainId, oracle!),
  enabled: !!oracle && !DEMO,
  staleTime: Infinity,
  retry: 1,
})

export const ORACLE_KIND_TEXT: Record<OracleKind, string> = {
  factory: 'Chainlink, factory Morpho',
  chainlink: 'format Chainlink de Morpho',
  unknown: 'type inconnu',
}

export const useOracleKind = (chainId: number, oracle: Address | undefined) => useQuery(oracleKindQuery(chainId, oracle))
