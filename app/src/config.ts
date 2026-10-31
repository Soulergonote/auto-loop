import { getAddress, isAddress, keccak256, slice, toBytes, type Address } from 'viem'

export const CHAIN_ID = 8453 // Base

export type Token = { symbol: string; name: string; address: Address; decimals: number }

/** Aave v3 market on Base. Prices and risk parameters are read on-chain, only addresses live here. */
export const AAVE_V3_BASE = {
  pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address,
}

/** Assets listed on Aave v3 Base that make sense as collateral or debt. Decimals are re-read on-chain. */
export const TOKENS: Token[] = [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  { symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped stETH', address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18 },
  { symbol: 'weETH', name: 'Wrapped eETH', address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', decimals: 18 },
  { symbol: 'EURC', name: 'Euro Coin', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6 },
]

export type AggregatorId = '0x' | '1inch' | 'velora'

/**
 * Router each aggregator's calldata must target. LeverageExecutor approves and calls the same address,
 * which holds for all three (0x: AllowanceHolder, never Settler). Same values as contracts/test/fork/BaseFork.t.sol;
 * to re-verify against each aggregator's docs before any deployment.
 */
export const AGGREGATORS: Record<AggregatorId, { label: string; router: Address; needsKey: boolean; available: boolean }> = {
  '0x': { label: '0x', router: '0x0000000000001fF3684f28c67538d4D072C22734', needsKey: true, available: false },
  '1inch': { label: '1inch', router: '0x111111125421cA6dc452d289314280a0f8842A65', needsKey: true, available: false },
  velora: { label: 'Velora', router: '0x6A000F20005980200259B80c5102003040001068', needsKey: false, available: true },
}

/** Partner name sent to Velora: without it the public API adds a 1 bps "anon" fee (checked on Base, 2026-10-18). */
export const VELORA_PARTNER = 'auto-loop'

/**
 * DEXes Velora may or must not route through (comma-separated Velora names, e.g. UniswapV3). For local fork
 * tests: oracle-priced pools (Kipseli, Tessera, WooFiV2, metric-v1…) quote from live state the fork does not
 * have and revert there, so the fork setup keeps only plain AMMs.
 */
export const VELORA_INCLUDE_DEXS = ((import.meta.env.VITE_VELORA_INCLUDE_DEXS as string | undefined) ?? '').trim()
export const VELORA_EXCLUDE_DEXS = ((import.meta.env.VITE_VELORA_EXCLUDE_DEXS as string | undefined) ?? '').trim()

export const PLATFORMS = [
  { id: 'aave-v3', label: 'Aave v3', available: true },
  { id: 'morpho-blue', label: 'Morpho Blue', available: false },
] as const

/** Address the fork tests deploy the executor at; used as the quote taker until a real deployment exists. */
export const FORK_EXECUTOR: Address = getAddress(slice(keccak256(toBytes('auto-loop.executor.fork')), 12))

const rawExecutor = import.meta.env.VITE_EXECUTOR_ADDRESS as string | undefined
export const EXECUTOR: Address | undefined = rawExecutor && isAddress(rawExecutor) ? getAddress(rawExecutor) : undefined

/** Taker sent to the aggregators: the contract holds the tokens during the swap. */
export const QUOTE_TAKER: Address = EXECUTOR ?? FORK_EXECUTOR

export const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined) || undefined

export type QuoteMode = 'auto' | 'live' | 'mock'
const rawMode = import.meta.env.VITE_QUOTE_MODE as string | undefined
export const QUOTE_MODE: QuoteMode = rawMode === 'live' || rawMode === 'mock' ? rawMode : 'auto'

/** Default health factor floor the UI aims for on uncorrelated pairs. */
export const TARGET_MIN_HF = 1.3

/** Static illustrative market data instead of on-chain reads (screenshots, offline work). Never for real use. */
export const DEMO = import.meta.env.VITE_DEMO === 'true'
