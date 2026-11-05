import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { apyFromIndices, isRateSpike, readRateAverages, type HistoryClient } from './rateHistory'

const RAY = 10n ** 27n
const ray = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 18n
const DAY = 86_400
const USDC = '0x0000000000000000000000000000000000000001' as Address
const WETH = '0x0000000000000000000000000000000000000002' as Address
const POOL = '0x00000000000000000000000000000000000000aa' as Address

/** A chain with one block every 2 s; USDC updates every 100 blocks, WETH only before the 7-day window start. */
function fakeChain(opts: { failBelow?: bigint } = {}): HistoryClient & { logCalls: number } {
  const head = 2_000_000n
  const ts = (b: bigint) => 1_800_000_000 - Number(head - b) * 2
  const client = {
    logCalls: 0,
    async getBlock(args?: { blockNumber: bigint }) {
      const n = args?.blockNumber ?? head
      return { number: n, timestamp: BigInt(ts(n)) }
    },
    async getLogs({ args, fromBlock, toBlock }: { args: { reserve: Address[] }; fromBlock: bigint; toBlock: bigint }) {
      client.logCalls++
      if (opts.failBelow !== undefined && fromBlock < opts.failBelow) throw new Error('archive requests require a token')
      const out = []
      for (let b = fromBlock; b <= toBlock; b++) {
        if (args.reserve.includes(USDC) && b % 100n === 0n) {
          // USDC: supply 4 %, borrow 6 %, compounded, as seen at block b
          const t = (ts(b) - 1_700_000_000) / (365 * DAY)
          out.push({ blockNumber: b, args: { reserve: USDC, liquidityIndex: ray(Math.pow(1.04, t)), variableBorrowIndex: ray(Math.pow(1.06, t)) } })
        }
        if (args.reserve.includes(WETH) && b === head - 302_400n - 900n)
          out.push({ blockNumber: b, args: { reserve: WETH, liquidityIndex: RAY, variableBorrowIndex: RAY } })
      }
      return out
    },
    async readContract({ functionName, args }: { functionName: string; args: [Address] }) {
      const t = (ts(head) - 1_700_000_000) / (365 * DAY)
      if (args[0] === USDC) return ray(Math.pow(functionName === 'getReserveNormalizedIncome' ? 1.04 : 1.06, t))
      return functionName === 'getReserveNormalizedIncome' ? RAY : ray(1.001)
    },
  }
  return client
}

describe('average Aave rates', () => {
  it('annualises the growth of an index', () => {
    expect(apyFromIndices(RAY, ray(1.05), 365 * DAY)).toBeCloseTo(0.05, 6)
    expect(apyFromIndices(RAY, ray(Math.pow(1.05, 30 / 365)), 30 * DAY)).toBeCloseTo(0.05, 6)
    expect(apyFromIndices(0n, RAY, DAY)).toBeUndefined()
    expect(apyFromIndices(RAY, RAY, 0)).toBeUndefined()
  })

  it('calls a borrow rate a spike at 1.5 times its average and one point above', () => {
    expect(isRateSpike(0.09, 0.05)).toBe(true)
    expect(isRateSpike(0.07, 0.05)).toBe(false)
    expect(isRateSpike(0.012, 0.006)).toBe(false)
    expect(isRateSpike(0.09, undefined)).toBe(false)
  })

  it('reads the 7- and 30-day averages from the last update before each window', async () => {
    const avg = await readRateAverages(fakeChain(), POOL, [USDC, WETH])
    const usdc = avg.get(USDC.toLowerCase())!
    expect(usdc.supply[7]).toBeCloseTo(0.04, 5)
    expect(usdc.borrow[30]).toBeCloseTo(0.06, 5)
    // WETH: one update just before the 7-day start, none within 12 hours of the 30-day one
    const weth = avg.get(WETH.toLowerCase())!
    expect(weth.borrow[7]).toBeGreaterThan(0)
    expect(weth.borrow[30]).toBeUndefined()
  })

  it('keeps the 7-day average when the RPC has no logs that far back for 30 days', async () => {
    const avg = await readRateAverages(fakeChain({ failBelow: 2_000_000n - 500_000n }), POOL, [USDC])
    const usdc = avg.get(USDC.toLowerCase())!
    expect(usdc.borrow[7]).toBeCloseTo(0.06, 5)
    expect(usdc.borrow[30]).toBeUndefined()
  })
})
