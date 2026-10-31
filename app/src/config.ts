import { getAddress, isAddress, keccak256, slice, toBytes, type Address, type Chain } from 'viem'
import { arbitrum, avalanche, base, bsc, linea, mainnet, mantle, monad, optimism, plasma, polygon, sonic } from 'viem/chains'

export type Token = { symbol: string; name: string; address: Address; decimals: number }

/**
 * Aave v3 markets the app offers: the larger Aave v3 deployments where Velora or KyberSwap quotes (checked 2026-10-31
 * against @bgd-labs/aave-address-book and each aggregator's chain list). Prices, risk parameters and the asset list
 * are read on-chain.
 * `soon`: listed for visibility but not selectable, with the reason shown.
 */
export type MarketDef = { id: string; label: string; chain: Chain; pool: Address; soon?: string }

export const MARKETS: MarketDef[] = [
  { id: 'ethereum', label: 'Ethereum (Core)', chain: mainnet, pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
  { id: 'ethereum-prime', label: 'Ethereum (Prime)', chain: mainnet, pool: '0x4e033931ad43597d96D6bcc25c280717730B58B1' },
  { id: 'arbitrum', label: 'Arbitrum', chain: arbitrum, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'base', label: 'Base', chain: base, pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' },
  { id: 'avalanche', label: 'Avalanche', chain: avalanche, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'optimism', label: 'Optimism', chain: optimism, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'polygon', label: 'Polygon', chain: polygon, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'bnb', label: 'BNB Chain', chain: bsc, pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' },
  { id: 'mantle', label: 'Mantle', chain: mantle, pool: '0x458F293454fE0d67EC0655f3672301301DD51422' },
  { id: 'plasma', label: 'Plasma', chain: plasma, pool: '0x925a2A7214Ed92428B5b1B090F80b25700095e12' },
  { id: 'linea', label: 'Linea', chain: linea, pool: '0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac' },
  { id: 'sonic', label: 'Sonic', chain: sonic, pool: '0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3' },
  { id: 'monad', label: 'Monad', chain: monad, pool: '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef' },
]

export const DEFAULT_MARKET_ID = 'base'

/** Default pair on a new market: first symbol found in each list. */
export const DEFAULT_COLLATERAL_SYMBOLS = ['WETH', 'WETH.e', 'ETH', 'WBNB']
export const DEFAULT_DEBT_SYMBOLS = ['USDC', 'USDT0', 'USDT', 'USDt']

/** Base assets used by the demo mode (VITE_DEMO=true), where nothing is read on-chain. */
export const DEMO_TOKENS: Token[] = [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  { symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped stETH', address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18 },
  { symbol: 'weETH', name: 'Wrapped eETH', address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', decimals: 18 },
  { symbol: 'EURC', name: 'Euro Coin', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6 },
]

export type AggregatorId = '0x' | '1inch' | 'velora' | 'kyber'

type Aggregator = {
  label: string
  router: Address
  needsKey: boolean
  available: boolean
  /** chains the aggregator quotes on (undefined = not restricted) */
  chains?: number[]
}

/**
 * Router each aggregator's calldata must target. LeverageExecutor approves and calls the same address,
 * which holds for all of them (0x: AllowanceHolder, never Settler; KyberSwap: MetaAggregationRouterV2, same address on
 * every chain listed). Same values as contracts/test/fork/BaseFork.t.sol; to re-verify against each aggregator's docs
 * before any deployment.
 */
export const AGGREGATORS: Record<AggregatorId, Aggregator> = {
  '0x': { label: '0x', router: '0x0000000000001fF3684f28c67538d4D072C22734', needsKey: true, available: false },
  '1inch': { label: '1inch', router: '0x111111125421cA6dc452d289314280a0f8842A65', needsKey: true, available: false },
  velora: {
    label: 'Velora',
    router: '0x6A000F20005980200259B80c5102003040001068',
    needsKey: false,
    available: true,
    // from the API's own "Supported chains" error, 2026-10-31
    chains: [1, 10, 56, 100, 130, 137, 146, 4663, 8453, 42161, 43114],
  },
  kyber: {
    label: 'KyberSwap',
    router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    needsKey: false,
    available: true,
    chains: [1, 10, 56, 137, 143, 146, 5000, 8453, 9745, 42161, 43114, 59144],
  },
}

/** KyberSwap names chains in its URLs. */
export const KYBER_CHAIN_SLUGS: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  137: 'polygon',
  143: 'monad',
  146: 'sonic',
  5000: 'mantle',
  8453: 'base',
  9745: 'plasma',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
}

/** Client id sent to KyberSwap (identifies the integrator, no fee attached). */
export const KYBER_CLIENT_ID = 'auto-loop'

export function aggregatorsFor(chainId: number): AggregatorId[] {
  return (Object.keys(AGGREGATORS) as AggregatorId[]).filter((id) => {
    const a = AGGREGATORS[id]
    return a.available && (!a.chains || a.chains.includes(chainId))
  })
}

export function supportsChain(id: AggregatorId, chainId: number): boolean {
  const chains = AGGREGATORS[id].chains
  return !chains || chains.includes(chainId)
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

/**
 * Deployed LeverageExecutor per market (one per Aave pool): VITE_EXECUTORS='{"base":"0x…","arbitrum":"0x…"}'.
 * VITE_EXECUTOR_ADDRESS is still read as the Base one. Missing = not deployed there: everything is computed and
 * shown, but nothing is offered for signing.
 */
function readExecutors(): Record<string, Address> {
  const out: Record<string, Address> = {}
  try {
    const raw = JSON.parse((import.meta.env.VITE_EXECUTORS as string | undefined) || '{}') as Record<string, string>
    for (const [id, a] of Object.entries(raw)) if (isAddress(a)) out[id] = getAddress(a)
  } catch {
    console.warn('VITE_EXECUTORS illisible, ignoré')
  }
  const legacy = import.meta.env.VITE_EXECUTOR_ADDRESS as string | undefined
  if (legacy && isAddress(legacy) && !out.base) out.base = getAddress(legacy)
  return out
}
const EXECUTORS = readExecutors()

export type Market = MarketDef & {
  executor?: Address
  /** taker sent to the aggregators: the contract holds the tokens during the swap */
  quoteTaker: Address
}

export function getMarket(id: string): Market {
  const def = MARKETS.find((m) => m.id === id && !m.soon) ?? MARKETS.find((m) => m.id === DEFAULT_MARKET_ID)!
  const executor = EXECUTORS[def.id]
  return { ...def, executor, quoteTaker: executor ?? FORK_EXECUTOR }
}

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
}

export function rpcUrls(chain: Chain): string[] {
  const env = import.meta.env as Record<string, string | undefined>
  const override = env[`VITE_RPC_URL_${chain.id}`] || (chain.id === base.id ? env.VITE_RPC_URL : undefined)
  if (override) return [override]
  return [PUBLICNODE[chain.id], chain.rpcUrls.default.http[0]].filter((u): u is string => !!u)
}

export type QuoteMode = 'auto' | 'live' | 'mock'
const rawMode = import.meta.env.VITE_QUOTE_MODE as string | undefined
export const QUOTE_MODE: QuoteMode = rawMode === 'live' || rawMode === 'mock' ? rawMode : 'auto'

/** Default health factor floor the UI aims for on uncorrelated pairs. */
export const TARGET_MIN_HF = 1.3

/** Static illustrative market data instead of on-chain reads (screenshots, offline work). Never for real use. */
export const DEMO = import.meta.env.VITE_DEMO === 'true'
