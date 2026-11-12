import { getAddress, hexToBigInt, isAddress, isHex, slice, type Address, type Hex } from 'viem'
import {
  AGGREGATORS,
  KYBER_CHAIN_SLUGS,
  KYBER_CLIENT_ID,
  KYBER_INCLUDED_SOURCES,
  QUOTE_MODE,
  VELORA_EXCLUDE_DEXS,
  VELORA_INCLUDE_DEXS,
  VELORA_PARTNER,
  aggregatorsFor,
  pendleChain,
  type AggregatorChoice,
  type AggregatorId,
  type Token,
} from '../config'
import { applySlippage, oracleSwapOut, type Side } from './math'
import {
  PENDLE_ROUTER_ADDRESS,
  isExpired,
  mintableTokensIn,
  pendleCalldataProblem,
  quoteBuyPt,
  quoteSellPt,
  readPt,
  syDepositRoom,
  type PtInfo,
} from './pendle'

export type QuoteRequest = {
  aggregator: AggregatorChoice
  chainId: number
  sell: Token
  buy: Token
  sellAmount: bigint
  /** the executor contract: it holds the tokens when the router is called */
  taker: Address
  slippageBps: bigint
  /** oracle prices, only used by the simulated quote */
  oracle: { sell: Side; buy: Side }
}

export type Quote = {
  aggregator: AggregatorId
  router: Address
  data: Hex
  sellAmount: bigint
  buyAmount: bigint
  minOut: bigint
  /** true when the quote was computed locally from oracle prices: it cannot be executed */
  simulated: boolean
  /** why the live quote was not used, when simulated */
  fallbackReason?: string
  fetchedAt: number
  /** 'best' mode: what each aggregator offered (or why it could not quote) */
  alternatives?: { aggregator: AggregatorId; buyAmount?: bigint; error?: string }[]
  /**
   * Several swaps in a row (contract v2 runs them in one transaction, each one selling what the previous one
   * delivered): set for a route through Pendle. `router`, `data` and `minOut` above are then the last leg's.
   */
  route?: RouteLeg[]
  /** the Pendle leg of the route: buy, sell or (after maturity) redeem of a PT */
  pendle?: { kind: 'buy' | 'sell' | 'redeem'; pt: Address; priceImpact: number; fixedApy?: number; expiry: number }
}

export type RouteLeg = {
  via: AggregatorId | 'pendle'
  router: Address
  sell: Token
  buy: Token
  sellAmount: bigint
  buyAmount: bigint
  minOut: bigint
  data: Hex
}

/** One contract step per leg of the quote (a single step for a plain aggregator quote). */
export function quoteSteps(q: Quote, tokenOut: Address): { router: Address; tokenOut: Address; data: Hex; minOut: bigint }[] {
  if (!q.route) return [{ router: q.router, tokenOut, data: q.data, minOut: q.minOut }]
  if (q.route.at(-1)!.buy.address.toLowerCase() !== tokenOut.toLowerCase()) throw new Error('Le devis ne finit pas dans le bon token')
  return q.route.map((l) => ({ router: l.router, tokenOut: l.buy.address, data: l.data, minOut: l.minOut }))
}

/** Who quotes it, as shown: the aggregator, Pendle, or both for a route through Pendle. */
export function quoteLabel(q: Quote): string {
  if (!q.route) return AGGREGATORS[q.aggregator].label
  return [...new Set(q.route.map((l) => (l.via === 'pendle' ? 'Pendle' : AGGREGATORS[l.via].label)))].join(' + ')
}

type SingleRequest = QuoteRequest & { aggregator: AggregatorId }

export class QuoteError extends Error {}

/** Estimated cost of a simulated swap (aggregator fee + price impact), bps. */
const SIMULATED_COST_BPS = 15n

export async function getQuote(req: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
  if (QUOTE_MODE !== 'mock' && pendleChain(req.chainId)) {
    const [ps, pb] = await Promise.all([readPt(req.chainId, req.sell.address), readPt(req.chainId, req.buy.address)])
    if (ps || pb) {
      try {
        return await pendleRoute(req, ps, pb, signal)
      } catch (e) {
        if (QUOTE_MODE === 'live' || signal?.aborted) throw e
        const first = req.aggregator === 'best' ? (aggregatorsFor(req.chainId)[0] ?? 'velora') : req.aggregator
        return simulatedQuote({ ...req, aggregator: first }, `Pendle : ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  if (req.aggregator === 'best') return bestQuote(req, signal)
  return singleQuote(req as SingleRequest, signal)
}

/** A live quote between two non-PT tokens, never simulated: the leg of a route has no oracle price of its own. */
async function liveLeg(req: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
  if (req.aggregator !== 'best') return liveQuote(req as SingleRequest, signal)
  const ids = aggregatorsFor(req.chainId)
  const settled = await Promise.allSettled(ids.map((aggregator) => liveQuote({ ...req, aggregator }, signal)))
  const quotes = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  if (quotes.length) return quotes.reduce((a, b) => (b.buyAmount > a.buyAmount ? b : a))
  throw new QuoteError(
    settled.map((r, i) => `${AGGREGATORS[ids[i]].label} : ${r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : ''}`).join(' ; '),
  )
}

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()
const has = (list: Token[], t: Address) => list.find((x) => same(x.address, t))

/**
 * A route through Pendle when either side is a PT: sell (or, after maturity, redeem) the PT for a token its SY gives
 * out, swap with an aggregator when needed, and buy the PT with a token its SY takes in. Each leg sells the previous
 * leg's guaranteed minimum; what a leg delivers above it goes back to the user with the contract's leftovers.
 */
async function pendleRoute(req: QuoteRequest, ps: PtInfo | undefined, pb: PtInfo | undefined, signal?: AbortSignal): Promise<Quote> {
  const legs: RouteLeg[] = []
  let token = req.sell
  let amount = req.sellAmount
  let pendle: Quote['pendle']
  const aggregatorLeg = async (buy: Token) => {
    const q = await liveLeg({ ...req, sell: token, buy, sellAmount: amount }, signal)
    legs.push({ via: q.aggregator, router: q.router, sell: token, buy, sellAmount: amount, buyAmount: q.buyAmount, minOut: q.minOut, data: q.data })
    token = buy
    amount = q.minOut
  }
  if (ps) {
    const out = has(ps.tokensOut, req.buy.address) ?? (pb && ps.tokensOut.find((t) => has(pb.tokensIn, t.address))) ?? ps.tokensOut[0]
    if (!out) throw new QuoteError('le SY du PT ne rend aucun token')
    const leg = await quoteSellPt(req.chainId, ps, amount, out.address, req.taker, req.slippageBps)
    const target = leg.kind === 'redeem' ? ps.yt : ps.market!
    const problem = pendleCalldataProblem(leg.data, { kind: leg.kind, receiver: req.taker, target, token: out.address, amountIn: amount, minOut: leg.minOut })
    if (problem) throw new QuoteError(problem)
    legs.push({
      via: 'pendle',
      router: PENDLE_ROUTER_ADDRESS,
      sell: token,
      buy: out,
      sellAmount: amount,
      buyAmount: leg.out,
      minOut: leg.minOut,
      data: leg.data,
    })
    pendle = { kind: leg.kind, pt: ps.pt, priceImpact: leg.priceImpact, expiry: ps.expiry }
    token = out
    amount = leg.minOut
  }
  if (pb) {
    if (isExpired(pb)) throw new QuoteError(`${req.buy.symbol} est échu : il ne s’achète plus`)
    // a token the SY deposits into a full vault (USD3 at its cap, 2026-11-09) would revert: bought as the yield token instead
    const tokensIn = mintableTokensIn(pb.tokensIn, await syDepositRoom(req.chainId, pb.sy), token.address, amount)
    const tin = has(tokensIn, token.address) ?? tokensIn[0]
    if (!tin) throw new QuoteError('le SY du PT ne prend aucun token')
    if (!same(tin.address, token.address)) await aggregatorLeg(tin)
    const leg = await quoteBuyPt(req.chainId, pb, token.address, amount, req.taker, req.slippageBps)
    const problem = pendleCalldataProblem(leg.data, {
      kind: 'buy',
      receiver: req.taker,
      target: pb.market!,
      token: token.address,
      amountIn: amount,
      minOut: leg.minOut,
    })
    if (problem) throw new QuoteError(problem)
    legs.push({
      via: 'pendle',
      router: PENDLE_ROUTER_ADDRESS,
      sell: token,
      buy: req.buy,
      sellAmount: amount,
      buyAmount: leg.out,
      minOut: leg.minOut,
      data: leg.data,
    })
    // a roll (PT to PT) shows the PT it buys
    pendle = { kind: 'buy', pt: pb.pt, priceImpact: leg.priceImpact + (pendle?.priceImpact ?? 0), fixedApy: leg.fixedApy, expiry: pb.expiry }
  } else if (!same(token.address, req.buy.address)) await aggregatorLeg(req.buy)
  if (legs.length > 4) throw new QuoteError('route trop longue')
  const last = legs.at(-1)!
  const firstAggregator = legs.find((l) => l.via !== 'pendle')?.via as AggregatorId | undefined
  return {
    aggregator: firstAggregator ?? (req.aggregator === 'best' ? (aggregatorsFor(req.chainId)[0] ?? 'velora') : req.aggregator),
    router: last.router,
    data: last.data,
    sellAmount: req.sellAmount,
    buyAmount: last.buyAmount,
    minOut: last.minOut,
    simulated: false,
    fetchedAt: Date.now(),
    route: legs,
    pendle,
  }
}

/** Asks every aggregator that quotes on the chain in parallel and keeps the one that gives the most. */
async function bestQuote(req: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
  const ids = aggregatorsFor(req.chainId)
  if (ids.length === 0) throw new QuoteError('aucun agrégateur ne cote sur ce réseau')
  if (QUOTE_MODE === 'mock') return simulatedQuote({ ...req, aggregator: ids[0] })
  const settled = await Promise.allSettled(ids.map((aggregator) => liveQuote({ ...req, aggregator }, signal)))
  const alternatives = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? { aggregator: ids[i], buyAmount: r.value.buyAmount }
      : { aggregator: ids[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
  )
  const quotes = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  if (quotes.length) return { ...quotes.reduce((a, b) => (b.buyAmount > a.buyAmount ? b : a)), alternatives }
  const reason = alternatives.map((a) => `${AGGREGATORS[a.aggregator].label} : ${a.error}`).join(' ; ')
  if (QUOTE_MODE === 'live' || signal?.aborted) throw new QuoteError(reason)
  return { ...simulatedQuote({ ...req, aggregator: ids[0] }, reason), alternatives }
}

async function singleQuote(req: SingleRequest, signal?: AbortSignal): Promise<Quote> {
  if (QUOTE_MODE === 'mock') return simulatedQuote(req)
  try {
    return await liveQuote(req, signal)
  } catch (e) {
    if (QUOTE_MODE === 'live' || signal?.aborted) throw e
    return simulatedQuote(req, `${AGGREGATORS[req.aggregator].label} : ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function simulatedQuote(req: SingleRequest, fallbackReason?: string): Quote {
  const buyAmount = oracleSwapOut(req.sellAmount, req.oracle.sell, req.oracle.buy, SIMULATED_COST_BPS)
  return {
    aggregator: req.aggregator,
    router: AGGREGATORS[req.aggregator].router,
    data: '0x',
    sellAmount: req.sellAmount,
    buyAmount,
    minOut: applySlippage(buyAmount, req.slippageBps),
    simulated: true,
    fallbackReason,
    fetchedAt: Date.now(),
  }
}

async function liveQuote(req: SingleRequest, signal?: AbortSignal): Promise<Quote> {
  const raw = await LIVE[req.aggregator](req, signal)
  const expected = AGGREGATORS[req.aggregator].router
  if (!isAddress(raw.to) || getAddress(raw.to) !== expected) {
    throw new QuoteError(`${AGGREGATORS[req.aggregator].label} renvoie un routeur inattendu (${raw.to})`)
  }
  if (!isHex(raw.data) || raw.data.length < 10) throw new QuoteError('calldata vide')
  if (raw.value && BigInt(raw.value) !== 0n) throw new QuoteError('le devis demande de l’ETH natif')
  const buyAmount = BigInt(raw.buyAmount)
  // The aggregator already enforces its own min, the contract re-checks ours as a balance delta.
  return {
    aggregator: req.aggregator,
    router: expected,
    data: raw.data as Hex,
    sellAmount: req.sellAmount,
    buyAmount,
    minOut: applySlippage(buyAmount, req.slippageBps),
    simulated: false,
    fetchedAt: Date.now(),
  }
}

/** Velora's public API allows any origin (CORS *), so the browser calls it directly: no server needed. */
const VELORA_API = 'https://api.paraswap.io'
const KYBER_API = 'https://aggregator-api.kyberswap.com'

type RawQuote = { to: string; data: string; value?: string; buyAmount: string }

async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new QuoteError('API injoignable')
  }
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    // an API host can answer 5xx with an empty body
    throw new QuoteError(res.status >= 500 ? `API injoignable (HTTP ${res.status})` : `réponse illisible (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const msg = body?.reason ?? body?.description ?? body?.error ?? body?.message ?? text.slice(0, 120)
    throw new QuoteError(`HTTP ${res.status} : ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
  }
  return body
}

const LIVE: Record<AggregatorId, (req: QuoteRequest, signal?: AbortSignal) => Promise<RawQuote>> = {
  // KyberSwap API v1: route, then build. No fee unless the integrator asks for one: any extraFee is refused.
  async kyber(req, signal) {
    const chain = KYBER_CHAIN_SLUGS[req.chainId]
    if (!chain) throw new QuoteError('KyberSwap ne couvre pas cette chaîne')
    const headers = { 'x-client-id': KYBER_CLIENT_ID }
    const q = new URLSearchParams({
      tokenIn: req.sell.address,
      tokenOut: req.buy.address,
      amountIn: req.sellAmount.toString(),
      gasInclude: 'true',
    })
    if (KYBER_INCLUDED_SOURCES) q.set('includedSources', KYBER_INCLUDED_SOURCES)
    const route = await fetchJson(`${KYBER_API}/${chain}/api/v1/routes?${q}`, { headers, signal })
    const summary = route?.data?.routeSummary
    if (!summary) throw new QuoteError(`KyberSwap : pas de route${route?.message ? ` (${route.message})` : ''}`)
    if (summary.extraFee?.feeAmount && Number(summary.extraFee.feeAmount) !== 0) {
      throw new QuoteError(`KyberSwap applique des frais (${summary.extraFee.feeAmount})`)
    }
    const built = await fetchJson(`${KYBER_API}/${chain}/api/v1/route/build`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        routeSummary: summary,
        sender: req.taker,
        recipient: req.taker,
        slippageTolerance: Number(req.slippageBps),
        deadline: Math.floor(Date.now() / 1000) + 20 * 60,
        source: KYBER_CLIENT_ID,
        // the executor holds no tokens yet when quoting
        skipSimulateTx: true,
      }),
    })
    const tx = built?.data
    if (!tx?.data) throw new QuoteError(`KyberSwap : construction refusée${built?.message ? ` (${built.message})` : ''}`)
    return { to: tx.routerAddress, data: tx.data, value: tx.transactionValue, buyAmount: tx.amountOut ?? summary.amountOut }
  },

  // Velora (ParaSwap) v6.2: price route, then transaction build with ignoreChecks (taker has no balance yet).
  async velora(req, signal) {
    const q = new URLSearchParams({
      srcToken: req.sell.address,
      destToken: req.buy.address,
      srcDecimals: String(req.sell.decimals),
      destDecimals: String(req.buy.decimals),
      amount: req.sellAmount.toString(),
      side: 'SELL',
      network: String(req.chainId),
      userAddress: req.taker,
      version: '6.2',
      partner: VELORA_PARTNER,
    })
    if (VELORA_INCLUDE_DEXS) q.set('includeDEXS', VELORA_INCLUDE_DEXS)
    if (VELORA_EXCLUDE_DEXS) q.set('excludeDEXS', VELORA_EXCLUDE_DEXS)
    const { priceRoute } = await fetchJson(`${VELORA_API}/prices?${q}`, { signal })
    if (!priceRoute) throw new QuoteError('Velora : pas de route')
    if (priceRoute.partnerFee) throw new QuoteError(`Velora applique des frais partenaire (${priceRoute.partnerFee} %)`)
    const tx = await fetchJson(`${VELORA_API}/transactions/${req.chainId}?ignoreChecks=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        srcToken: req.sell.address,
        destToken: req.buy.address,
        srcDecimals: req.sell.decimals,
        destDecimals: req.buy.decimals,
        srcAmount: req.sellAmount.toString(),
        slippage: Number(req.slippageBps),
        priceRoute,
        userAddress: req.taker,
        partner: VELORA_PARTNER,
      }),
    })
    const fee = veloraCalldataFeeBps(tx.data)
    if (fee === null) throw new QuoteError('Velora : méthode de swap inattendue')
    if (fee !== 0n) throw new QuoteError(`Velora : le calldata contient des frais (${fee} bps)`)
    return { to: tx.to, data: tx.data, value: tx.value, buyAmount: priceRoute.destAmountAfterFee ?? priceRoute.destAmount }
  },
}

/** Augustus v6.2 swapExactAmountIn selector, the only method a SELL route uses. */
const VELORA_SWAP_EXACT_IN = '0xe3ead59e'

/**
 * Fee in bps encoded in Augustus v6.2 calldata: the partnerAndFee word follows the executor and the
 * 7-word swapData tuple, its low 14 bits are the fee. Returns null for an unknown method.
 */
export function veloraCalldataFeeBps(data: string): bigint | null {
  if (!isHex(data) || data.length < 2 + 8 + 9 * 64 || data.slice(0, 10).toLowerCase() !== VELORA_SWAP_EXACT_IN) return null
  const partnerAndFee = hexToBigInt(slice(data, 4 + 32 * 8, 4 + 32 * 9))
  return partnerAndFee & 0x3fffn
}
