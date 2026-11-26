/**
 * What a position really earned: its flows (deposits, withdrawals, borrows, repayments, liquidations) since the first
 * one, each valued at the price of its day, against what it is worth now.
 *
 * Sources, all keyless and callable from a browser:
 * - Aave v3: Aave's API (api.v3.aave.com, userTransactionHistory of the account on a market). The API leaves out aTokens
 *   moved by a contract (the executor pulls them at close or when the collateral changes): the receipts of the
 *   transactions that repay or deposit without borrowing are read to add them.
 * - Morpho Blue: the days the position moved, from Morpho's REST API (its state day by day), then the market's events
 *   of those days read on-chain.
 * - prices of the day: DefiLlama (coins.llama.fi/batchHistorical). A token without a price there is valued at today's
 *   oracle price, and the result says so.
 */
import { getPublicClient } from '@wagmi/core'
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbiItem,
  toEventSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { wagmiConfig } from '../../chain/wagmi'
import { ARCHIVE_LOG_RPCS, LLAMA_CHAIN, MORPHO_NETWORKS } from '../../config'
import { morphoGet, selector, type RestPositionPoint } from '../../protocols/morpho/api'

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

/**
 * Morpho keeps no list of a position's transactions in its REST API, only its state day by day
 * (/position/history). The days where that state moved are searched for the market's events on-chain: one log
 * request per stretch of blocks (split in two when the RPC refuses it), the borrower side only (the account's
 * collateral, borrow, repayments and liquidations; lending the loan token is not part of a loop).
 */
const MORPHO_EVENTS = [
  parseAbiItem('event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)'),
  parseAbiItem('event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)'),
  parseAbiItem('event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)'),
  parseAbiItem('event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)'),
  parseAbiItem(
    'event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)',
  ),
] as const

type MorphoToken = { address: Address; symbol: string; decimals: number }
type PositionPoint = Pick<RestPositionPoint, 'timestamp' | 'borrow_shares' | 'collateral_assets'>
/** an hour on each side of a window: the points are daily, the block found for a time is close, not exact */
const PAD = 3_600
/** windows closer than this are searched as one (fewer requests for an account that acts every day) */
const MERGE_GAP = 2 * 86_400

/**
 * Time windows (unix seconds) where the position moved: between two daily points that differ, before the first point
 * (the opening) and after the last one (today). Overlapping windows are merged. Pure, tested.
 */
export function changedWindows(points: PositionPoint[], nowSec: number): [number, number][] {
  const p = [...points].sort((a, b) => a.timestamp - b.timestamp)
  if (p.length === 0) return []
  const same = (a: PositionPoint, b: PositionPoint) => a.borrow_shares === b.borrow_shares && a.collateral_assets === b.collateral_assets
  const step = p.length > 1 ? p[1].timestamp - p[0].timestamp : 86_400
  const raw: [number, number][] = [[p[0].timestamp - step, p[0].timestamp]]
  for (let i = 1; i < p.length; i++) if (!same(p[i - 1], p[i])) raw.push([p[i - 1].timestamp, p[i].timestamp])
  if (p[p.length - 1].timestamp < nowSec) raw.push([p[p.length - 1].timestamp, nowSec])
  const out: [number, number][] = []
  for (const [from, to] of raw.map(([f, t]) => [f - PAD, Math.min(t + PAD, nowSec)] as [number, number]))
    if (out.length && from <= out[out.length - 1][1] + MERGE_GAP) out[out.length - 1][1] = Math.max(out[out.length - 1][1], to)
    else out.push([from, to])
  return out
}

const MORPHO_TOPICS = MORPHO_EVENTS.map((e) => toEventSelector(e))

type RawLog = { transactionHash: Hex; blockNumber: Hex; blockTimestamp?: Hex; logIndex: Hex; topics: [Hex, ...Hex[]] | []; data: Hex }
const fromRawLog = (l: RawLog): MorphoLog => ({
  transactionHash: l.transactionHash,
  blockNumber: BigInt(l.blockNumber),
  blockTimestamp: l.blockTimestamp ? BigInt(l.blockTimestamp) : undefined,
  logIndex: Number(l.logIndex),
  topics: l.topics,
  data: l.data,
})

type MorphoLog = { transactionHash: Hex; blockNumber: bigint; blockTimestamp?: bigint | null; logIndex: number; topics: [Hex, ...Hex[]] | []; data: Hex }

/** Runs `fn` over the items, `size` at a time (RPC requests of a history). */
async function inPool<T>(items: T[], fn: (x: T) => Promise<unknown>, size = 6): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await fn(items[i])
    }),
  )
}

/** The account's borrower-side flows among a market's logs (pure, tested); `timeOf` gives each block's time. */
export function morphoLogFlows(logs: MorphoLog[], user: Address, collateral: MorphoToken, loan: MorphoToken, timeOf: (block: bigint) => number): Flow[] {
  const me = user.toLowerCase()
  const out: Flow[] = []
  const seen = new Set<string>()
  for (const log of [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))) {
    const key = `${log.transactionHash}:${log.logIndex}`
    if (seen.has(key) || log.topics.length === 0) continue
    seen.add(key)
    let ev
    try {
      ev = decodeEventLog({ abi: MORPHO_EVENTS, data: log.data, topics: log.topics })
    } catch {
      continue
    }
    const time = timeOf(log.blockNumber)
    const add = (kind: FlowKind, t: MorphoToken, raw: bigint) =>
      out.push({ tx: log.transactionHash, time, kind, token: t.address, symbol: t.symbol, amount: Number(raw) / 10 ** t.decimals })
    const args = ev.args as { onBehalf?: Address; borrower?: Address; assets?: bigint; repaidAssets?: bigint; seizedAssets?: bigint }
    if ((args.onBehalf ?? args.borrower)?.toLowerCase() !== me) continue
    if (ev.eventName === 'SupplyCollateral') add('supply', collateral, args.assets!)
    else if (ev.eventName === 'WithdrawCollateral') add('withdraw', collateral, args.assets!)
    else if (ev.eventName === 'Borrow') add('borrow', loan, args.assets!)
    else if (ev.eventName === 'Repay') add('repay', loan, args.assets!)
    else {
      add('seized', collateral, args.seizedAssets!)
      add('liquidationRepay', loan, args.repaidAssets!)
    }
  }
  return out
}

/** log requests a history may make (each refused stretch is split in two) */
const MAX_LOG_CALLS = 80
/**
 * requests to the archive RPC (1,000 blocks each: about 3 hours on Ethereum, 30 minutes on Base), which takes a stretch the
 * app's RPC refuses: PublicNode keeps only a few months of logs and blocks, and its fallback is often rate-limited
 */
const MAX_ARCHIVE_CALLS = 800

export async function morphoHistory(
  chainId: number,
  marketKey: Hex,
  user: Address,
  collateral: MorphoToken,
  loan: MorphoToken,
  signal?: AbortSignal,
): Promise<{ flows: Flow[]; complete: boolean }> {
  const net = MORPHO_NETWORKS.find((n) => n.chain.id === chainId)
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!net || !client) throw new Error('réseau non pris en charge')
  const points = await morphoGet<{ data: RestPositionPoint[] }>(
    `/v0/blue/markets/${selector(chainId, marketKey)}/users/${user}/position/history`,
    { lookback: 'inception' },
    signal,
  ).then((b) => b.data)
  const windows = changedWindows(points, Math.floor(Date.now() / 1000))

  const head = await client.getBlock()
  const times = new Map<bigint, number>([[head.number, Number(head.timestamp)]])
  const archive = ARCHIVE_LOG_RPCS[chainId]
  const archiveClient = archive && createPublicClient({ chain: net.chain, transport: http(archive.url, { retryCount: 2 }) })
  const timeOfBlock = async (n: bigint) => {
    if (!times.has(n)) {
      const block = await client.getBlock({ blockNumber: n }).catch((e) => (archiveClient ? archiveClient.getBlock({ blockNumber: n }) : Promise.reject(e)))
      times.set(n, Number(block.timestamp))
    }
    return times.get(n)!
  }
  /**
   * The last block at or before `ts` (within PAD): interpolation between the known blocks around it, halving when it
   * stalls. The block time is not constant over a chain's life (Base went from 2 s to 0.2 s), so no single rate is used.
   */
  const blockAt = async (ts: number) => {
    if (ts >= Number(head.timestamp)) return head.number
    let lo = 1n
    let hi = head.number
    for (const [n, t] of times) if (t <= ts && n > lo) lo = n
    for (const [n, t] of times) if (t > ts && n < hi) hi = n
    if ((await timeOfBlock(lo)) > ts) return lo
    for (let i = 0; i < 40 && hi - lo > 1n && ts - (await timeOfBlock(lo)) > PAD; i++) {
      const [tLo, tHi] = [await timeOfBlock(lo), await timeOfBlock(hi)]
      let n = i % 3 === 2 ? (lo + hi) / 2n : lo + BigInt(Math.floor((Number(hi - lo) * (ts - tLo)) / Math.max(1, tHi - tLo)))
      n = n <= lo ? lo + 1n : n >= hi ? hi - 1n : n
      if ((await timeOfBlock(n)) <= ts) lo = n
      else hi = n
    }
    return lo
  }

  let calls = 0
  let archiveCalls = 0
  let complete = true
  const logs: MorphoLog[] = []
  // raw request: viem filters on `args` for one event only, and the market id is what keeps the answer small
  const getLogs = async (c: Pick<PublicClient, 'request'>, from: bigint, to: bigint) => {
    const raw = (await c.request({
      method: 'eth_getLogs',
      params: [{ address: net.morpho, topics: [MORPHO_TOPICS, marketKey], fromBlock: toHex(from), toBlock: toHex(to) }],
    } as never)) as RawLog[]
    logs.push(...raw.map(fromRawLog))
  }
  const readArchive = async (from: bigint, to: bigint) => {
    const step = BigInt(archive!.maxBlocks)
    const chunks: bigint[] = []
    for (let a = from; a <= to; a += step) chunks.push(a)
    if (archiveCalls + chunks.length > MAX_ARCHIVE_CALLS) return void (complete = false)
    archiveCalls += chunks.length
    await inPool(chunks, (a) => getLogs(archiveClient!, a, a + step - 1n < to ? a + step - 1n : to).catch(() => void (complete = false)), 4)
  }
  const read = async (from: bigint, to: bigint, depth = 0): Promise<void> => {
    if (calls++ >= MAX_LOG_CALLS) return void (complete = false)
    try {
      await getLogs(client, from, to)
    } catch {
      if (archiveClient) return readArchive(from, to)
      if (depth >= 8 || from >= to) return void (complete = false)
      const mid = (from + to) / 2n
      await read(from, mid, depth + 1)
      await read(mid + 1n, to, depth + 1)
    }
  }
  await inPool(windows, async ([from, to]) => {
    signal?.throwIfAborted()
    const [a, b] = await Promise.all([blockAt(from), blockAt(to + PAD)])
    await read(a, b)
  })
  // the RPC may give each log its block's time; the others are read
  for (const l of logs) if (l.blockTimestamp !== undefined && l.blockTimestamp !== null) times.set(l.blockNumber, Number(l.blockTimestamp))
  await inPool([...new Set(logs.map((l) => l.blockNumber))], timeOfBlock)
  return { flows: morphoLogFlows(logs, user, collateral, loan, (b) => times.get(b) ?? 0), complete }
}

/* --------------------------------------------------------------- prices --------------------------------------------------------------- */

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
