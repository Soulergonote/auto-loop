/**
 * Morpho Blue markets read on-chain: every market the app shows, whoever lists it.
 *
 * The list comes from Morpho's REST API (markets.ts), or, on the chains it does not cover (MegaETH today), from
 * Morpho's CreateMarket logs, scanned from its deployment and remembered in this browser (the next visit only scans
 * the newer blocks). Each market is then read from Morpho (totals, and the parameters when the list has none), its
 * oracle and its IRM; USD prices come from DefiLlama, else from Morpho's API, else (collateral) from the oracle price
 * times the loan token's. No curation exists on the chains read from the logs: their markets are shown as not listed.
 */
import { createPublicClient, getAddress, http, parseAbiItem, zeroAddress, type Address, type Hex } from 'viem'
import { readContracts } from '@wagmi/core'
import { wagmiConfig } from '../../chain/wagmi'
import { erc20Abi, morphoAbi, morphoIrmAbi, morphoOracleAbi } from '../../chain/abi'
import type { MorphoNetDef, MorphoOnchainSource } from '../../config'
import { tokenPrices } from './api'
import { llamaQuotes, tokenKey } from '../../services/yield/copies'
import { marketId, rateToApy, UNLISTED_MIN_SUPPLY_USD, type MarketParams, type MorphoMarket } from './markets'

const CREATE_MARKET = parseAbiItem(
  'event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)',
)
/** a browser scans at most this many log ranges per visit; what is left is scanned on the next one */
export const MAX_LOG_CALLS = 120
const LOG_CONCURRENCY = 4

// ---------------------------------------------------------------------------------------------------------------------
// Market ids
// ---------------------------------------------------------------------------------------------------------------------

type IdCache = { toBlock: string; ids: Hex[] }
const cacheKey = (chainId: number) => `auto-loop.morpho-ids.${chainId}`

function loadCache(chainId: number): IdCache | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(cacheKey(chainId)) ?? 'null') as IdCache | null
    return v && typeof v.toBlock === 'string' && Array.isArray(v.ids) ? v : undefined
  } catch {
    return undefined
  }
}

function saveCache(chainId: number, toBlock: bigint, ids: Hex[]) {
  try {
    localStorage.setItem(cacheKey(chainId), JSON.stringify({ toBlock: toBlock.toString(), ids }))
  } catch {
    // private window or blocked storage: the blocks after the snapshot are scanned again next time
  }
}

/**
 * Block ranges of `chunk` blocks from `from` to `to`, at most `max` of them (oldest first, so that what was scanned
 * stays one contiguous stretch). Without `chunk`, one range.
 */
export function logRanges(from: bigint, to: bigint, chunk: bigint | undefined, max = MAX_LOG_CALLS): [bigint, bigint][] {
  if (from > to) return []
  if (!chunk) return [[from, to]]
  const out: [bigint, bigint][] = []
  for (let b = from; b <= to && out.length < max; b += chunk) out.push([b, b + chunk - 1n < to ? b + chunk - 1n : to])
  return out
}

/** Every market id of the chain: what this browser already scanned, then the newer blocks. */
export async function morphoMarketIds(chainId: number, morpho: Address, src: MorphoOnchainSource): Promise<Hex[]> {
  const ids = new Set<Hex>()
  let from = src.fromBlock
  const cached = loadCache(chainId)
  if (cached && BigInt(cached.toBlock) >= from) {
    cached.ids.forEach((id) => ids.add(id))
    from = BigInt(cached.toBlock) + 1n
  }
  const client = createPublicClient({ transport: http(src.logsRpc, { timeout: 15_000, retryCount: 2 }) })
  const latest = await client.getBlockNumber()
  const ranges = logRanges(from, latest, src.chunk)
  // ranges run a few at a time; the cache only moves up to the last range of an unbroken run of successes
  const ok: boolean[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(LOG_CONCURRENCY, ranges.length) }, async () => {
      for (let i = next++; i < ranges.length; i = next++) {
        try {
          const logs = await client.getLogs({ address: morpho, event: CREATE_MARKET, fromBlock: ranges[i][0], toBlock: ranges[i][1] })
          logs.forEach((l) => l.args.id && ids.add(l.args.id))
          ok[i] = true
        } catch {
          ok[i] = false
        }
      }
    }),
  )
  const done = ok.findIndex((v) => !v)
  const last = done === -1 ? ranges.length - 1 : done - 1
  if (last >= 0) saveCache(chainId, ranges[last][1], [...ids])
  else if (ranges.length > 0 && done === 0 && ids.size === 0) throw new Error('journal des marchés Morpho illisible sur ce réseau')
  return [...ids]
}

// ---------------------------------------------------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------------------------------------------------

export type OnchainRow = {
  id: Hex
  params: MarketParams
  /** in Morpho's registry (from the API); markets read from the logs never are */
  listed: boolean
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
  /** oracle price, loan units per collateral unit x 1e36 */
  price?: bigint
  borrowRate?: bigint
}
type TokenInfo = { address: Address; symbol: string; decimals: number }

export type BuildOptions = {
  /** markets read from the logs (a chain the API does not cover) */
  fromLogs?: boolean
  /** not-listed markets with less supplied are dropped (default UNLISTED_MIN_SUPPLY_USD; 0 for a user's own markets) */
  minUnlistedUsd?: number
}

/**
 * Rows read on-chain → MorphoMarket. Dropped: idle markets (no collateral token or oracle), parameters that do not hash
 * to the id, an unreadable oracle, a loan token without price, and not-listed markets with less than `minUnlistedUsd`
 * supplied.
 */
export function buildOnchainMarkets(
  chainId: number,
  rows: OnchainRow[],
  tokens: Map<string, TokenInfo>,
  usd: Map<string, number>,
  opts: BuildOptions = {},
): MorphoMarket[] {
  const min = opts.minUnlistedUsd ?? UNLISTED_MIN_SUPPLY_USD
  const out: MorphoMarket[] = []
  for (const r of rows) {
    const p = r.params
    if (p.collateralToken === zeroAddress || p.oracle === zeroAddress || !r.price) continue
    if (marketId(p).toLowerCase() !== r.id.toLowerCase()) continue
    const loan = tokens.get(p.loanToken.toLowerCase())
    const collateral = tokens.get(p.collateralToken.toLowerCase())
    if (!loan || !collateral) continue
    const loanUsd = usd.get(tokenKey({ chainId, address: loan.address })) ?? 0
    if (loanUsd <= 0) continue
    // the collateral at its own price, else at the oracle's (vault shares, PTs)
    const oracleUsd = (Number(r.price) / 1e36) * 10 ** (collateral.decimals - loan.decimals) * loanUsd
    const collateralUsd = usd.get(tokenKey({ chainId, address: collateral.address })) ?? (Number.isFinite(oracleUsd) && oracleUsd > 0 ? oracleUsd : 0)
    const toUsd = (v: bigint) => (Number(v) / 10 ** loan.decimals) * loanUsd
    if (!r.listed && toUsd(r.totalSupplyAssets) < min) continue
    const liquidity = r.totalSupplyAssets > r.totalBorrowAssets ? r.totalSupplyAssets - r.totalBorrowAssets : 0n
    out.push({
      id: r.id,
      chainId,
      params: p,
      listed: r.listed,
      ...(opts.fromLogs && { source: 'chain' as const }),
      collateral: { address: collateral.address, symbol: collateral.symbol, name: collateral.symbol, decimals: collateral.decimals },
      loan: { address: loan.address, symbol: loan.symbol, name: loan.symbol, decimals: loan.decimals },
      collateralUsd,
      loanUsd,
      lltv: Number(p.lltv) / 1e18,
      borrowApy: r.borrowRate !== undefined ? rateToApy(r.borrowRate) : 0,
      liquidity,
      liquidityUsd: toUsd(liquidity),
      borrowUsd: toUsd(r.totalBorrowAssets),
      utilization: r.totalSupplyAssets > 0n ? Number(r.totalBorrowAssets) / Number(r.totalSupplyAssets) : 0,
    })
  }
  return out
}

/** calls per multicall request: market() answers 192 bytes, so a few hundred stay well under what RPCs accept */
const CALLS_PER_READ = 400

/** Reads many calls of one chain in multicalls of CALLS_PER_READ, a few at a time. */
async function readMany(contracts: readonly unknown[]): Promise<{ result?: unknown }[]> {
  const parts: (readonly unknown[])[] = []
  for (let i = 0; i < contracts.length; i += CALLS_PER_READ) parts.push(contracts.slice(i, i + CALLS_PER_READ))
  const out: { result?: unknown }[][] = []
  for (let i = 0; i < parts.length; i += 4)
    out.push(
      ...(await Promise.all(
        parts
          .slice(i, i + 4)
          .map((c) => readContracts(wagmiConfig, { contracts: c as never, allowFailure: true, batchSize: 64_000 }) as Promise<{ result?: unknown }[]>),
      )),
    )
  return out.flat()
}

export type MarketEntry = { id: Hex; listed: boolean; params?: MarketParams }

/**
 * These markets read on-chain: parameters (when the entry has none), totals, oracle price, borrow rate, token symbols
 * and decimals, then USD prices. A not-listed market with nothing supplied is dropped before the oracle and IRM reads
 * when a minimum applies (Base lists over 4,000 such markets).
 */
export async function readMarketsOnchain(chainId: number, morpho: Address, entries: MarketEntry[], opts: BuildOptions = {}): Promise<MorphoMarket[]> {
  if (entries.length === 0) return []
  const needParams = entries.filter((e) => !e.params)
  const base = await readMany([
    ...needParams.map((e) => ({ chainId, address: morpho, abi: morphoAbi, functionName: 'idToMarketParams', args: [e.id] }) as const),
    ...entries.map((e) => ({ chainId, address: morpho, abi: morphoAbi, functionName: 'market', args: [e.id] }) as const),
  ])
  const params = new Map<Hex, MarketParams>()
  needParams.forEach((e, i) => {
    const p = base[i].result as readonly [Address, Address, Address, Address, bigint] | undefined
    if (p) params.set(e.id, { loanToken: getAddress(p[0]), collateralToken: getAddress(p[1]), oracle: getAddress(p[2]), irm: getAddress(p[3]), lltv: p[4] })
  })
  const min = opts.minUnlistedUsd ?? UNLISTED_MIN_SUPPLY_USD
  const markets = entries
    .map((e, i) => {
      const p = e.params ?? params.get(e.id)
      const m = base[needParams.length + i].result as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined
      if (!p || !m || p.collateralToken === zeroAddress) return undefined
      if (!e.listed && min > 0 && m[0] === 0n) return undefined
      return { ...e, params: p, m }
    })
    .filter((x) => x !== undefined)
  if (markets.length === 0) return []

  const tokenAddrs = [...new Set(markets.flatMap((x) => [x.params.loanToken, x.params.collateralToken]))]
  const res = await readMany([
    ...tokenAddrs.flatMap((a) => [
      { chainId, address: a, abi: erc20Abi, functionName: 'symbol' } as const,
      { chainId, address: a, abi: erc20Abi, functionName: 'decimals' } as const,
    ]),
    ...markets.flatMap(({ params, m }) => [
      { chainId, address: params.oracle, abi: morphoOracleAbi, functionName: 'price' } as const,
      {
        chainId,
        address: params.irm,
        abi: morphoIrmAbi,
        functionName: 'borrowRateView',
        args: [params, { totalSupplyAssets: m[0], totalSupplyShares: m[1], totalBorrowAssets: m[2], totalBorrowShares: m[3], lastUpdate: m[4], fee: m[5] }],
      } as const,
    ]),
  ])
  const tokens = new Map<string, TokenInfo>()
  tokenAddrs.forEach((a, i) => {
    const symbol = res[2 * i].result as string | undefined
    const decimals = res[2 * i + 1].result as number | undefined
    if (symbol && decimals !== undefined) tokens.set(a.toLowerCase(), { address: a, symbol, decimals: Number(decimals) })
  })
  const off = tokenAddrs.length * 2
  const rows: OnchainRow[] = markets.map(({ id, listed, params, m }, i) => ({
    id,
    listed,
    params,
    totalSupplyAssets: m[0],
    totalBorrowAssets: m[2],
    price: res[off + 2 * i].result as bigint | undefined,
    borrowRate: res[off + 2 * i + 1].result as bigint | undefined,
  }))
  const quotes = await llamaQuotes(tokenAddrs.map((address) => ({ chainId, address })))
  const usd = new Map([...quotes].map(([k, v]) => [k, v.price]))
  // loan tokens DefiLlama does not price: Morpho's API (a chain it covers), a few at most
  if (!opts.fromLogs) {
    const missing = [...new Set(rows.map((r) => r.params.loanToken))].filter((a) => !usd.has(tokenKey({ chainId, address: a })))
    for (const [k, v] of await tokenPrices(chainId, missing)) usd.set(k, v)
  }
  return buildOnchainMarkets(chainId, rows, tokens, usd, opts)
}

/** The chain's Morpho markets, read on-chain (ids from the logs). */
export async function fetchOnchainMarkets(net: MorphoNetDef & { onchain: MorphoOnchainSource }): Promise<MorphoMarket[]> {
  const ids = await morphoMarketIds(net.chain.id, net.morpho, net.onchain)
  return readMarketsOnchain(
    net.chain.id,
    net.morpho,
    ids.map((id) => ({ id, listed: false })),
    { fromLogs: true },
  )
}
