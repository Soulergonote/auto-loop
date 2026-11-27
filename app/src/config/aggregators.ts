import { getAddress, type Address } from 'viem'

export type AggregatorId = 'velora' | 'kyber' | 'oneinch' | 'tycho'
/** An aggregator, or 'best': every aggregator that quotes on the chain is asked and the highest output wins. */
export type AggregatorChoice = AggregatorId | 'best'

type Aggregator = {
  label: string
  router: Address
  /** chains the aggregator quotes on (undefined = not restricted) */
  chains?: number[]
  /** chains where the router sits at another address than `router` */
  routerOn?: Record<number, Address>
  /**
   * Added after executors were already deployed: new executors whitelist it, an older one without it stays valid
   * and is simply never quoted through it.
   */
  optional?: boolean
}

/**
 * Router each aggregator's calldata must target. LeverageExecutor approves and calls the same address,
 * which holds for all four (KyberSwap: MetaAggregationRouterV2, same address on every chain listed; 1inch:
 * AggregationRouterV6, read from the API's approve/spender on each chain; Tycho: TychoRouterV3, one per chain). Same values as contracts/test/fork/BaseFork.t.sol; to re-verify against each aggregator's docs
 * before any deployment.
 */
export const AGGREGATORS: Record<AggregatorId, Aggregator> = {
  velora: {
    label: 'Velora',
    router: '0x6A000F20005980200259B80c5102003040001068',
    // from the API's own "Supported chains" error, 2026-10-31; Sonic (146) is listed but answers 503
    chains: [1, 10, 56, 100, 130, 137, 4663, 8453, 42161, 43114],
  },
  kyber: {
    label: 'KyberSwap',
    router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    // Mantle answers 404 (checked 2026-11-01); Arc quotes since 2026-11-10; Unichain, HyperEVM, MegaETH 2026-11-11,
    // Robinhood Chain 2026-11-12 (router checked in each route answer). Also quotes on Berachain, Ronin, Etherlink: no Aave v3 nor Morpho API there.
    chains: [1, 10, 56, 130, 137, 143, 146, 999, 4326, 4663, 5042, 8453, 9745, 42161, 43114, 59144],
  },
  oneinch: {
    label: '1inch',
    router: '0x111111125421cA6dc452d289314280a0f8842A65',
    // Swap API v6.0 answers on these (checked 2026-11-12); Plasma and MegaETH answer 404. Gnosis added 2026-11-25:
    // AggregationRouterV6 has code at the usual address there (same size as on Ethereum), API quote not yet tried with the key.
    chains: [1, 10, 56, 100, 130, 137, 143, 146, 999, 5042, 8453, 42161, 43114, 59144],
    routerOn: { 999: '0x5281602aDc446A94eB48d055F514A6d8d5bEe176', 5042: '0xE08cab0828A67291EC4Af1Fb3E7F867e206A6bdA' },
    optional: true,
  },
  tycho: {
    label: 'Tycho',
    // TychoRouterV3, from Propeller Heads' deployment registry (2026-11-23, tycho-execution/config/deployment_registry.json);
    // same code size on all seven chains (checked 2026-11-27). Chains: the hosted Fynd API's (2026-11-27) the app also
    // covers; Plasma has a router but the API answers unknown_chain, Elysium is not in the app.
    router: '0xe41c726421007e133a59365432fE886a73B45126',
    chains: [1, 56, 130, 137, 4663, 8453, 42161],
    routerOn: {
      56: '0xEe7eCe626064BDA1c6aFDb8A281afe44Eabd3242',
      130: '0x556dff14e4A42259ebCE4fa087323c1047e9a55A',
      137: '0x4dB0B661dc706f7e09e54273028B22f61f8F94C2',
      4663: '0x6F460540B03651d2Ad0ec28f777e4A0480A756a5',
      8453: '0xd374c00614f95492D816b5957E3797ce3f0c445C',
      42161: '0x1B82e8C16Ce8E17535C9B6b8AD107f61b0b192B5',
    },
    optional: true,
  },
}

/** The address an aggregator's calldata must target on a chain. */
export function routerOf(id: AggregatorId, chainId: number): Address {
  return getAddress(AGGREGATORS[id].routerOn?.[chainId] ?? AGGREGATORS[id].router)
}

/**
 * 1inch Swap API key, injected at build time (GitHub secret ONEINCH_API_KEY in the Pages workflow, or .env.local).
 * It ends up readable in the public bundle: a free key whose only risk is its quota. Empty = 1inch is not quoted.
 */
export const ONEINCH_API_KEY = ((import.meta.env.VITE_ONEINCH_API_KEY as string | undefined) ?? '').trim()

/**
 * Tycho (Propeller Heads) quotes through the hosted Fynd API. It sends no CORS header, so a browser can only reach it
 * through a proxy (proxy/tycho-worker.js) that holds the key: VITE_TYCHO_API_URL is that proxy. VITE_TYCHO_API_KEY is
 * only for a direct call (Node scripts, or once the API accepts browsers). Neither set = Tycho is not quoted.
 */
export const TYCHO_API_URL = ((import.meta.env.VITE_TYCHO_API_URL as string | undefined) ?? '').trim().replace(/\/+$/, '')
export const TYCHO_API_KEY = ((import.meta.env.VITE_TYCHO_API_KEY as string | undefined) ?? '').trim()
export const TYCHO_ENABLED = !!TYCHO_API_URL || !!TYCHO_API_KEY

/** The hosted Fynd API names chains in its paths. */
export const TYCHO_CHAIN_SLUGS: Record<number, string> = {
  1: 'ethereum',
  56: 'bsc',
  130: 'unichain',
  137: 'polygon',
  4663: 'robinhood',
  8453: 'base',
  42161: 'arbitrum',
}

/** KyberSwap names chains in its URLs. */
export const KYBER_CHAIN_SLUGS: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  130: 'unichain',
  137: 'polygon',
  143: 'monad',
  146: 'sonic',
  999: 'hyperevm',
  4326: 'megaeth',
  4663: 'robinhood',
  5042: 'arc',
  8453: 'base',
  9745: 'plasma',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
}

/** Client id sent to KyberSwap (identifies the integrator, no fee attached). */
export const KYBER_CLIENT_ID = 'auto-loop'

/** Aggregators the app can quote with on a chain (1inch only when a key was built in, Tycho with a key or a proxy). */
export function aggregatorsFor(chainId: number): AggregatorId[] {
  return (Object.keys(AGGREGATORS) as AggregatorId[]).filter(
    (id) => supportsChain(id, chainId) && (id !== 'oneinch' || !!ONEINCH_API_KEY) && (id !== 'tycho' || TYCHO_ENABLED),
  )
}

export function supportsChain(id: AggregatorId, chainId: number): boolean {
  const chains = AGGREGATORS[id].chains
  return !chains || chains.includes(chainId)
}

/** Partner name sent to Velora: without it the public API adds a 1 bps "anon" fee (checked on Base, 2026-10-18). */
export const VELORA_PARTNER = 'auto-loop'
