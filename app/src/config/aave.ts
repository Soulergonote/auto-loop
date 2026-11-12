import type { Address, Chain } from 'viem'
import { arbitrum, avalanche, base, bsc, linea, mainnet, mantle, megaeth, monad, optimism, plasma, polygon, sonic } from 'viem/chains'
import { BUILD_EXECUTORS, FORK_EXECUTOR } from './executors'

/**
 * Aave v3 markets the app offers: the larger Aave v3 deployments where Velora or KyberSwap quotes (checked 2026-10-31
 * against @bgd-labs/aave-address-book and each aggregator's chain list). Prices, risk parameters and the asset list
 * are read on-chain.
 * `soon`: listed for visibility but not selectable, with the reason shown.
 */
export type MarketDef = { id: string; label: string; chain: Chain; pool: Address; soon?: string }
/** The network alone, without the Aave market instance: « Ethereum (Prime) » → « Ethereum ». */
export const networkName = (label: string) => label.replace(/\s*\(.*\)$/, '')
/** The Aave market instance when a network has several: « Ethereum (Prime) » → « Prime ». */
export const marketInstance = (label: string) => label.match(/\((.*)\)$/)?.[1]

export const MARKETS: MarketDef[] = [
  { id: 'ethereum', label: 'Ethereum (Core)', chain: mainnet, pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
  { id: 'ethereum-prime', label: 'Ethereum (Prime)', chain: mainnet, pool: '0x4e033931ad43597d96D6bcc25c280717730B58B1' },
  { id: 'arbitrum', label: 'Arbitrum', chain: arbitrum, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'base', label: 'Base', chain: base, pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' },
  { id: 'avalanche', label: 'Avalanche', chain: avalanche, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'optimism', label: 'Optimism', chain: optimism, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'polygon', label: 'Polygon', chain: polygon, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'bnb', label: 'BNB Chain', chain: bsc, pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' },
  { id: 'mantle', label: 'Mantle', chain: mantle, pool: '0x458F293454fE0d67EC0655f3672301301DD51422', soon: 'ni Velora ni KyberSwap n’y cotent' },
  { id: 'plasma', label: 'Plasma', chain: plasma, pool: '0x925a2A7214Ed92428B5b1B090F80b25700095e12' },
  { id: 'linea', label: 'Linea', chain: linea, pool: '0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac' },
  { id: 'sonic', label: 'Sonic', chain: sonic, pool: '0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3' },
  { id: 'monad', label: 'Monad', chain: monad, pool: '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef' },
  // MegaETH: Pool from @bgd-labs/aave-address-book 4.44.22 (AaveV3MegaEth), KyberSwap only; added 2026-11-11
  { id: 'megaeth', label: 'MegaETH', chain: megaeth, pool: '0x7e324AbC5De01d112AfC03a584966ff199741C28' },
]

export const DEFAULT_MARKET_ID = 'base'

export type Market = MarketDef & {
  executor?: Address
  /** contract version of `executor`, known once its code is checked on chain (2 for every new deployment) */
  executorVersion?: 1 | 2
  /** where the executor address comes from: the build (VITE_EXECUTORS) or a deployment from this browser's wallet */
  executorSource?: 'build' | 'wallet'
  /** taker sent to the aggregators: the contract holds the tokens during the swap */
  quoteTaker: Address
  /** the executor whitelists Pendle's router (PT loops), known once its code is checked */
  executorPendle?: boolean
}

export function getMarket(id: string, local: Record<string, Address> = {}): Market {
  const def = MARKETS.find((m) => m.id === id && !m.soon) ?? MARKETS.find((m) => m.id === DEFAULT_MARKET_ID)!
  const fromBuild = BUILD_EXECUTORS[def.id]
  const executor = fromBuild ?? local[def.id]
  const executorSource = fromBuild ? 'build' : executor ? 'wallet' : undefined
  return { ...def, executor, executorSource, quoteTaker: executor ?? FORK_EXECUTOR }
}
