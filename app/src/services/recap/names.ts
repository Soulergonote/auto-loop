/**
 * X5: what the signing recap calls an address. The contracts the app works with are named from its configuration;
 * an executor is named once its code has passed the app's check (deploy.ts), so a contract the app never verified
 * stays unnamed and the recap warns about it. Tokens are read on chain once (symbol, decimals) and kept.
 */
import { getAddress, type Address } from 'viem'
import { AAVE_V4_CHAINS, MARKETS, MERKL_DISTRIBUTOR, MORPHO_BLUE, V4_NETWORKS, executorRouters, marketPlace } from '../../config'
import { CREATE2_PROXY } from '../../chain/create2'

export type Token = { symbol: string; decimals: number }
/** `ours`: a contract of Auto-loop whose code the app checked; the recap trusts it as a spender */
export type Name = { label: string; ours?: boolean }

const key = (chainId: number, a: string) => `${chainId}:${a.toLowerCase()}`
const names = new Map<string, Name>()
const tokens = new Map<string, Token>()
const v4Reserves = new Map<string, Token>()

export function rememberName(chainId: number, address: Address, name: Name) {
  names.set(key(chainId, address), name)
}

export function rememberToken(chainId: number, address: Address, token: Token) {
  tokens.set(key(chainId, address), token)
}

/** An Aave v4 reserve, known by its spoke and id: what the Taker permits and the v4 calls name. */
export function rememberV4Reserve(chainId: number, spoke: Address, reserveId: number, token: Token) {
  v4Reserves.set(`${key(chainId, spoke)}:${reserveId}`, token)
}

const eModes = new Map<string, string>()

/** An Aave eMode category's label, read once on chain by the wallet gateway. */
export function rememberEMode(chainId: number, pool: Address, id: number, label: string) {
  eModes.set(`${key(chainId, pool)}:${id}`, label)
}
export const eModeOf = (chainId: number, pool: Address, id: number): string | undefined => eModes.get(`${key(chainId, pool)}:${id}`)

export const nameOf = (chainId: number, a: Address): Name | undefined => names.get(key(chainId, a)) ?? staticNames(chainId).get(a.toLowerCase())
export const tokenOf = (chainId: number, a: Address): Token | undefined => tokens.get(key(chainId, a))
export const v4ReserveOf = (chainId: number, spoke: Address, reserveId: bigint | number): Token | undefined =>
  v4Reserves.get(`${key(chainId, spoke)}:${Number(reserveId)}`)

const byChain = new Map<number, Map<string, Name>>()

/** The contracts of the configuration on one chain: Aave pools, Morpho, the v4 position managers, routers. */
function staticNames(chainId: number): Map<string, Name> {
  let m = byChain.get(chainId)
  if (m) return m
  m = new Map()
  const put = (a: Address, label: string) => m!.set(getAddress(a).toLowerCase(), { label })
  for (const market of MARKETS) if (market.chain.id === chainId) put(market.pool, `pool ${marketPlace(market)}`)
  if (MORPHO_BLUE[chainId]) put(MORPHO_BLUE[chainId], 'Morpho Blue')
  if (AAVE_V4_CHAINS.includes(chainId))
    for (const n of V4_NETWORKS.filter((x) => x.chain.id === chainId)) {
      put(n.giver, `Aave v4 · Giver (${n.label})`)
      put(n.taker, `Aave v4 · Taker (${n.label})`)
    }
  for (const r of executorRouters(chainId)) put(r.router, `routeur ${r.label}`)
  put(CREATE2_PROXY, 'fabrique CREATE2 (déploiement déterministe)')
  put(MERKL_DISTRIBUTOR, 'distributeur Merkl')
  byChain.set(chainId, m)
  return m
}
