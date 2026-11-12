import type { Address } from 'viem'

export type AggregatorId = 'velora' | 'kyber'
/** An aggregator, or 'best': every aggregator that quotes on the chain is asked and the highest output wins. */
export type AggregatorChoice = AggregatorId | 'best'

type Aggregator = {
  label: string
  router: Address
  /** chains the aggregator quotes on (undefined = not restricted) */
  chains?: number[]
}

/**
 * Router each aggregator's calldata must target. LeverageExecutor approves and calls the same address,
 * which holds for both (KyberSwap: MetaAggregationRouterV2, same address on
 * every chain listed). Same values as contracts/test/fork/BaseFork.t.sol; to re-verify against each aggregator's docs
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
    // Mantle answers 404 (checked 2026-11-01); Arc quotes since 2026-11-10; Unichain, HyperEVM, MegaETH 2026-11-11
    // (router checked in each route answer). Also quotes on Berachain, Ronin, Etherlink: no Aave v3 nor Morpho API there.
    chains: [1, 10, 56, 130, 137, 143, 146, 999, 4326, 5042, 8453, 9745, 42161, 43114, 59144],
  },
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
  5042: 'arc',
  8453: 'base',
  9745: 'plasma',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
}

/** Client id sent to KyberSwap (identifies the integrator, no fee attached). */
export const KYBER_CLIENT_ID = 'auto-loop'

export function aggregatorsFor(chainId: number): AggregatorId[] {
  return (Object.keys(AGGREGATORS) as AggregatorId[]).filter((id) => supportsChain(id, chainId))
}

export function supportsChain(id: AggregatorId, chainId: number): boolean {
  const chains = AGGREGATORS[id].chains
  return !chains || chains.includes(chainId)
}

/** Partner name sent to Velora: without it the public API adds a 1 bps "anon" fee (checked on Base, 2026-10-18). */
export const VELORA_PARTNER = 'auto-loop'
