/**
 * Copies of a token on other chains, found without a hand-kept list: same symbol and same USD price (within
 * SAME_PRICE_TOLERANCE) as a token the Morpho API knows on another chain. A yield-bearing token earns the same on every
 * chain, so a bridged copy that no source knows takes the yield of the original.
 *
 * The price check is what keeps a look-alike out: anyone can deploy a token named "sUSDe", but not one that trades at
 * sUSDe's price. A wrong match would only change a displayed yield, never what is signed.
 *
 * Prices come from DefiLlama (every chain of the app, CORS open), else from the Morpho API. SAME_TOKEN in
 * yieldTokens.ts stays for tokens neither knows; its entries always win.
 */
import { getAddress } from 'viem'
import { LLAMA_CHAIN } from '../../config'
import { gql } from '../../protocols/morpho/api'

export type TokenRef = { chainId: number; address: string }
type Quoted = TokenRef & { symbol: string; price: number }

/** Largest price gap between two copies of a token: 0.5 % (feeds differ slightly between chains and sources). */
export const SAME_PRICE_TOLERANCE = 0.005
const TTL_MS = 30 * 60_000

const key = (t: TokenRef) => `${t.chainId}:${t.address.toLowerCase()}`
const samePrice = (a: number, b: number) => a > 0 && b > 0 && Math.abs(a / b - 1) <= SAME_PRICE_TOLERANCE

/** Candidates that are the same token as `token`: same symbol (case aside), same price, another chain or address. */
export function matchCopies(token: Quoted, candidates: Quoted[]): TokenRef[] {
  const seen = new Set([key(token)])
  const out: TokenRef[] = []
  for (const c of candidates) {
    if (seen.has(key(c)) || c.chainId === token.chainId) continue
    if (c.symbol.toLowerCase() !== token.symbol.toLowerCase() || !samePrice(c.price, token.price)) continue
    seen.add(key(c))
    out.push({ chainId: c.chainId, address: c.address.toLowerCase() })
  }
  return out
}

/** Symbol and USD price of each token from DefiLlama, by `chainId:address`; tokens it does not know are left out. */
async function llamaQuotes(tokens: TokenRef[]): Promise<Map<string, { symbol: string; price: number }>> {
  const out = new Map<string, { symbol: string; price: number }>()
  const named = tokens.filter((t) => LLAMA_CHAIN[t.chainId])
  for (let i = 0; i < named.length; i += 40) {
    const ids = named.slice(i, i + 40).map((t) => `${LLAMA_CHAIN[t.chainId]}:${t.address.toLowerCase()}`)
    const res = await fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}`, { signal: AbortSignal.timeout(8_000) }).catch(() => undefined)
    if (!res?.ok) continue
    const body = (await res.json()) as { coins?: Record<string, { symbol?: string; price?: number }> }
    named.slice(i, i + 40).forEach((t, j) => {
      const c = body.coins?.[ids[j]]
      if (c?.symbol && c.price) out.set(key(t), { symbol: c.symbol, price: c.price })
    })
  }
  return out
}

type ApiAsset = { address: string; symbol: string; chain: { id: number }; price?: { usd?: number | null } | null }
const ASSET = 'items { address symbol chain { id } price { usd } }'

const cache = new Map<string, { at: number; value: Promise<Map<string, TokenRef[]>> }>()

/**
 * Copies on other chains of each token, by `chainId:address` (lower case); a token with none is left out. Candidates:
 * every token of the same symbol the Morpho API lists, on any chain, plus `known` (tokens a source reads by address,
 * such as the vaults, which may live where the Morpho API has no market).
 */
export function findCopies(chainId: number, addresses: readonly string[], known: TokenRef[] = []): Promise<Map<string, TokenRef[]>> {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))].sort()
  const k = `${chainId}:${list.join(',')}`
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = readCopies(chainId, list, known).catch(() => new Map<string, TokenRef[]>())
  cache.set(k, { at: Date.now(), value })
  return value
}

async function readCopies(chainId: number, addresses: string[], known: TokenRef[]): Promise<Map<string, TokenRef[]>> {
  const out = new Map<string, TokenRef[]>()
  if (addresses.length === 0) return out
  const own = addresses.map((address) => ({ chainId, address }))
  // the tokens themselves: DefiLlama, and the Morpho API for the symbol of those DefiLlama does not know
  const [llama, self] = await Promise.all([
    llamaQuotes(own),
    gql<{ assets: { items: ApiAsset[] } }>(
      `query($chain: [Int!], $addresses: [String!]) { assets(first: 1000, where: { chainId_in: $chain, address_in: $addresses }) { ${ASSET} } }`,
      { chain: [chainId], addresses: addresses.map((a) => getAddress(a)) },
      AbortSignal.timeout(8_000),
    ).catch(() => ({ assets: { items: [] as ApiAsset[] } })),
  ])
  const apiSelf = new Map(self.assets.items.map((a) => [key({ chainId, address: a.address }), a]))
  const tokens: Quoted[] = []
  for (const t of own) {
    const l = llama.get(key(t))
    const a = apiSelf.get(key(t))
    // the API's spelling first: its symbol filter is case-sensitive
    const symbol = a?.symbol ?? l?.symbol
    const price = l?.price ?? a?.price?.usd ?? 0
    if (symbol && price > 0) tokens.push({ ...t, symbol, price })
  }
  if (tokens.length === 0) return out

  // every token with those symbols on any chain the Morpho API covers, priced like the tokens themselves
  const symbols = [...new Set(tokens.map((t) => t.symbol))]
  const found = await gql<{ assets: { items: ApiAsset[] } }>(
    `query($symbols: [String!]) { assets(first: 1000, where: { symbol_in: $symbols }) { ${ASSET} } }`,
    { symbols },
    AbortSignal.timeout(8_000),
  )
  const others = found.assets.items.map((a) => ({ chainId: a.chain.id, address: a.address.toLowerCase(), symbol: a.symbol, apiPrice: a.price?.usd ?? 0 }))
  const llamaOthers = await llamaQuotes([...others, ...known])
  const candidates: Quoted[] = others.map((o) => ({ ...o, price: llamaOthers.get(key(o))?.price ?? o.apiPrice }))
  for (const t of known) {
    const q = llamaOthers.get(key(t))
    if (q) candidates.push({ ...t, address: t.address.toLowerCase(), ...q })
  }
  for (const t of tokens) {
    const copies = matchCopies(t, candidates)
    if (copies.length > 0) out.set(key(t), copies)
  }
  return out
}
