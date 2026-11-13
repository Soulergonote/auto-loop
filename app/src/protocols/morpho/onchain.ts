/**
 * Morpho Blue markets read on-chain, for the chains Morpho's API does not cover (MegaETH today).
 *
 * Market ids come from Morpho's CreateMarket logs, scanned from its deployment and remembered in this browser (the next
 * visit only scans the newer blocks). Each market
 * is then read from Morpho (parameters, totals), its oracle and its IRM; USD prices come from DefiLlama, else from the
 * oracle price times the loan token's. No curation exists there: every such market is shown as not listed.
 */
import { createPublicClient, getAddress, http, parseAbiItem, zeroAddress, type Address, type Hex } from 'viem'
import { readContracts } from '@wagmi/core'
import { wagmiConfig } from '../../chain/wagmi'
import { erc20Abi, morphoAbi, morphoIrmAbi, morphoOracleAbi } from '../../chain/abi'
import type { MorphoNetDef, MorphoOnchainSource } from '../../config'
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
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
  /** oracle price, loan units per collateral unit x 1e36 */
  price?: bigint
  borrowRate?: bigint
}
type TokenInfo = { address: Address; symbol: string; decimals: number }

/**
 * Rows read on-chain → MorphoMarket. Dropped: idle markets (no collateral token or oracle), parameters that do not hash
 * to the id, an unreadable oracle, a token without price, and markets with less than UNLISTED_MIN_SUPPLY_USD supplied.
 */
export function buildOnchainMarkets(chainId: number, rows: OnchainRow[], tokens: Map<string, TokenInfo>, usd: Map<string, number>): MorphoMarket[] {
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
    // the collateral at DefiLlama's price, else at the oracle's (vault shares, PTs)
    const oracleUsd = (Number(r.price) / 1e36) * 10 ** (collateral.decimals - loan.decimals) * loanUsd
    const collateralUsd = usd.get(tokenKey({ chainId, address: collateral.address })) ?? (Number.isFinite(oracleUsd) && oracleUsd > 0 ? oracleUsd : 0)
    const toUsd = (v: bigint) => (Number(v) / 10 ** loan.decimals) * loanUsd
    const supplyUsd = toUsd(r.totalSupplyAssets)
    if (supplyUsd < UNLISTED_MIN_SUPPLY_USD) continue
    const liquidity = r.totalSupplyAssets > r.totalBorrowAssets ? r.totalSupplyAssets - r.totalBorrowAssets : 0n
    out.push({
      id: r.id,
      chainId,
      params: p,
      listed: false,
      source: 'chain',
      collateral: { address: collateral.address, symbol: collateral.symbol, name: collateral.symbol, decimals: collateral.decimals },
      loan: { address: loan.address, symbol: loan.symbol, name: loan.symbol, decimals: loan.decimals },
      collateralUsd,
      loanUsd,
      lltv: Number(p.lltv) / 1e18,
      borrowApy: r.borrowRate !== undefined ? rateToApy(r.borrowRate) : 0,
      borrowRewardsApr: 0,
      liquidity,
      liquidityUsd: toUsd(liquidity),
      collateralTotalUsd: 0,
      borrowUsd: toUsd(r.totalBorrowAssets),
      utilization: r.totalSupplyAssets > 0n ? Number(r.totalBorrowAssets) / Number(r.totalSupplyAssets) : 0,
      warnings: [],
    })
  }
  return out
}

/** The chain's Morpho markets, read on-chain (ids from the logs, then three multicalls and one DefiLlama request). */
export async function fetchOnchainMarkets(net: MorphoNetDef & { onchain: MorphoOnchainSource }): Promise<MorphoMarket[]> {
  const chainId = net.chain.id
  const ids = await morphoMarketIds(chainId, net.morpho, net.onchain)
  if (ids.length === 0) return []
  const base = await readContracts(wagmiConfig, {
    contracts: ids.flatMap((id) => [
      { chainId, address: net.morpho, abi: morphoAbi, functionName: 'idToMarketParams', args: [id] } as const,
      { chainId, address: net.morpho, abi: morphoAbi, functionName: 'market', args: [id] } as const,
    ]),
    allowFailure: true,
  })
  const markets = ids
    .map((id, i) => {
      const p = base[2 * i].result as readonly [Address, Address, Address, Address, bigint] | undefined
      const m = base[2 * i + 1].result as readonly [bigint, bigint, bigint, bigint, bigint, bigint] | undefined
      if (!p || !m || m[0] === 0n || p[1] === zeroAddress) return undefined
      const params: MarketParams = {
        loanToken: getAddress(p[0]),
        collateralToken: getAddress(p[1]),
        oracle: getAddress(p[2]),
        irm: getAddress(p[3]),
        lltv: p[4],
      }
      return { id, params, m }
    })
    .filter((x) => x !== undefined)
  if (markets.length === 0) return []

  const tokenAddrs = [...new Set(markets.flatMap((x) => [x.params.loanToken, x.params.collateralToken]))]
  const extra = await readContracts(wagmiConfig, {
    contracts: [
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
    ] as never,
    allowFailure: true,
  })
  const res = extra as { result?: unknown }[]
  const tokens = new Map<string, TokenInfo>()
  tokenAddrs.forEach((a, i) => {
    const symbol = res[2 * i].result as string | undefined
    const decimals = res[2 * i + 1].result as number | undefined
    if (symbol && decimals !== undefined) tokens.set(a.toLowerCase(), { address: a, symbol, decimals: Number(decimals) })
  })
  const off = tokenAddrs.length * 2
  const rows: OnchainRow[] = markets.map(({ id, params, m }, i) => ({
    id,
    params,
    totalSupplyAssets: m[0],
    totalBorrowAssets: m[2],
    price: res[off + 2 * i].result as bigint | undefined,
    borrowRate: res[off + 2 * i + 1].result as bigint | undefined,
  }))
  const quotes = await llamaQuotes(tokenAddrs.map((address) => ({ chainId, address })))
  const usd = new Map([...quotes].map(([k, v]) => [k, v.price]))
  return buildOnchainMarkets(chainId, rows, tokens, usd)
}
