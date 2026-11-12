/**
 * DEXes Velora may or must not route through (comma-separated Velora names, e.g. UniswapV3). For local fork
 * tests: oracle-priced pools (Kipseli, Tessera, WooFiV2, metric-v1…) quote from live state the fork does not
 * have and revert there, so the fork setup keeps only plain AMMs.
 */
export const VELORA_INCLUDE_DEXS = ((import.meta.env.VITE_VELORA_INCLUDE_DEXS as string | undefined) ?? '').trim()
export const VELORA_EXCLUDE_DEXS = ((import.meta.env.VITE_VELORA_EXCLUDE_DEXS as string | undefined) ?? '').trim()

/** Same for KyberSwap (its source ids, e.g. uniswapv3,aerodrome-cl,pancake-v3): prop AMMs such as kipseli-prop revert on a fork. */
export const KYBER_INCLUDED_SOURCES = ((import.meta.env.VITE_KYBER_INCLUDED_SOURCES as string | undefined) ?? '').trim()

export type QuoteMode = 'auto' | 'live' | 'mock'
const rawMode = import.meta.env.VITE_QUOTE_MODE as string | undefined
export const QUOTE_MODE: QuoteMode = rawMode === 'live' || rawMode === 'mock' ? rawMode : 'auto'

/** Static illustrative market data instead of on-chain reads (screenshots, offline work). Never for real use. */
export const DEMO = import.meta.env.VITE_DEMO === 'true'
