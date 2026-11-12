/**
 * Average Aave rates over the last 7 and 30 days, so that a loop is not opened on a borrow-rate spike.
 *
 * Source: the pool's ReserveDataUpdated events, emitted on every action on a reserve with its liquidity and
 * variable-borrow indices. The last event before "now − 7 days" gives the indices then; the pool's normalized
 * income / debt give them now. Growth of an index between the two, annualised, is the average compounded APY over
 * the window. Events only need log access around one block (no archive state), which public RPCs keep longer.
 */
import { getPublicClient } from '@wagmi/core'
import { useQuery } from '@tanstack/react-query'
import { parseAbi, parseAbiItem, type Address } from 'viem'
import { wagmiConfig } from '../../chain/wagmi'
import { DEMO } from '../../config'

export const WINDOWS = [7, 30] as const
export type Window = (typeof WINDOWS)[number]

/** Average APYs of a reserve per window, fractions; a window is missing when its history could not be read. */
export type RateAverages = { supply: Partial<Record<Window, number>>; borrow: Partial<Record<Window, number>> }

const YEAR = 365 * 86_400
const DAY = 86_400

export const reserveDataUpdated = parseAbiItem(
  'event ReserveDataUpdated(address indexed reserve, uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex)',
)
const indexAbi = parseAbi([
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  'function getReserveNormalizedVariableDebt(address asset) view returns (uint256)',
])

/** Annualised compounded growth of an Aave index (ray) over `seconds`. */
export function apyFromIndices(then: bigint, now: bigint, seconds: number): number | undefined {
  if (then <= 0n || now < then || !(seconds > 0)) return undefined
  const growth = Number((now * 10n ** 12n) / then) / 1e12
  return Math.pow(growth, YEAR / seconds) - 1
}

/**
 * A borrow rate well above its own average: at least 1.5 times the 30-day average and one point more.
 * Rates mean-revert after a utilisation spike, so the loop would be priced on a rate that does not last.
 */
export function isRateSpike(now: number, average: number | undefined): boolean {
  return average !== undefined && now >= average * 1.5 && now - average >= 0.01
}

/** What the search needs from a viem public client (a fake one in tests). */
export type HistoryClient = {
  getBlock(args?: { blockNumber: bigint }): Promise<{ number: bigint; timestamp: bigint }>
  getLogs(args: {
    address: Address
    event: typeof reserveDataUpdated
    args: { reserve: Address[] }
    fromBlock: bigint
    toBlock: bigint
  }): Promise<{ blockNumber: bigint | null; args: { reserve?: Address; liquidityIndex?: bigint; variableBorrowIndex?: bigint } }[]>
  readContract(args: {
    address: Address
    abi: typeof indexAbi
    functionName: 'getReserveNormalizedIncome' | 'getReserveNormalizedVariableDebt'
    args: [Address]
    blockNumber: bigint
  }): Promise<bigint>
}

/** Blocks used to measure the chain's block time. */
const SAMPLE_BLOCKS = 10_000n
/** One log request covers about an hour of blocks, capped for RPCs that limit the range. */
const CHUNK_SECONDS = 3_600
const MAX_CHUNK_BLOCKS = 10_000n
/** An idle reserve with no event in the 12 hours before the window start has no average. */
const MAX_CHUNKS = 12

type Snapshot = { liquidityIndex: bigint; variableBorrowIndex: bigint; timestamp: number }

/** Average supply and borrow APYs of the given reserves over 7 and 30 days, by lower-cased address. */
export async function readRateAverages(client: HistoryClient, pool: Address, assets: Address[]): Promise<Map<string, RateAverages>> {
  const latest = await client.getBlock()
  const sample = await client.getBlock({ blockNumber: latest.number - SAMPLE_BLOCKS })
  const blockTime = Number(latest.timestamp - sample.timestamp) / Number(SAMPLE_BLOCKS)
  const now = Number(latest.timestamp)
  const chunk = (() => {
    const b = BigInt(Math.max(1, Math.round(CHUNK_SECONDS / blockTime)))
    return b < MAX_CHUNK_BLOCKS ? b : MAX_CHUNK_BLOCKS
  })()

  const current = await Promise.all(
    assets.flatMap((asset) =>
      (['getReserveNormalizedIncome', 'getReserveNormalizedVariableDebt'] as const).map((functionName) =>
        client.readContract({ address: pool, abi: indexAbi, functionName, args: [asset], blockNumber: latest.number }),
      ),
    ),
  )

  const out = new Map<string, RateAverages>(assets.map((a) => [a.toLowerCase(), { supply: {}, borrow: {} }]))
  await Promise.all(
    WINDOWS.map(async (days) => {
      // an RPC that keeps less history fails one window only: the 7-day average can show without the 30-day one
      const found = await indicesBefore(client, pool, assets, latest.number - BigInt(Math.round((days * DAY) / blockTime)), chunk).catch(
        () => new Map<string, Snapshot>(),
      )
      assets.forEach((asset, i) => {
        const then = found.get(asset.toLowerCase())
        if (!then) return
        const avg = out.get(asset.toLowerCase())!
        const seconds = now - then.timestamp
        const supply = apyFromIndices(then.liquidityIndex, current[2 * i], seconds)
        const borrow = apyFromIndices(then.variableBorrowIndex, current[2 * i + 1], seconds)
        if (supply !== undefined) avg.supply[days] = supply
        if (borrow !== undefined) avg.borrow[days] = borrow
      })
    }),
  )
  return out
}

/** Indices of each reserve at its last update at or before `target`, searching back an hour at a time. */
async function indicesBefore(client: HistoryClient, pool: Address, assets: Address[], target: bigint, chunk: bigint): Promise<Map<string, Snapshot>> {
  const last = new Map<string, { block: bigint; liquidityIndex: bigint; variableBorrowIndex: bigint }>()
  let to = target
  for (let i = 0; i < MAX_CHUNKS && last.size < assets.length; i++) {
    const missing = assets.filter((a) => !last.has(a.toLowerCase()))
    const logs = await client.getLogs({ address: pool, event: reserveDataUpdated, args: { reserve: missing }, fromBlock: to - chunk + 1n, toBlock: to })
    for (const l of logs) {
      const key = l.args.reserve?.toLowerCase()
      if (!key || l.blockNumber === null || l.args.liquidityIndex === undefined || l.args.variableBorrowIndex === undefined) continue
      const prev = last.get(key)
      if (!prev || l.blockNumber >= prev.block)
        last.set(key, { block: l.blockNumber, liquidityIndex: l.args.liquidityIndex, variableBorrowIndex: l.args.variableBorrowIndex })
    }
    to -= chunk
  }
  const blocks = [...new Set([...last.values()].map((v) => v.block))]
  const times = new Map(await Promise.all(blocks.map(async (b) => [b, Number((await client.getBlock({ blockNumber: b })).timestamp)] as const)))
  return new Map(
    [...last].map(([k, v]) => [k, { liquidityIndex: v.liquidityIndex, variableBorrowIndex: v.variableBorrowIndex, timestamp: times.get(v.block)! }]),
  )
}

/** The averages of a pair for the loop view, cached half an hour; a failed read only leaves them out. */
export const rateAveragesQuery = (chainId: number, pool: Address, assets: Address[], enabled = true) => ({
  queryKey: ['rateAverages', chainId, pool, ...assets],
  queryFn: () => readRateAverages(getPublicClient(wagmiConfig, { chainId }) as unknown as HistoryClient, pool, assets),
  enabled,
  staleTime: 30 * 60_000,
  retry: 1,
})

/** The pair's averages in the loop view (both legs, one read shared by the rates table and the open panel). */
export function useRateAverages(chainId: number, pool: Address, assets: Address[]) {
  return useQuery(rateAveragesQuery(chainId, pool, assets, !DEMO))
}
