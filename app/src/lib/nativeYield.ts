/**
 * Intrinsic yield of yield-bearing tokens (wstETH, weETH, sUSDe, syrupUSDC, sDAI…): the growth of their exchange rate,
 * which Aave and Morpho price but do not show as a rate.
 *
 * Current figures come from tokenYield.ts (rate published on-chain, Pendle, Morpho's API). For Aave reserves no source
 * knows, the fallback is the token's Aave price adapter: Aave prices these tokens with a "CAPO" adapter (base asset
 * price x exchange rate) that stores a snapshot of the rate and its date, set by Aave's risk stewards. Growth from that
 * snapshot to the current rate gives a trailing average, sometimes over many months. Tokens without such an adapter
 * (USDC, WETH, PT tokens…) get no value.
 */
import { readContracts } from '@wagmi/core'
import { parseAbi, type Address } from 'viem'
import { wagmiConfig } from '../wagmi'
import { fmtDate } from './format'
import { readTokenYields } from './tokenYield'

/** Where a yield comes from, freshest first; `pt` is a Pendle PT's fixed yield. */
export type YieldSource = 'rate' | 'pendle' | 'morpho' | 'aave' | 'pt'

export type NativeYield = {
  /** compounded annual yield, fraction */
  apy: number
  source: YieldSource
  /** `aave`: unix seconds of the snapshot the average starts from */
  since?: number
  /** `rate`: the rate's name (DSR, SSR…) */
  via?: string
  /** found for the same token on this other chain (a bridged copy) */
  fromChain?: number
  /** a Pendle PT: the market's fixed yield, which lasts until this date (unix seconds) */
  fixedUntil?: number
}

/** Short French note on where a yield comes from, for the screens. */
export function yieldSourceText(y: NativeYield): string {
  const chain = y.fromChain !== undefined ? (wagmiConfig.chains.find((c) => c.id === y.fromChain)?.name ?? `chaîne ${y.fromChain}`) : undefined
  const copy = chain ? `, même token sur ${chain}` : ''
  switch (y.source) {
    case 'rate':
      return `taux on-chain${y.via ? ` ${y.via}` : ''}${copy}`
    case 'pendle':
      return `Pendle, rendement récent${copy}`
    case 'morpho':
      return `API Morpho${copy}`
    case 'aave':
      return y.since ? `moyenne depuis le ${fmtDate(y.since)} (adaptateur Aave)` : 'adaptateur Aave'
    case 'pt':
      return 'rendement fixe Pendle'
  }
}

export const sourceAbi = parseAbi(['function getSourceOfAsset(address asset) view returns (address)'])
export const capoAbi = parseAbi([
  'function getRatio() view returns (int256)',
  'function getSnapshotRatio() view returns (uint256)',
  'function getSnapshotTimestamp() view returns (uint256)',
])
export const CAPO_FNS = ['getRatio', 'getSnapshotRatio', 'getSnapshotTimestamp'] as const

/** Under this window the average says more about one rebase than about the yield. */
export const MIN_WINDOW_DAYS = 7
const YEAR = 365 * 86_400

/** Annualised growth of the exchange rate since the snapshot; undefined when the adapter gives nothing usable. */
export function nativeYieldFromRatio(
  ratio: bigint | undefined,
  snapshotRatio: bigint | undefined,
  snapshotTs: bigint | undefined,
  nowSec: number,
): NativeYield | undefined {
  if (ratio === undefined || snapshotRatio === undefined || snapshotTs === undefined) return undefined
  if (ratio <= 0n || snapshotRatio <= 0n) return undefined
  const since = Number(snapshotTs)
  const elapsed = nowSec - since
  if (!(elapsed >= MIN_WINDOW_DAYS * 86_400)) return undefined
  // ratios are 1e18 to 1e27 scaled: keep 12 significant digits before going to floating point
  const growth = Number((ratio * 10n ** 12n) / snapshotRatio) / 1e12
  const apy = Math.pow(growth, YEAR / elapsed) - 1
  return Number.isFinite(apy) ? { apy, source: 'aave', since } : undefined
}

/** Net intrinsic yield on equity of a loop: the collateral's on L, minus the debt's on L - 1 when it has one. */
export const loopNativeApy = (leverage: number, collateral?: NativeYield, debt?: NativeYield) =>
  (collateral?.apy ?? 0) * leverage - (debt?.apy ?? 0) * (leverage - 1)

/**
 * Intrinsic yields of the given Aave reserves, by lower-cased address: the current figure when a source knows the token,
 * else the CAPO average. Assets with neither are left out.
 */
export async function readNativeYields(
  chainId: number,
  oracle: Address,
  assets: readonly Address[],
  nowSec = Date.now() / 1000,
): Promise<Map<string, NativeYield>> {
  const [current, capo] = await Promise.all([
    readTokenYields(chainId, assets).catch(() => new Map<string, NativeYield>()),
    readCapoYields(chainId, oracle, assets, nowSec).catch(() => new Map<string, NativeYield>()),
  ])
  return new Map([...capo, ...current])
}

/** CAPO averages of the given assets, by lower-cased address. Assets whose adapter is not a CAPO are left out. */
export async function readCapoYields(
  chainId: number,
  oracle: Address,
  assets: readonly Address[],
  nowSec = Date.now() / 1000,
): Promise<Map<string, NativeYield>> {
  const out = new Map<string, NativeYield>()
  if (assets.length === 0) return out
  const sources = await readContracts(wagmiConfig, {
    contracts: assets.map((asset) => ({ chainId, address: oracle, abi: sourceAbi, functionName: 'getSourceOfAsset', args: [asset] }) as const),
    allowFailure: true,
  })
  const found = assets.flatMap((asset, i) => {
    const source = sources[i].result as Address | undefined
    return source ? [{ asset, source }] : []
  })
  const reads = await readContracts(wagmiConfig, {
    contracts: found.flatMap(({ source }) => CAPO_FNS.map((functionName) => ({ chainId, address: source, abi: capoAbi, functionName }) as const)),
    allowFailure: true,
  })
  found.forEach(({ asset }, i) => {
    const [ratio, snapshot, ts] = reads.slice(3 * i, 3 * i + 3).map((r) => r.result as bigint | undefined)
    const y = nativeYieldFromRatio(ratio, snapshot, ts, nowSec)
    if (y) out.set(asset.toLowerCase(), y)
  })
  return out
}

/** The same read for the open panel, cached ten minutes: the rates move over weeks. */
export const nativeYieldQuery = (chainId: number, oracle: Address | undefined, assets: readonly Address[]) => ({
  queryKey: ['nativeYield', chainId, oracle, ...assets],
  queryFn: () => readNativeYields(chainId, oracle!, assets),
  enabled: !!oracle && assets.length > 0,
  staleTime: 600_000,
  retry: 1,
})
