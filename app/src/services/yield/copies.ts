/**
 * Copies of a token on other chains, found without a hand-kept list: same symbol and same USD price (within
 * SAME_PRICE_TOLERANCE) as a token a yield source knows on another chain. A yield-bearing token earns the same on
 * every chain, so a bridged copy that no source knows takes the yield of the original.
 *
 * The price check is what keeps a look-alike out: anyone can deploy a token named "sUSDe", but not one that trades at
 * sUSDe's price. A wrong match would only change a displayed yield, never what is signed.
 *
 * Prices come from DefiLlama (every chain of the app, CORS open), else from Morpho's API. SAME_TOKEN in
 * yieldTokens.ts stays for tokens neither knows; its entries always win.
 */
import { LLAMA_CHAIN } from '../../config'
import { morphoGet, selector, tokenPrices } from '../../protocols/morpho/api'

export type TokenRef = { chainId: number; address: string }
type Quoted = TokenRef & { symbol: string; price: number }

/** Largest price gap between two copies of a token: 0.5 % (feeds differ slightly between chains and sources). */
export const SAME_PRICE_TOLERANCE = 0.005
const TTL_MS = 30 * 60_000

export const tokenKey = (t: TokenRef) => `${t.chainId}:${t.address.toLowerCase()}`
const samePrice = (a: number, b: number) => a > 0 && b > 0 && Math.abs(a / b - 1) <= SAME_PRICE_TOLERANCE

/** Candidates that are the same token as `token`: same symbol (case aside), same price, another chain or address. */
export function matchCopies(token: Quoted, candidates: Quoted[]): TokenRef[] {
  const seen = new Set([tokenKey(token)])
  const out: TokenRef[] = []
  for (const c of candidates) {
    if (seen.has(tokenKey(c)) || c.chainId === token.chainId) continue
    if (c.symbol.toLowerCase() !== token.symbol.toLowerCase() || !samePrice(c.price, token.price)) continue
    seen.add(tokenKey(c))
    out.push({ chainId: c.chainId, address: c.address.toLowerCase() })
  }
  return out
}

/** Symbol and USD price of each token from DefiLlama, by `chainId:address`; tokens it does not know are left out. */
export async function llamaQuotes(tokens: TokenRef[]): Promise<Map<string, { symbol: string; price: number }>> {
  const out = new Map<string, { symbol: string; price: number }>()
  const named = tokens.filter((t) => LLAMA_CHAIN[t.chainId])
  for (let i = 0; i < named.length; i += 40) {
    const ids = named.slice(i, i + 40).map((t) => `${LLAMA_CHAIN[t.chainId]}:${t.address.toLowerCase()}`)
    const res = await fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}`, { signal: AbortSignal.timeout(8_000) }).catch(() => undefined)
    if (!res?.ok) continue
    const body = (await res.json()) as { coins?: Record<string, { symbol?: string; price?: number }> }
    named.slice(i, i + 40).forEach((t, j) => {
      const c = body.coins?.[ids[j]]
      if (c?.symbol && c.price) out.set(tokenKey(t), { symbol: c.symbol, price: c.price })
    })
  }
  return out
}

const cache = new Map<string, { at: number; value: Promise<Map<string, TokenRef[]>> }>()

/**
 * Copies on other chains of each token, by `chainId:address` (lower case); a token with none is left out. Candidates
 * are `known`: the tokens a yield source reads (vaults, published rates, Pendle underlyings), since a copy only helps
 * when a source knows the original.
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

/** tokens of one read priced through Morpho's API (two requests each) */
const MAX_MORPHO_QUOTES = 20

/**
 * Symbol and USD price of the tokens DefiLlama does not know, from Morpho's API (a chain it covers): prices first, then
 * the symbol of the priced ones only. Tokens without both are left out.
 */
async function morphoQuotes(chainId: number, tokens: TokenRef[]): Promise<Quoted[]> {
  const list = tokens.slice(0, MAX_MORPHO_QUOTES)
  if (list.length === 0) return []
  const prices = await tokenPrices(
    chainId,
    list.map((t) => t.address),
    AbortSignal.timeout(8_000),
  ).catch(() => new Map<string, number>())
  const priced = list.filter((t) => prices.has(tokenKey(t)))
  const infos = await Promise.allSettled(
    priced.map((t) => morphoGet<{ data: { symbol?: string } }>(`/v0/tokens/${selector(t.chainId, t.address)}`, undefined, AbortSignal.timeout(8_000))),
  )
  return priced.flatMap((t, i) => {
    const r = infos[i]
    const symbol = r.status === 'fulfilled' ? r.value.data.symbol : undefined
    return symbol ? [{ ...t, symbol, price: prices.get(tokenKey(t))! }] : []
  })
}

async function readCopies(chainId: number, addresses: string[], known: TokenRef[]): Promise<Map<string, TokenRef[]>> {
  const out = new Map<string, TokenRef[]>()
  if (addresses.length === 0) return out
  const own = addresses.map((address) => ({ chainId, address }))
  const llama = await llamaQuotes([...own, ...known])
  // DefiLlama, else Morpho's API for the few it does not price
  const tokens: Quoted[] = [
    ...own.flatMap((t) => {
      const q = llama.get(tokenKey(t))
      return q ? [{ ...t, ...q }] : []
    }),
    ...(await morphoQuotes(
      chainId,
      own.filter((t) => !llama.has(tokenKey(t))),
    )),
  ].filter((t) => t.price > 0)
  const candidates: Quoted[] = known.flatMap((t) => {
    const q = llama.get(tokenKey(t))
    return q ? [{ ...t, address: t.address.toLowerCase(), ...q }] : []
  })
  for (const t of tokens) {
    const copies = matchCopies(t, candidates)
    if (copies.length > 0) out.set(tokenKey(t), copies)
  }
  return out
}
