/**
 * What a position really earned: its flows (deposits, withdrawals, borrows, repayments, liquidations) since the first
 * one, each valued at the price of its day, against what it is worth now.
 *
 * Sources, all keyless and callable from a browser:
 * - Aave v3: Aave's API (api.v3.aave.com, userTransactionHistory of the account on a market). The API leaves out aTokens
 *   moved by a contract (the executor pulls them at close or when the collateral changes): the receipts of the
 *   transactions that repay or deposit without borrowing are read to add them.
 * - Morpho Blue: Morpho's API (marketTransactions of the address on the market).
 * - prices of the day: DefiLlama (coins.llama.fi/batchHistorical). A token without a price there is valued at today's
 *   oracle price, and the result says so.
 */
import { getPublicClient } from '@wagmi/core'
import { decodeEventLog, getAddress, parseAbiItem, zeroAddress, type Address, type Hex } from 'viem'
import { wagmiConfig } from '../../chain/wagmi'

export type FlowKind = 'supply' | 'withdraw' | 'borrow' | 'repay' | 'seized' | 'liquidationRepay'

export type Flow = {
  tx: Hex
  /** unix seconds */
  time: number
  kind: FlowKind
  token: Address
  symbol: string
  /** token units */
  amount: number
}

/** value put into the position by a flow: deposits and repayments add, withdrawals, borrows and seized collateral take out */
const SIGN: Record<FlowKind, 1 | -1> = { supply: 1, repay: 1, liquidationRepay: 1, withdraw: -1, borrow: -1, seized: -1 }

/* ---------------------------------------------------------------- Aave ---------------------------------------------------------------- */

const AAVE_API = 'https://api.v3.aave.com/graphql'
const AAVE_QUERY = `query($r: UserTransactionHistoryRequest!) { userTransactionHistory(request: $r) {
  items { __typename
    ... on UserSupplyTransaction { txHash timestamp amount { amount { value } } reserve { underlyingToken { address symbol } } }
    ... on UserWithdrawTransaction { txHash timestamp amount { amount { value } } reserve { underlyingToken { address symbol } } }
    ... on UserBorrowTransaction { txHash timestamp amount { amount { value } } reserve { underlyingToken { address symbol } } }
    ... on UserRepayTransaction { txHash timestamp amount { amount { value } } reserve { underlyingToken { address symbol } } }
    ... on UserLiquidationCallTransaction { txHash timestamp
      collateral { amount { amount { value } } reserve { underlyingToken { address symbol } } }
      debtRepaid { amount { amount { value } } reserve { underlyingToken { address symbol } } } }
  }
  pageInfo { next } } }`

type AaveLeg = { amount?: { amount: { value: string } } | null; reserve: { underlyingToken: { address: string; symbol: string } } }
type AaveItem = {
  __typename: string
  txHash?: Hex
  timestamp?: string
} & Partial<AaveLeg> & { collateral?: AaveLeg; debtRepaid?: AaveLeg }

const AAVE_KIND: Record<string, FlowKind> = {
  UserSupplyTransaction: 'supply',
  UserWithdrawTransaction: 'withdraw',
  UserBorrowTransaction: 'borrow',
  UserRepayTransaction: 'repay',
}
/** at most this many pages of 50 (an account with more history gets a partial result, flagged) */
const MAX_PAGES = 20

/** Aave API items → flows (pure, tested) */
export function aaveFlows(items: AaveItem[]): Flow[] {
  const out: Flow[] = []
  const leg = (i: AaveItem, l: AaveLeg | undefined, kind: FlowKind) => {
    if (!l?.amount || !i.txHash || !i.timestamp) return
    out.push({
      tx: i.txHash,
      time: Math.floor(Date.parse(i.timestamp) / 1000),
      kind,
      token: getAddress(l.reserve.underlyingToken.address),
      symbol: l.reserve.underlyingToken.symbol,
      amount: Number(l.amount.amount.value),
    })
  }
  for (const i of items) {
    const kind = AAVE_KIND[i.__typename]
    if (kind) leg(i, i as AaveLeg, kind)
    else if (i.__typename === 'UserLiquidationCallTransaction') {
      leg(i, i.collateral, 'seized')
      leg(i, i.debtRepaid, 'liquidationRepay')
    }
  }
  return out
}

async function aaveApiFlows(chainId: number, pool: Address, user: Address, signal?: AbortSignal): Promise<{ flows: Flow[]; complete: boolean }> {
  const items: AaveItem[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const r: Response = await fetch(AAVE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: AAVE_QUERY,
        variables: { r: { market: pool, user, chainId, filter: [], orderBy: { date: 'ASC' }, pageSize: 'FIFTY', cursor } },
      }),
      signal,
    })
    if (!r.ok) throw new Error(`API Aave : ${r.status}`)
    const j = (await r.json()) as {
      data?: { userTransactionHistory: { items: AaveItem[]; pageInfo: { next: string | null } } }
      errors?: { message: string }[]
    }
    if (!j.data) throw new Error(`API Aave : ${j.errors?.[0]?.message ?? 'réponse vide'}`)
    items.push(...j.data.userTransactionHistory.items)
    cursor = j.data.userTransactionHistory.pageInfo.next
    if (!cursor) return { flows: aaveFlows(items), complete: true }
  }
  return { flows: aaveFlows(items), complete: false }
}

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

/**
 * aTokens moved in or out of the account by a contract (no Supply or Withdraw of the account itself): read from the
 * receipt of each transaction where the account repays, or deposits without borrowing (a close, a change of
 * collateral). Mints and burns (from or to the zero address) are the pool's own and already in the API.
 */
export function aTokenFlows(
  logs: { address: Address; topics: [Hex, ...Hex[]] | []; data: Hex }[],
  user: Address,
  aTokens: Map<string, { token: Address; symbol: string; decimals: number }>,
  tx: Hex,
  time: number,
): Flow[] {
  const out: Flow[] = []
  for (const log of logs) {
    const a = aTokens.get(log.address.toLowerCase())
    if (!a || log.topics.length !== 3) continue
    let ev
    try {
      ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics })
    } catch {
      continue
    }
    const { from, to, value } = ev.args
    if (from === zeroAddress || to === zeroAddress || from === to) continue
    const amount = Number(value) / 10 ** a.decimals
    if (from.toLowerCase() === user.toLowerCase()) out.push({ tx, time, kind: 'withdraw', token: a.token, symbol: a.symbol, amount })
    else if (to.toLowerCase() === user.toLowerCase()) out.push({ tx, time, kind: 'supply', token: a.token, symbol: a.symbol, amount })
  }
  return out
}

/** transactions whose receipt may hold aToken moves the API leaves out */
export function txsToInspect(flows: Flow[]): Hex[] {
  const byTx = new Map<Hex, Set<FlowKind>>()
  for (const f of flows) (byTx.get(f.tx) ?? byTx.set(f.tx, new Set()).get(f.tx)!).add(f.kind)
  return [...byTx].filter(([, k]) => k.has('repay') || (k.has('supply') && !k.has('borrow'))).map(([tx]) => tx)
}
const MAX_RECEIPTS = 60

export async function aaveHistory(
  chainId: number,
  pool: Address,
  user: Address,
  aTokens: Map<string, { token: Address; symbol: string; decimals: number }>,
  signal?: AbortSignal,
): Promise<{ flows: Flow[]; complete: boolean }> {
  const api = await aaveApiFlows(chainId, pool, user, signal)
  const client = getPublicClient(wagmiConfig, { chainId })
  const txs = txsToInspect(api.flows)
  const extra: Flow[] = []
  let complete = api.complete && txs.length <= MAX_RECEIPTS
  if (client)
    for (const tx of txs.slice(-MAX_RECEIPTS)) {
      const time = api.flows.find((f) => f.tx === tx)!.time
      try {
        const receipt = await client.getTransactionReceipt({ hash: tx })
        extra.push(...aTokenFlows(receipt.logs as never, user, aTokens, tx, time))
      } catch {
        complete = false
      }
    }
  else complete = false
  return { flows: [...api.flows, ...extra].sort((a, b) => a.time - b.time), complete }
}

/* --------------------------------------------------------------- Morpho --------------------------------------------------------------- */

const MORPHO_API = 'https://blue-api.morpho.org/graphql'
const MORPHO_QUERY = `query($u: [String!], $m: [String!], $c: [Int!], $skip: Int) {
  marketTransactions(first: 100, skip: $skip, orderBy: Timestamp, orderDirection: Asc, where: { userAddress_in: $u, marketUniqueKey_in: $m, chainId_in: $c }) {
    items { txHash timestamp type data { __typename ... on MarketTransactionTransferData { assets } ... on MarketTransactionCollateralTransferData { assets } ... on MarketTransactionLiquidationData { repaidAssets seizedAssets } } }
    pageInfo { countTotal }
  } }`

type MorphoItem = { txHash: Hex; timestamp: number | string; type: string; data: { assets?: string; repaidAssets?: string; seizedAssets?: string } }
type MorphoToken = { address: Address; symbol: string; decimals: number }

/** Morpho API items → flows (pure, tested); lender-side Supply / Withdraw of the loan token are not part of a loop */
export function morphoFlows(items: MorphoItem[], collateral: MorphoToken, loan: MorphoToken): Flow[] {
  const out: Flow[] = []
  const add = (i: MorphoItem, kind: FlowKind, t: MorphoToken, raw?: string) => {
    if (raw === undefined) return
    out.push({ tx: i.txHash, time: Number(i.timestamp), kind, token: t.address, symbol: t.symbol, amount: Number(raw) / 10 ** t.decimals })
  }
  for (const i of items) {
    if (i.type === 'SupplyCollateral') add(i, 'supply', collateral, i.data.assets)
    else if (i.type === 'WithdrawCollateral') add(i, 'withdraw', collateral, i.data.assets)
    else if (i.type === 'Borrow') add(i, 'borrow', loan, i.data.assets)
    else if (i.type === 'Repay') add(i, 'repay', loan, i.data.assets)
    else if (i.type === 'Liquidation') {
      add(i, 'seized', collateral, i.data.seizedAssets)
      add(i, 'liquidationRepay', loan, i.data.repaidAssets)
    }
  }
  return out
}

export async function morphoHistory(
  chainId: number,
  marketKey: Hex,
  user: Address,
  collateral: MorphoToken,
  loan: MorphoToken,
  signal?: AbortSignal,
): Promise<{ flows: Flow[]; complete: boolean }> {
  const items: MorphoItem[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: MORPHO_QUERY, variables: { u: [user], m: [marketKey], c: [chainId], skip: page * 100 } }),
      signal,
    })
    if (!r.ok) throw new Error(`API Morpho : ${r.status}`)
    const j = (await r.json()) as { data?: { marketTransactions: { items: MorphoItem[]; pageInfo: { countTotal: number } } }; errors?: { message: string }[] }
    if (!j.data) throw new Error(`API Morpho : ${j.errors?.[0]?.message ?? 'réponse vide'}`)
    items.push(...j.data.marketTransactions.items)
    if (items.length >= j.data.marketTransactions.pageInfo.countTotal || j.data.marketTransactions.items.length === 0)
      return { flows: morphoFlows(items, collateral, loan), complete: true }
  }
  return { flows: morphoFlows(items, collateral, loan), complete: false }
}

/* --------------------------------------------------------------- prices --------------------------------------------------------------- */

/** DefiLlama's name of each chain of the app */
export const LLAMA_CHAIN: Record<number, string> = {
  1: 'ethereum',
  42161: 'arbitrum',
  8453: 'base',
  43114: 'avax',
  10: 'optimism',
  137: 'polygon',
  56: 'bsc',
  5000: 'mantle',
  9745: 'plasma',
  59144: 'linea',
  146: 'sonic',
  143: 'monad',
  4326: 'megaeth',
  5042: 'arc',
  130: 'unichain',
  999: 'hyperliquid',
}

export const priceKey = (token: Address, time: number) => `${token.toLowerCase()}@${time}`

/** USD price of each (token, time), from DefiLlama, within 6 hours of the time; missing ones are left out */
export async function historicalPrices(chainId: number, wanted: { token: Address; time: number }[], signal?: AbortSignal): Promise<Map<string, number>> {
  const chain = LLAMA_CHAIN[chainId]
  const out = new Map<string, number>()
  if (!chain || wanted.length === 0) return out
  const byToken = new Map<string, Set<number>>()
  for (const w of wanted) (byToken.get(w.token.toLowerCase()) ?? byToken.set(w.token.toLowerCase(), new Set()).get(w.token.toLowerCase())!).add(w.time)
  // a few tokens per request keeps the address short
  const entries = [...byToken]
  for (let i = 0; i < entries.length; i += 4) {
    const coins = Object.fromEntries(entries.slice(i, i + 4).map(([t, times]) => [`${chain}:${t}`, [...times]]))
    const url = `https://coins.llama.fi/batchHistorical?coins=${encodeURIComponent(JSON.stringify(coins))}&searchWidth=6h`
    const r = await fetch(url, { signal })
    if (!r.ok) continue
    const j = (await r.json()) as { coins: Record<string, { prices: { timestamp: number; price: number }[] }> }
    for (const [key, v] of Object.entries(j.coins ?? {})) {
      const token = key.slice(key.indexOf(':') + 1).toLowerCase()
      const times = [...(byToken.get(token) ?? [])]
      // the API answers in the order asked, each at the nearest timestamp it has
      for (const t of times) {
        const best = v.prices.reduce<{ timestamp: number; price: number } | undefined>(
          (b, p) => (!b || Math.abs(p.timestamp - t) < Math.abs(b.timestamp - t) ? p : b),
          undefined,
        )
        if (best && Math.abs(best.timestamp - t) <= 6 * 3600) out.set(priceKey(token as Address, t), best.price)
      }
    }
  }
  return out
}

/* ---------------------------------------------------------------- gain ---------------------------------------------------------------- */

export type Gain = {
  /** first flow, unix seconds */
  since: number
  /** value put in minus value taken out, each at its day's price, USD */
  netInUsd: number
  /** worth now minus netIn, USD */
  gainUsd: number
  /** the same in the reference token (the position's debt asset), when its prices are known */
  gainInRef?: number
  /** annualised return on the capital, time-weighted (modified Dietz); none under a day */
  apy?: number
  /** flows valued at today's price for want of a price of their day */
  approximated: number
}

/**
 * Gain of a position worth `equityUsd` now, from its flows and the prices of their days (`prices`, USD, by priceKey).
 * `now` = today's USD price of each token (fallback for a flow without a price of its day). `ref`: the token to
 * express the gain in (its price at each flow's time and now). Pure, tested.
 */
export function positionGain(
  flows: Flow[],
  prices: Map<string, number>,
  now: Map<string, number>,
  equityUsd: number,
  nowSec: number,
  ref?: Address,
): Gain | undefined {
  if (flows.length === 0) return undefined
  const since = Math.min(...flows.map((f) => f.time))
  const span = Math.max(1, nowSec - since)
  let netInUsd = 0
  let weighted = 0
  let netInRef = 0
  let refOk = !!ref
  let approximated = 0
  const refNow = ref ? now.get(ref.toLowerCase()) : undefined
  for (const f of flows) {
    let p = prices.get(priceKey(f.token, f.time))
    if (p === undefined) {
      p = now.get(f.token.toLowerCase())
      approximated++
    }
    if (p === undefined) continue
    const usd = SIGN[f.kind] * f.amount * p
    netInUsd += usd
    weighted += (usd * (nowSec - f.time)) / span
    if (ref) {
      const r = prices.get(priceKey(ref, f.time)) ?? refNow
      if (r) netInRef += usd / r
      else refOk = false
    }
  }
  const gainUsd = equityUsd - netInUsd
  const days = (nowSec - since) / 86_400
  const ret = weighted > 0 ? gainUsd / weighted : undefined
  return {
    since,
    netInUsd,
    gainUsd,
    gainInRef: refOk && refNow ? equityUsd / refNow - netInRef : undefined,
    apy: ret !== undefined && days >= 1 && ret > -1 ? Math.pow(1 + ret, 365 / days) - 1 : undefined,
    approximated,
  }
}

/* -------------------------------------------------------------- history --------------------------------------------------------------- */

export type HistoryLine = { tx: Hex; time: number; label: string; parts: Flow[] }

/** one line per transaction, named by what it did (a loop opens with a deposit and a borrow in the same transaction) */
export function historyLines(flows: Flow[]): HistoryLine[] {
  const byTx = new Map<Hex, Flow[]>()
  for (const f of flows) (byTx.get(f.tx) ?? byTx.set(f.tx, []).get(f.tx)!).push(f)
  return [...byTx]
    .map(([tx, parts]) => {
      const k = new Set(parts.map((p) => p.kind))
      const label =
        k.has('seized') || k.has('liquidationRepay')
          ? 'Liquidation'
          : k.has('supply') && k.has('borrow')
            ? 'Ouverture ou hausse du levier'
            : k.has('repay') && k.has('withdraw')
              ? 'Fermeture ou réduction'
              : k.has('supply') && k.has('withdraw')
                ? 'Changement de collatéral'
                : k.has('supply')
                  ? 'Dépôt'
                  : k.has('withdraw')
                    ? 'Retrait'
                    : k.has('borrow')
                      ? 'Emprunt'
                      : 'Remboursement'
      return { tx, time: Math.min(...parts.map((p) => p.time)), label, parts }
    })
    .sort((a, b) => b.time - a.time)
}
