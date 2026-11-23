import { getAddress } from 'viem'
import type { MarketDef } from '../config'

/**
 * Pages of the protocols' own apps, for the small ↗ next to a reserve, a market or a bonus. Formats checked
 * 2026-11-23 on the `depositUrl` of Merkl's opportunities (api.merkl.xyz/v4/opportunities) and Aave's interface
 * (src/ui-config/marketsConfig.tsx, Link.tsx ROUTES.markets). No link where the format is not known (SparkLend).
 */

/** Aave interface `marketName` of each Aave v3 market of config/aave.ts. */
const AAVE_MARKET_NAMES: Record<string, string> = {
  ethereum: 'proto_mainnet_v3',
  'ethereum-prime': 'proto_lido_v3',
  arbitrum: 'proto_arbitrum_v3',
  base: 'proto_base_v3',
  avalanche: 'proto_avalanche_v3',
  optimism: 'proto_optimism_v3',
  polygon: 'proto_polygon_v3',
  bnb: 'proto_bnb_v3',
  mantle: 'proto_mantle_v3',
  plasma: 'proto_plasma_v3',
  linea: 'proto_linea_v3',
  sonic: 'proto_sonic_v3',
  monad: 'proto_monad_v3',
  megaeth: 'proto_megaeth_v3',
  gnosis: 'proto_gnosis_v3',
}

/** An Aave v3 market as a whole on app.aave.com; undefined for a fork (SparkLend) or an unknown market. */
export function aaveMarketUrl(market: Pick<MarketDef, 'id' | 'fork'>): string | undefined {
  const name = !market.fork && AAVE_MARKET_NAMES[market.id]
  return name ? `https://app.aave.com/markets/?marketName=${name}` : undefined
}

/**
 * A spoke of Aave v4 on pro.aave.com, which calls spokes « markets »: /explore/market/<spoke id>, the id being the
 * API's `Spoke.id`, base64 of « chainId::checksummed address » (pro.aave.com bundle and api.v4.aave.com, 2026-11-23).
 */
export const aaveV4SpokeUrl = (chainId: number, spoke: string) => `https://pro.aave.com/explore/market/${btoa(`${chainId}::${getAddress(spoke)}`)}`

/** Morpho app chain names, by chain id. */
const MORPHO_CHAINS: Record<number, string> = {
  1: 'ethereum',
  10: 'opmainnet',
  130: 'unichain',
  137: 'polygon',
  143: 'monad',
  999: 'hyperliquid',
  4326: 'megaeth',
  4663: 'robinhood-chain',
  5042: 'arc',
  8453: 'base',
  42161: 'arbitrum',
}

/** A Morpho Blue market on app.morpho.org. */
export function morphoMarketUrl(chainId: number, marketId: string): string | undefined {
  const chain = MORPHO_CHAINS[chainId]
  return chain ? `https://app.morpho.org/${chain}/market/${marketId}` : undefined
}

/** Pendle app chain names, by chain id. */
const PENDLE_CHAINS: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bnbchain',
  143: 'monad',
  146: 'sonic',
  5000: 'mantle',
  8453: 'base',
  9745: 'plasma',
  42161: 'arbitrum',
}

/** The PT side of a Pendle market on app.pendle.finance. */
export function pendleMarketUrl(chainId: number, market: string | undefined): string | undefined {
  const chain = PENDLE_CHAINS[chainId]
  return chain && market ? `https://app.pendle.finance/trade/markets/${market.toLowerCase()}/swap?view=pt&chain=${chain}` : undefined
}

/** A Merkl opportunity, by the `id` of api.merkl.xyz/v4/opportunities. */
export const merklOpportunityUrl = (id: string) => `https://app.merkl.xyz/opportunities/${id}`
