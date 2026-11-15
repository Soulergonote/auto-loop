import { getAddress, keccak256, slice, toBytes, type Address, type Chain } from 'viem'
import { arc, avalanche, base, mainnet } from 'viem/chains'
import { BUILD_EXECUTORS } from './executors'
import { MORPHO_BLUE } from './morpho'

/**
 * Aave v4 as a lending platform (LeverageExecutorV4). A v4 position lives in a spoke; the executor acts on it through
 * Aave's own position managers, the Giver (supply, repay) and the Taker (borrow, withdraw), and takes its flash loans
 * from Morpho Blue (v4 has none). One entry per set of position managers: every spoke of a chain shares one set,
 * except the three Ethereum spokes of the Sentora hub (an outside curator), which have their own.
 * Addresses from the API (`spokePositionManagers`), each told apart by its code on chain and its registration checked
 * with `isSpokeRegistered`, 2026-11-15.
 */
export type V4NetDef = {
  id: string
  label: string
  chain: Chain
  giver: Address
  taker: Address
  /** Morpho Blue, the flash lender */
  morpho: Address
  /** the spokes these managers serve, when it is not every other spoke of the chain */
  spokes?: Address[]
}

const SENTORA_SPOKES: Address[] = [
  '0xbb97b61Ad6747D337E5805F2d159d275BB1f0828', // OUSD Yield
  '0x9EbF0C19BF7dFE859820Cc09E846114b53814e52', // RLUSD Yield
  '0xA37e7cdC557f3C7f745FB3F337b6439979662c46', // Bluechip
]

export const V4_NETWORKS: V4NetDef[] = [
  {
    id: 'v4-ethereum',
    label: 'Ethereum (Aave)',
    chain: mainnet,
    giver: '0x17A54b8d6D9C68e7fa1C7112AC998EA1BA51d11e',
    taker: '0x6c044c0D3801499bCAbfAd458B70880bc518e9F7',
    morpho: MORPHO_BLUE[mainnet.id],
  },
  {
    id: 'v4-ethereum-sentora',
    label: 'Ethereum (Sentora)',
    chain: mainnet,
    giver: '0x4CF59b43ADC4A183d3f7ED5Ec9c0Aca1ce3f25A4',
    taker: '0xa25963b913D69574290aFaC4A8202d43060b826f',
    morpho: MORPHO_BLUE[mainnet.id],
    spokes: SENTORA_SPOKES,
  },
  {
    id: 'v4-avalanche',
    label: 'Avalanche',
    chain: avalanche,
    giver: '0x50c4C40aB6BaE46B372a251BEacE388439aa96b4',
    taker: '0x5A5A711560eb9293Ef6F4bc33CD8589b4A603D10',
    morpho: MORPHO_BLUE[avalanche.id],
  },
  {
    id: 'v4-arc',
    label: 'Arc',
    chain: arc,
    giver: '0x01Da80Eef3004ebbF90b7637B1De7fF30fBc7cf1',
    taker: '0xe9fae1C386c6f45B1fb3C3Ef01aDE424DAd4bCcF',
    morpho: MORPHO_BLUE[arc.id],
  },
  {
    id: 'v4-base',
    label: 'Base',
    chain: base,
    giver: '0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08',
    taker: '0x8481204E528735aF2F3391AD98f36E757A56D695',
    morpho: MORPHO_BLUE[base.id],
  },
]
export const isV4Id = (id: string) => id.startsWith('v4-')

/** Chains where Aave v4 is live (api.v4.aave.com `chains`, checked 2026-11-15). */
export const AAVE_V4_CHAINS: number[] = [...new Set(V4_NETWORKS.map((n) => n.chain.id))]

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

/** Whether a spoke is served by this entry's position managers. Pure, tested. */
export function v4Serves(net: V4NetDef, spoke: Address): boolean {
  if (net.spokes) return net.spokes.some((s) => same(s, spoke))
  return !V4_NETWORKS.some((n) => n.chain.id === net.chain.id && n.spokes?.some((s) => same(s, spoke)))
}

/** The entry (position managers, hence executor) of a spoke. */
export const v4NetOfSpoke = (chainId: number, spoke: Address): V4NetDef | undefined => V4_NETWORKS.find((n) => n.chain.id === chainId && v4Serves(n, spoke))

/** Address the fork tests deploy the v4 executor at; the quote taker until a real deployment exists. */
export const FORK_V4_EXECUTOR: Address = getAddress(slice(keccak256(toBytes('auto-loop.v4-executor.fork')), 12))

export type V4Net = V4NetDef & {
  executor?: Address
  executorSource?: 'build' | 'wallet'
  /** taker sent to the aggregators: the contract holds the tokens during the swap */
  quoteTaker: Address
}

export function getV4Net(id: string, local: Record<string, Address> = {}): V4Net {
  const def = V4_NETWORKS.find((n) => n.id === id) ?? V4_NETWORKS[0]
  const fromBuild = BUILD_EXECUTORS[def.id]
  const executor = fromBuild ?? local[def.id]
  return { ...def, executor, executorSource: fromBuild ? 'build' : executor ? 'wallet' : undefined, quoteTaker: executor ?? FORK_V4_EXECUTOR }
}
