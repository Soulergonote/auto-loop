/**
 * Morpho's public REST API (api.morpho.org, CORS open, no key), which replaces the GraphQL API retired in January 2027.
 * Used to list markets and positions and for histories; anything shown as live state or signed is read on-chain.
 *
 * Limits (docs.morpho.org, 2026-11): 750 requests a minute per IP, and an IP that sends over 3,334 in 10 minutes is
 * banned for 7 days. So requests go through one queue of at most MAX_CONCURRENT at a time, a 429 is never retried here
 * (the queue stops until its Retry-After), and no list is read with one request per market.
 */
export const MORPHO_API = 'https://api.morpho.org'

const MAX_CONCURRENT = 6
let running = 0
const waiting: (() => void)[] = []
/** no request before this time (ms) after a 429 */
let pausedUntil = 0

async function slot(): Promise<() => void> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r))
  running++
  return () => {
    running--
    waiting.shift()?.()
  }
}

export type Query = Record<string, string | number | boolean | readonly (string | number)[] | undefined>

/** `?a=1&b=x&b=y`: arrays repeat their key, undefined values are left out. */
export function queryString(q: Query = {}): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue
    for (const x of Array.isArray(v) ? v : [v]) p.append(k, String(x))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

export class MorphoApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** GET a route of the API; `data` of the answer is returned whole (with `cursor` when the route pages). */
export async function morphoGet<T>(path: string, q?: Query, signal?: AbortSignal): Promise<T> {
  if (Date.now() < pausedUntil) throw new MorphoApiError('API Morpho : trop de requêtes, réessayer plus tard', 429)
  const release = await slot()
  try {
    const res = await fetch(`${MORPHO_API}${path}${queryString(q)}`, { signal })
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'))
      pausedUntil = Date.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : 600_000)
      throw new MorphoApiError('API Morpho : trop de requêtes, réessayer plus tard', 429)
    }
    if (!res.ok) throw new MorphoApiError(`API Morpho : HTTP ${res.status}`, res.status)
    return (await res.json()) as T
  } finally {
    release()
  }
}

/** Every item of a paged route, following the cursor (at most `maxPages` pages). */
export async function morphoPages<T>(path: string, q: Query, signal?: AbortSignal, maxPages = 20): Promise<T[]> {
  const out: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const body = await morphoGet<{ data: T[]; cursor?: string | null }>(path, { ...q, cursor }, signal)
    out.push(...body.data)
    if (!body.cursor || body.data.length === 0) return out
    cursor = body.cursor
  }
  return out
}

/** `chainId:id` selector of a market, token, vault or oracle. */
export const selector = (chainId: number, id: string) => `${chainId}:${id}`

// ---------------------------------------------------------------------------------------------------------------------
// Answers (snake_case, amounts as integer strings in the token's smallest unit, WAD = 1e18)
// ---------------------------------------------------------------------------------------------------------------------

export type RestMarket = {
  chain_id: number
  market_id: string
  loan_token: string
  collateral_token: string
  oracle_address: string
  irm_address: string
  lltv_wad: string
}

export type RestStatePoint = {
  /** unix seconds */
  timestamp: number
  total_supply_assets: string
  total_supply_shares: string
  total_borrow_assets: string
  total_borrow_shares: string
  total_collateral_assets?: string
}

export type RestUserPosition = { chain_id: number; market_id: string; supply_shares: string; borrow_shares: string; collateral_assets: string }

export type RestPositionPoint = { timestamp: number; supply_shares: string; borrow_shares: string; collateral_assets: string }

export type Lookback = 'one_day' | 'seven_days' | 'thirty_days' | 'ninety_days' | 'one_year' | 'inception'

/** Daily totals of a market (weekly beyond 90 days), oldest first. */
export const marketStateHistory = (chainId: number, marketId: string, lookback: Lookback, signal?: AbortSignal) =>
  morphoGet<{ data: RestStatePoint[] }>(`/v0/blue/markets/${selector(chainId, marketId)}/state/history`, { lookback }, signal).then((b) => b.data)

// ---------------------------------------------------------------------------------------------------------------------
// GraphQL (retired January 2027): only for what is not migrated yet
// ---------------------------------------------------------------------------------------------------------------------

const GRAPHQL_API = 'https://blue-api.morpho.org/graphql'

export async function gql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(GRAPHQL_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal })
  if (!res.ok) throw new Error(`API Morpho : HTTP ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(`API Morpho : ${body.errors[0].message}`)
  if (!body.data) throw new Error('API Morpho : réponse vide')
  return body.data
}
