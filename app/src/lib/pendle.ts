/**
 * Pendle PTs (principal tokens): detection, Pendle market, fixed yield, and the router calls that buy, sell or redeem
 * them. A PT trades below 1 unit of its underlying asset and is redeemed 1 for 1 at maturity: the gap is a fixed
 * yield. Aave lists some PTs as collateral, priced by a feed that discounts linearly to maturity (not by Pendle).
 *
 * Everything is read on-chain: PT contracts answer SY(), YT() and expiry(); Pendle's RouterStatic quotes the router's
 * swaps; the market of a PT comes from a fixed list (config.ts) and from Pendle's API when it answers, each one checked
 * against Pendle's market factory. Calldata is built here for the router's plain paths (token in the SY's own list, no
 * external aggregator, no limit orders), then decoded again before use.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import { readContract, readContracts } from '@wagmi/core'
import { wagmiConfig } from '../wagmi'
import type { NativeYield } from './nativeYield'
import { PENDLE_FACTORIES, PENDLE_MARKETS, PENDLE_PY_ORACLE, PENDLE_ROUTER, PENDLE_ROUTER_STATIC, pendleChain, type Token } from '../config'

export const ptAbi = parseAbi([
  'function SY() view returns (address)',
  'function YT() view returns (address)',
  'function expiry() view returns (uint256)',
  'function isExpired() view returns (bool)',
])
const syAbi = parseAbi([
  'function getTokensIn() view returns (address[])',
  'function getTokensOut() view returns (address[])',
  'function exchangeRate() view returns (uint256)',
])
export const marketAbi = parseAbi([
  'function readTokens() view returns (address SY, address PT, address YT)',
  'function factory() view returns (address)',
  'function expiry() view returns (uint256)',
  'function _storage() view returns (int128 totalPt, int128 totalSy, uint96 lastLnImpliedRate, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext)',
])
const factoryAbi = parseAbi(['function isValidMarket(address) view returns (bool)'])
const erc20MetaAbi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
/** Aave's PendlePriceCapAdapter (and the fork test feed): what the discount of the PT's Aave price is. */
export const ptFeedAbi = parseAbi(['function discountRatePerYear() view returns (uint256)', 'function MATURITY() view returns (uint256)'])

const staticAbi = parseAbi([
  'function swapExactTokenForPtStatic(address market, address tokenIn, uint256 netTokenIn) view returns (uint256 netPtOut, uint256 netSyMinted, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter)',
  'function swapExactPtForTokenStatic(address market, uint256 exactPtIn, address tokenOut) view returns (uint256 netTokenOut, uint256 netSyToRedeem, uint256 netSyFee, uint256 priceImpact, uint256 exchangeRateAfter)',
  'function redeemPyToTokenStatic(address YT, uint256 netPYToRedeem, address tokenOut) view returns (uint256 netTokenOut)',
])

const swapData = '(uint8 swapType, address extRouter, bytes extCalldata, bool needScale)'
const tokenInput = `(address tokenIn, uint256 netTokenIn, address tokenMintSy, address pendleSwap, ${swapData} swapData)`
const tokenOutput = `(address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap, ${swapData} swapData)`
const approx = '(uint256 guessMin, uint256 guessMax, uint256 guessOffchain, uint256 maxIteration, uint256 eps)'
const order =
  '(uint256 salt, uint256 expiry, uint256 nonce, uint8 orderType, address token, address YT, address maker, address receiver, uint256 makingAmount, uint256 lnImpliedRate, uint256 failSafeRate, bytes permit)'
const fill = `(${order} order, bytes signature, uint256 makingAmount)`
const limit = `(address limitRouter, uint256 epsSkipMarket, ${fill}[] normalFills, ${fill}[] flashFills, bytes optData)`

/** Pendle RouterV4 entry points the app uses (Pendle's ActionSwapPTV3 / ActionMiscV3 facets). */
export const pendleRouterAbi = parseAbi([
  `function swapExactTokenForPt(address receiver, address market, uint256 minPtOut, ${approx} guessPtOut, ${tokenInput} input, ${limit} limit) payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm)`,
  `function swapExactPtForToken(address receiver, address market, uint256 exactPtIn, ${tokenOutput} output, ${limit} limit) returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)`,
  `function redeemPyToToken(address receiver, address YT, uint256 netPyIn, ${tokenOutput} output) returns (uint256 netTokenOut, uint256 netSyInterm)`,
])

const NO_SWAP = { swapType: 0, extRouter: zeroAddress, extCalldata: '0x', needScale: false } as const
const NO_LIMIT = { limitRouter: zeroAddress, epsSkipMarket: 0n, normalFills: [], flashFills: [], optData: '0x' } as const

export type PtInfo = {
  pt: Address
  sy: Address
  yt: Address
  /** unix seconds */
  expiry: number
  /** past maturity on chain (the chain's clock, which a test fork can move) */
  expired: boolean
  /** tokens the SY takes in and gives out (the router's plain paths), with their symbol and decimals */
  tokensIn: Token[]
  tokensOut: Token[]
  /** Pendle market of the PT, checked against Pendle's factory; undefined when none is known */
  market?: Address
  /** the market's last implied APY (fraction), when there is a market */
  impliedApy?: number
}

const YEAR = 365 * 86_400

/** Pendle stores ln(1 + implied APY) scaled by 1e18. */
export const impliedApyFromLn = (ln: bigint) => Math.exp(Number(ln) / 1e18) - 1

/** APY locked by buying `ptOut` PT for `assetIn` units of the underlying asset, `secondsLeft` before maturity. */
export function fixedApy(ptOut: bigint, assetIn: bigint, secondsLeft: number): number | undefined {
  if (ptOut <= 0n || assetIn <= 0n || !(secondsLeft > 0)) return undefined
  const ratio = Number((ptOut * 10n ** 12n) / assetIn) / 1e12
  const y = Math.pow(ratio, YEAR / secondsLeft) - 1
  return Number.isFinite(y) ? y : undefined
}

/** The PT's yield as the app counts it: the market's implied APY until maturity, nothing after (redeemed 1 for 1). */
export function ptYield(pt: PtInfo, nowSec = Date.now() / 1000): NativeYield | undefined {
  if (isExpired(pt, nowSec) || pt.impliedApy === undefined) return undefined
  return { apy: pt.impliedApy, source: 'pt', fixedUntil: pt.expiry }
}

export const isExpired = (pt: Pick<PtInfo, 'expiry' | 'expired'>, nowSec = Date.now() / 1000) => pt.expired || nowSec >= pt.expiry
export const daysToMaturity = (pt: Pick<PtInfo, 'expiry'>, nowSec = Date.now() / 1000) => (pt.expiry - nowSec) / 86_400

/**
 * Health factor at maturity, prices of everything else unchanged: Aave's PT price climbs from (1 - discount x time
 * left) of the underlying to 1, the debt grows at its borrow rate.
 */
export function hfAtMaturity(healthFactor: number, discountPerYear: number, borrowApy: number, days: number): number {
  if (!Number.isFinite(healthFactor) || days <= 0) return healthFactor
  const priceNow = 1 - (discountPerYear * days) / 365
  if (!(priceNow > 0)) return healthFactor
  return healthFactor / priceNow / Math.pow(1 + borrowApy, days / 365)
}

// ---------------------------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------------------------

export function buyPtCalldata(p: { receiver: Address; market: Address; tokenIn: Address; amountIn: bigint; minPtOut: bigint; ptOut: bigint }): Hex {
  return encodeFunctionData({
    abi: pendleRouterAbi,
    functionName: 'swapExactTokenForPt',
    args: [
      p.receiver,
      p.market,
      p.minPtOut,
      // the static quote is the starting guess; the router searches between the minimum and a little above it
      { guessMin: p.minPtOut, guessMax: (p.ptOut * 105n) / 100n, guessOffchain: p.ptOut, maxIteration: 30n, eps: 10n ** 14n },
      { tokenIn: p.tokenIn, netTokenIn: p.amountIn, tokenMintSy: p.tokenIn, pendleSwap: zeroAddress, swapData: NO_SWAP },
      NO_LIMIT,
    ],
  })
}

export function sellPtCalldata(p: { receiver: Address; market: Address; ptIn: bigint; tokenOut: Address; minOut: bigint }): Hex {
  return encodeFunctionData({
    abi: pendleRouterAbi,
    functionName: 'swapExactPtForToken',
    args: [
      p.receiver,
      p.market,
      p.ptIn,
      { tokenOut: p.tokenOut, minTokenOut: p.minOut, tokenRedeemSy: p.tokenOut, pendleSwap: zeroAddress, swapData: NO_SWAP },
      NO_LIMIT,
    ],
  })
}

/** After maturity: PT redeemed 1 for 1 through its YT (no YT needed any more), no pool, no price impact. */
export function redeemPtCalldata(p: { receiver: Address; yt: Address; ptIn: bigint; tokenOut: Address; minOut: bigint }): Hex {
  return encodeFunctionData({
    abi: pendleRouterAbi,
    functionName: 'redeemPyToToken',
    args: [p.receiver, p.yt, p.ptIn, { tokenOut: p.tokenOut, minTokenOut: p.minOut, tokenRedeemSy: p.tokenOut, pendleSwap: zeroAddress, swapData: NO_SWAP }],
  })
}

export type PendleTerms = {
  kind: 'buy' | 'sell' | 'redeem'
  receiver: Address
  /** market (buy, sell) or YT (redeem) */
  target: Address
  tokenIn?: Address
  tokenOut?: Address
  amountIn: bigint
  minOut: bigint
  /** the call routes through an external aggregator or limit orders */
  external: boolean
}

/** What a Pendle router calldata does; undefined for any other method. */
export function pendleTerms(data: Hex): PendleTerms | undefined {
  try {
    const d = decodeFunctionData({ abi: pendleRouterAbi, data })
    if (d.functionName === 'swapExactTokenForPt') {
      const [receiver, market, minPtOut, , input, lim] = d.args
      return {
        kind: 'buy',
        receiver: getAddress(receiver),
        target: getAddress(market),
        tokenIn: getAddress(input.tokenIn),
        amountIn: input.netTokenIn,
        minOut: minPtOut,
        external: input.pendleSwap !== zeroAddress || input.swapData.swapType !== 0 || lim.limitRouter !== zeroAddress,
      }
    }
    if (d.functionName === 'swapExactPtForToken') {
      const [receiver, market, ptIn, out, lim] = d.args
      return {
        kind: 'sell',
        receiver: getAddress(receiver),
        target: getAddress(market),
        tokenOut: getAddress(out.tokenOut),
        amountIn: ptIn,
        minOut: out.minTokenOut,
        external: out.pendleSwap !== zeroAddress || out.swapData.swapType !== 0 || lim.limitRouter !== zeroAddress,
      }
    }
    const [receiver, yt, ptIn, out] = d.args
    return {
      kind: 'redeem',
      receiver: getAddress(receiver),
      target: getAddress(yt),
      tokenOut: getAddress(out.tokenOut),
      amountIn: ptIn,
      minOut: out.minTokenOut,
      external: out.pendleSwap !== zeroAddress || out.swapData.swapType !== 0,
    }
  } catch {
    return undefined
  }
}

/**
 * Why a Pendle step cannot be signed, or undefined: same method, output to the executor, the PT's own market (or YT),
 * same token and amount in, a minimum not below the quote's, and no external route or limit order inside.
 */
export function pendleCalldataProblem(
  data: Hex,
  expected: { kind: PendleTerms['kind']; receiver: Address; target: Address; token: Address; amountIn: bigint; minOut: bigint },
): string | undefined {
  const t = pendleTerms(data)
  if (!t || t.kind !== expected.kind) return 'appel Pendle inattendu'
  if (t.receiver !== getAddress(expected.receiver)) return 'l’appel Pendle paie une autre adresse que le contrat'
  if (t.target !== getAddress(expected.target)) return expected.kind === 'redeem' ? 'YT différent de celui du PT' : 'marché Pendle différent de celui du PT'
  if ((t.tokenIn ?? t.tokenOut) !== getAddress(expected.token)) return 'token de l’appel Pendle différent du devis'
  if (t.amountIn !== expected.amountIn) return 'montant de l’appel Pendle différent du devis'
  if (t.minOut < expected.minOut) return 'minimum de l’appel Pendle sous celui du devis'
  if (t.external) return 'l’appel Pendle passe par un agrégateur externe ou des ordres limites'
  return undefined
}

// ---------------------------------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------------------------------

const PENDLE_API = 'https://api-v2.pendle.finance/core'

/** Markets Pendle's API lists as active on the chain; [] when it does not answer (CORS, network). Checked on-chain after. */
async function apiMarkets(chainId: number): Promise<Address[]> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 6_000)
    const res = await fetch(`${PENDLE_API}/v1/${chainId}/markets/active`, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return []
    const body = (await res.json()) as { markets?: { address?: string }[] }
    return (body.markets ?? []).flatMap((m) => (m.address && /^0x[0-9a-fA-F]{40}$/.test(m.address) ? [getAddress(m.address)] : []))
  } catch {
    return []
  }
}

/** PT address (lower case) → its market, for every market Pendle's factory vouches for. */
async function readMarkets(chainId: number): Promise<Map<string, Address>> {
  const factories = new Set((PENDLE_FACTORIES[chainId] ?? []).map((f) => f.toLowerCase()))
  const candidates = [...new Set([...(PENDLE_MARKETS[chainId] ?? []).map((m) => getAddress(m)), ...(await apiMarkets(chainId))])]
  const out = new Map<string, Address>()
  if (candidates.length === 0) return out
  const reads = await readContracts(wagmiConfig, {
    contracts: candidates.flatMap((address) => [
      { chainId, address, abi: marketAbi, functionName: 'readTokens' } as const,
      { chainId, address, abi: marketAbi, functionName: 'factory' } as const,
    ]),
    allowFailure: true,
  })
  const found = candidates.flatMap((market, i) => {
    const tokens = reads[2 * i].result as readonly [Address, Address, Address] | undefined
    const factory = reads[2 * i + 1].result as Address | undefined
    return tokens && factory && factories.has(factory.toLowerCase()) ? [{ market, pt: tokens[1], factory }] : []
  })
  const valid = await readContracts(wagmiConfig, {
    contracts: found.map((f) => ({ chainId, address: f.factory, abi: factoryAbi, functionName: 'isValidMarket', args: [f.market] }) as const),
    allowFailure: true,
  })
  found.forEach((f, i) => {
    if (valid[i].result === true) out.set(f.pt.toLowerCase(), f.market)
  })
  return out
}

const marketCache = new Map<number, { at: number; value: Promise<Map<string, Address>> }>()
function marketsOf(chainId: number): Promise<Map<string, Address>> {
  const hit = marketCache.get(chainId)
  if (hit && Date.now() - hit.at < 600_000) return hit.value
  const value = readMarkets(chainId).catch(() => new Map<string, Address>())
  marketCache.set(chainId, { at: Date.now(), value })
  return value
}

async function tokenMeta(chainId: number, addresses: readonly Address[]): Promise<Token[]> {
  const r = await readContracts(wagmiConfig, {
    contracts: addresses.flatMap((address) => [
      { chainId, address, abi: erc20MetaAbi, functionName: 'symbol' } as const,
      { chainId, address, abi: erc20MetaAbi, functionName: 'decimals' } as const,
    ]),
    allowFailure: true,
  })
  return addresses.map((address, i) => {
    const symbol = (r[2 * i].result as string | undefined) ?? `${address.slice(0, 6)}…`
    return { address: getAddress(address), symbol, name: symbol, decimals: Number((r[2 * i + 1].result as number | undefined) ?? 18) }
  })
}

const vaultAbi = parseAbi([
  'function yieldToken() view returns (address)',
  'function asset() view returns (address)',
  'function maxDeposit(address) view returns (uint256)',
])

/**
 * What the SY of a PT can still mint from tokens other than its yield token: those are deposited into the yield token
 * (an ERC-4626 vault for most), which may be capped. `max` is the vault's maxDeposit for the SY, in `asset` units;
 * undefined when the SY or its yield token does not tell (not a vault): then nothing is known to be blocked.
 */
export async function syDepositRoom(chainId: number, sy: Address): Promise<{ yieldToken: Address; asset?: Address; max?: bigint } | undefined> {
  try {
    const [y] = await readContracts(wagmiConfig, { contracts: [{ chainId, address: sy, abi: vaultAbi, functionName: 'yieldToken' }], allowFailure: true })
    if (typeof y.result !== 'string') return undefined
    const yieldToken = getAddress(y.result)
    const [asset, max] = await readContracts(wagmiConfig, {
      contracts: [
        { chainId, address: yieldToken, abi: vaultAbi, functionName: 'asset' },
        { chainId, address: yieldToken, abi: vaultAbi, functionName: 'maxDeposit', args: [sy] },
      ],
      allowFailure: true,
    })
    return {
      yieldToken,
      asset: typeof asset.result === 'string' ? getAddress(asset.result) : undefined,
      max: typeof max.result === 'bigint' ? max.result : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Tokens the SY can take for `amount` of `held` now: the yield token always; the others (deposited into it) only while
 * its vault has room: at least `amount` when `held` is the vault's asset, otherwise any room at all.
 */
export function mintableTokensIn(tokensIn: Token[], room: Awaited<ReturnType<typeof syDepositRoom>>, held: Address, amount: bigint): Token[] {
  if (!room || room.max === undefined) return tokensIn
  const max = room.max
  return tokensIn.filter((t) => {
    const a = t.address.toLowerCase()
    if (a === room.yieldToken.toLowerCase()) return true
    const need = room.asset && a === room.asset.toLowerCase() && a === held.toLowerCase() ? amount : 1n
    return max >= need
  })
}

/** PtInfo of each of these tokens that is a Pendle PT (lower-cased address → info); other tokens are left out. */
export async function readPtInfos(chainId: number, tokens: readonly Address[]): Promise<Map<string, PtInfo>> {
  const out = new Map<string, PtInfo>()
  if (!pendleChain(chainId) || tokens.length === 0) return out
  const probe = await readContracts(wagmiConfig, {
    contracts: tokens.flatMap((address) =>
      (['SY', 'YT', 'expiry', 'isExpired'] as const).map((functionName) => ({ chainId, address, abi: ptAbi, functionName }) as const),
    ),
    allowFailure: true,
  })
  const pts = tokens.flatMap((pt, i) => {
    const [sy, yt, expiry, expired] = probe.slice(4 * i, 4 * i + 4).map((r) => r.result)
    return typeof sy === 'string' && typeof yt === 'string' && typeof expiry === 'bigint' && expiry > 0n
      ? [{ pt: getAddress(pt), sy: getAddress(sy), yt: getAddress(yt), expiry: Number(expiry), expired: expired === true }]
      : []
  })
  if (pts.length === 0) return out
  const [lists, markets] = await Promise.all([
    readContracts(wagmiConfig, {
      contracts: pts.flatMap(({ sy }) =>
        (['getTokensIn', 'getTokensOut'] as const).map((functionName) => ({ chainId, address: sy, abi: syAbi, functionName }) as const),
      ),
      allowFailure: true,
    }),
    marketsOf(chainId),
  ])
  const withMarket = pts.map((p) => ({ ...p, market: markets.get(p.pt.toLowerCase()) }))
  const states = await readContracts(wagmiConfig, {
    contracts: withMarket.map((p) => ({ chainId, address: p.market ?? zeroAddress, abi: marketAbi, functionName: '_storage' }) as const),
    allowFailure: true,
  })
  const all = [...new Set(lists.flatMap((l) => ((l.result as readonly Address[] | undefined) ?? []).map((a) => getAddress(a))))]
  const meta = new Map((await tokenMeta(chainId, all)).map((t) => [t.address, t]))
  const toTokens = (l: readonly Address[] | undefined) => (l ?? []).map((a) => meta.get(getAddress(a))!).filter(Boolean)
  withMarket.forEach((p, i) => {
    const st = p.market ? (states[i].result as readonly [bigint, bigint, bigint, number, number, number] | undefined) : undefined
    out.set(p.pt.toLowerCase(), {
      ...p,
      tokensIn: toTokens(lists[2 * i].result as readonly Address[] | undefined),
      tokensOut: toTokens(lists[2 * i + 1].result as readonly Address[] | undefined),
      impliedApy: st ? impliedApyFromLn(st[2]) : undefined,
    })
  })
  return out
}

const ptCache = new Map<string, { at: number; value: Promise<PtInfo | undefined> }>()
/** PtInfo of one token, cached ten minutes; undefined when it is not a PT (or the chain has no Pendle). */
export function readPt(chainId: number, token: Address): Promise<PtInfo | undefined> {
  if (!pendleChain(chainId)) return Promise.resolve(undefined)
  const key = `${chainId}:${token.toLowerCase()}`
  const hit = ptCache.get(key)
  if (hit && Date.now() - hit.at < 600_000) return hit.value
  const value = readPtInfos(chainId, [token])
    .then((m) => m.get(token.toLowerCase()))
    .catch(() => {
      ptCache.delete(key)
      return undefined
    })
  ptCache.set(key, { at: Date.now(), value })
  return value
}

/** Forgets the cached PT infos (a test fork moved its clock). */
export const forgetPts = () => ptCache.clear()

/** The react-query options of the PT infos of a market's tokens. */
export const ptInfosQuery = (chainId: number, tokens: readonly Address[]) => ({
  queryKey: ['pendle-pts', chainId, ...tokens],
  queryFn: () => readPtInfos(chainId, tokens),
  enabled: pendleChain(chainId) && tokens.length > 0,
  staleTime: 600_000,
  retry: 1,
})

/** Annual discount of the PT's Aave price feed (fraction), when the feed exposes it. */
export async function readFeedDiscount(chainId: number, oracle: Address, pt: Address): Promise<number | undefined> {
  try {
    const source = await readContract(wagmiConfig, {
      chainId,
      address: oracle,
      abi: parseAbi(['function getSourceOfAsset(address) view returns (address)']),
      functionName: 'getSourceOfAsset',
      args: [pt],
    })
    const d = await readContract(wagmiConfig, { chainId, address: source, abi: ptFeedAbi, functionName: 'discountRatePerYear' })
    return Number(d) / 1e18
  } catch {
    return undefined
  }
}

/** 15-minute TWAP of the PT's price in its underlying asset (1 = par), from Pendle's PT oracle; undefined if unreadable. */
export async function readPtTwap(chainId: number, market: Address): Promise<number | undefined> {
  const oracle = PENDLE_PY_ORACLE[chainId]
  if (!oracle) return undefined
  try {
    const rate = await readContract(wagmiConfig, {
      chainId,
      address: oracle,
      abi: parseAbi(['function getPtToAssetRate(address market, uint32 duration) view returns (uint256)']),
      functionName: 'getPtToAssetRate',
      args: [market, 900],
    })
    return Number(rate) / 1e18
  } catch {
    return undefined
  }
}

/** Price of the PT in its underlying asset that a fixed APY means, `days` before maturity. */
export const ptPriceFromApy = (apy: number, days: number) => Math.pow(1 + apy, -Math.max(0, days) / 365)

// ---------------------------------------------------------------------------------------------
// Quotes (RouterStatic)
// ---------------------------------------------------------------------------------------------

export type PendleLeg = { kind: 'buy' | 'sell' | 'redeem'; amountIn: bigint; out: bigint; minOut: bigint; data: Hex; priceImpact: number; fixedApy?: number }

const applyBps = (x: bigint, bps: bigint) => (x * (10_000n - bps)) / 10_000n

function staticAt(chainId: number): Address {
  const s = PENDLE_ROUTER_STATIC[chainId]
  if (!s) throw new Error('Pendle n’est pas proposé sur ce réseau')
  return s
}

/** Buys the PT with `amountIn` of `tokenIn` (one of the SY's tokens in), output to `receiver`. */
export async function quoteBuyPt(chainId: number, pt: PtInfo, tokenIn: Address, amountIn: bigint, receiver: Address, slippageBps: bigint): Promise<PendleLeg> {
  if (!pt.market) throw new Error('marché Pendle introuvable pour ce PT')
  const [res, rate] = await Promise.all([
    readContract(wagmiConfig, {
      chainId,
      address: staticAt(chainId),
      abi: staticAbi,
      functionName: 'swapExactTokenForPtStatic',
      args: [pt.market, tokenIn, amountIn],
    }),
    readContract(wagmiConfig, { chainId, address: pt.sy, abi: syAbi, functionName: 'exchangeRate' }),
  ])
  const [ptOut, syMinted, , impact] = res
  const minOut = applyBps(ptOut, slippageBps)
  return {
    kind: 'buy',
    amountIn,
    out: ptOut,
    minOut,
    data: buyPtCalldata({ receiver, market: pt.market, tokenIn, amountIn, minPtOut: minOut, ptOut }),
    priceImpact: Number(impact) / 1e18,
    // the SY minted, valued in the underlying asset at the SY's exchange rate, buys ptOut redeemable 1 for 1
    fixedApy: fixedApy(ptOut, (syMinted * rate) / 10n ** 18n, pt.expiry - Date.now() / 1000),
  }
}

/** Sells `ptIn` PT for `tokenOut` (one of the SY's tokens out) before maturity, or redeems it after. */
export async function quoteSellPt(chainId: number, pt: PtInfo, ptIn: bigint, tokenOut: Address, receiver: Address, slippageBps: bigint): Promise<PendleLeg> {
  if (isExpired(pt)) {
    const out = await readContract(wagmiConfig, {
      chainId,
      address: staticAt(chainId),
      abi: staticAbi,
      functionName: 'redeemPyToTokenStatic',
      args: [pt.yt, ptIn, tokenOut],
    })
    // no pool: the SY's own rate, which only moves with the underlying's yield; 1 bps of room for rounding
    const minOut = applyBps(out, 1n)
    return { kind: 'redeem', amountIn: ptIn, out, minOut, data: redeemPtCalldata({ receiver, yt: pt.yt, ptIn, tokenOut, minOut }), priceImpact: 0 }
  }
  if (!pt.market) throw new Error('marché Pendle introuvable pour ce PT')
  const [out, , , impact] = await readContract(wagmiConfig, {
    chainId,
    address: staticAt(chainId),
    abi: staticAbi,
    functionName: 'swapExactPtForTokenStatic',
    args: [pt.market, ptIn, tokenOut],
  })
  const minOut = applyBps(out, slippageBps)
  return {
    kind: 'sell',
    amountIn: ptIn,
    out,
    minOut,
    data: sellPtCalldata({ receiver, market: pt.market, ptIn, tokenOut, minOut }),
    priceImpact: Number(impact) / 1e18,
  }
}

export const PENDLE_ROUTER_ADDRESS = getAddress(PENDLE_ROUTER)

/** Days before maturity from which a PT position is offered a roll into a later PT. */
export const RENEW_DAYS = 30

/** A PT position is due for a roll in its last month, or once matured. */
export const needsRenewal = (pt: Pick<PtInfo, 'expiry' | 'expired'>, nowSec = Date.now() / 1000) =>
  isExpired(pt, nowSec) || daysToMaturity(pt, nowSec) < RENEW_DAYS
