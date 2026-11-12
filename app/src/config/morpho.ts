import type { Address, Chain } from 'viem'
import { arbitrum, arc, base, hyperEvm, mainnet, monad, optimism, polygon, unichain } from 'viem/chains'
import { BUILD_EXECUTORS, FORK_MORPHO_EXECUTOR } from './executors'

/**
 * Morpho Blue per chain, registered in v2 executors as a free flash lender for closes (no premium, unlike Aave).
 * Checked 2026-11-08 on each chain's RPC (Morpho Blue code, owner(), isIrmEnabled()). Balancer v2 is not used: its
 * Vault locks swaps during its own flash loans, so routes through Balancer pools would fail (audit L-02).
 */
export const MORPHO_BLUE: Record<number, Address> = {
  1: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  8453: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  42161: '0x6c247b1F6182318877311737BaC0844bAa518F5e',
  10: '0xce95AfbB8EA029495c66020883F87aaE8864AF92',
  137: '0x1bF0c2541F820E775182832f06c0B7Fc27A25f67',
  43114: '0x895383274303AA19fe978AFB4Ac55C7f094f982C',
  56: '0x01b0Bd309AA75547f7a37Ad7B1219A898E67a83a',
  146: '0xd6c916eB7542D0Ad3f18AEd0FCBD50C582cfa95f',
  // Arc: from Morpho's own address list (morpho-org/sdks, morpho-ts addresses.ts), 2026-11-10
  5042: '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD',
  // 2026-11-11: same in morpho-ts addresses.ts and the Morpho API (morphoBlues), owner() read on chain. Monad (143) stays out:
  // Aave v2 executors already deployed there have no Morpho lender, and their closes would pick it (see MORPHO_NETWORKS).
  130: '0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A',
  999: '0x68e37dE8d93d3496ae143F2E900490f6280C57cD',
}

/**
 * Morpho Blue as a lending platform (LeverageExecutorMorpho): the app networks where Morpho Blue is deployed and its
 * API (blue-api.morpho.org, market list and rates) answers. Checked 2026-11-09: the API refuses Avalanche, BNB and
 * Plasma; Sonic has no API data. Ethereum first, as Azerty asked; Arc added 2026-11-10.
 */
export type MorphoNetDef = { id: string; label: string; chain: Chain; morpho: Address }
export const MORPHO_NETWORKS: MorphoNetDef[] = [
  { id: 'morpho-ethereum', label: 'Ethereum', chain: mainnet, morpho: MORPHO_BLUE[1] },
  { id: 'morpho-base', label: 'Base', chain: base, morpho: MORPHO_BLUE[8453] },
  { id: 'morpho-arbitrum', label: 'Arbitrum', chain: arbitrum, morpho: MORPHO_BLUE[42161] },
  { id: 'morpho-optimism', label: 'Optimism', chain: optimism, morpho: MORPHO_BLUE[10] },
  { id: 'morpho-polygon', label: 'Polygon', chain: polygon, morpho: MORPHO_BLUE[137] },
  // Arc (Circle): gas paid in USDC, KyberSwap only, no Pendle; added 2026-11-10 at Azerty's request
  { id: 'morpho-arc', label: 'Arc', chain: arc, morpho: MORPHO_BLUE[5042] },
  // 2026-11-11: chains where KyberSwap quotes and the Morpho API lists markets (BNB, Linea, Sonic, Etherlink, MegaETH: API refuses)
  { id: 'morpho-unichain', label: 'Unichain', chain: unichain, morpho: MORPHO_BLUE[130] },
  { id: 'morpho-hyperevm', label: 'HyperEVM', chain: hyperEvm, morpho: MORPHO_BLUE[999] },
  // Monad: Morpho API + morpho-ts addresses.ts agree; code and owner() read on chain 2026-11-12
  { id: 'morpho-monad', label: 'Monad', chain: monad, morpho: '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee' },
]
export const isMorphoId = (id: string) => id.startsWith('morpho-')

export type MorphoNet = MorphoNetDef & {
  executor?: Address
  executorSource?: 'build' | 'wallet'
  /** taker sent to the aggregators: the contract holds the tokens during the swap */
  quoteTaker: Address
}

export function getMorphoNet(id: string, local: Record<string, Address> = {}): MorphoNet {
  const def = MORPHO_NETWORKS.find((n) => n.id === id) ?? MORPHO_NETWORKS[0]
  const fromBuild = BUILD_EXECUTORS[def.id]
  const executor = fromBuild ?? local[def.id]
  return { ...def, executor, executorSource: fromBuild ? 'build' : executor ? 'wallet' : undefined, quoteTaker: executor ?? FORK_MORPHO_EXECUTOR }
}
