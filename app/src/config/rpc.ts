import type { Chain } from 'viem'
import { arbitrum, avalanche, base, bsc, hyperEvm, linea, mainnet, mantle, optimism, polygon, robinhood, sonic, unichain } from 'viem/chains'

/**
 * RPC per chain: VITE_RPC_URL_<chainId> if set (VITE_RPC_URL for Base, e.g. a local anvil fork), otherwise the
 * PublicNode endpoint with the chain's default public RPC as fallback. All keyless and callable from a browser.
 */
const PUBLICNODE: Record<number, string> = {
  [mainnet.id]: 'https://ethereum-rpc.publicnode.com',
  [arbitrum.id]: 'https://arbitrum-one-rpc.publicnode.com',
  [base.id]: 'https://base-rpc.publicnode.com',
  [avalanche.id]: 'https://avalanche-c-chain-rpc.publicnode.com',
  [optimism.id]: 'https://optimism-rpc.publicnode.com',
  [polygon.id]: 'https://polygon-bor-rpc.publicnode.com',
  [bsc.id]: 'https://bsc-rpc.publicnode.com',
  [mantle.id]: 'https://mantle-rpc.publicnode.com',
  [linea.id]: 'https://linea-rpc.publicnode.com',
  [sonic.id]: 'https://sonic-rpc.publicnode.com',
  [unichain.id]: 'https://unichain-rpc.publicnode.com',
  [hyperEvm.id]: 'https://hyperliquid-rpc.publicnode.com',
  [robinhood.id]: 'https://robinhood-rpc.publicnode.com',
}

export function rpcUrls(chain: Chain): string[] {
  const env = import.meta.env as Record<string, string | undefined>
  const override = env[`VITE_RPC_URL_${chain.id}`] || (chain.id === base.id ? env.VITE_RPC_URL : undefined)
  if (override) return [override]
  // without a PublicNode endpoint, every public RPC of the chain in turn (Arc lists four)
  return PUBLICNODE[chain.id] ? [PUBLICNODE[chain.id], chain.rpcUrls.default.http[0]] : [...chain.rpcUrls.default.http]
}

/**
 * Keyless RPCs that answer calls at an old block (PublicNode refuses them without a token), for the share-price growth
 * of vault tokens (tokenYield.ts). Checked 12 Nov 2026: state 7 and 30 days back, CORS open to the app's origin.
 */
export const ARCHIVE_RPCS: Record<number, string[]> = {
  [mainnet.id]: ['https://eth.drpc.org', 'https://mainnet.gateway.tenderly.co', 'https://eth-mainnet.public.blastapi.io'],
  [base.id]: ['https://base.drpc.org', 'https://base.gateway.tenderly.co', 'https://mainnet.base.org'],
  [avalanche.id]: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-mainnet.gateway.tenderly.co'],
  // the chain's own RPC keeps under a day of state; dRPC answers 30 days back (CORS *), checked 12 Nov 2026
  [robinhood.id]: ['https://robinhood.drpc.org'],
}
