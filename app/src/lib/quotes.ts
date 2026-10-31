import { getAddress, hexToBigInt, isAddress, isHex, slice, type Address, type Hex } from 'viem'
import { AGGREGATORS, QUOTE_MODE, VELORA_EXCLUDE_DEXS, VELORA_INCLUDE_DEXS, VELORA_PARTNER, type AggregatorId, type Token } from '../config'
import { applySlippage, oracleSwapOut, type Side } from './math'

export type QuoteRequest = {
  aggregator: AggregatorId
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
}

export class QuoteError extends Error {}

/** Estimated cost of a simulated swap (aggregator fee + price impact), bps. */
const SIMULATED_COST_BPS = 15n

export async function getQuote(req: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
  if (QUOTE_MODE === 'mock') return simulatedQuote(req)
  try {
    return await liveQuote(req, signal)
  } catch (e) {
    if (QUOTE_MODE === 'live' || signal?.aborted) throw e
    return simulatedQuote(req, e instanceof Error ? e.message : String(e))
  }
}

export function simulatedQuote(req: QuoteRequest, fallbackReason?: string): Quote {
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

async function liveQuote(req: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
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
    // the dev proxy answers 5xx with an empty body when it cannot reach the API host
    throw new QuoteError(res.status >= 500 ? `API injoignable (HTTP ${res.status})` : `réponse illisible (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const msg = body?.reason ?? body?.description ?? body?.error ?? body?.message ?? text.slice(0, 120)
    throw new QuoteError(`HTTP ${res.status} : ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
  }
  return body
}

const LIVE: Record<AggregatorId, (req: QuoteRequest, signal?: AbortSignal) => Promise<RawQuote>> = {
  // 0x Swap API v2, AllowanceHolder flow: approve and call transaction.to (AllowanceHolder), never Settler.
  async '0x'(req, signal) {
    const q = new URLSearchParams({
      chainId: String(req.chainId),
      sellToken: req.sell.address,
      buyToken: req.buy.address,
      sellAmount: req.sellAmount.toString(),
      taker: req.taker,
      slippageBps: req.slippageBps.toString(),
    })
    const body = await fetchJson(`/api/0x/swap/allowance-holder/quote?${q}`, { signal })
    if (body.liquidityAvailable === false) throw new QuoteError('pas de liquidité chez 0x')
    const spender = body.issues?.allowance?.spender ?? body.allowanceTarget
    if (spender && getAddress(spender) !== getAddress(body.transaction.to)) {
      throw new QuoteError('0x : la cible à approuver diffère de la cible appelée')
    }
    return { to: body.transaction.to, data: body.transaction.data, value: body.transaction.value, buyAmount: body.buyAmount }
  },

  // 1inch Swap API v6.0. disableEstimate: the contract does not hold the tokens yet when quoting.
  async '1inch'(req, signal) {
    const q = new URLSearchParams({
      src: req.sell.address,
      dst: req.buy.address,
      amount: req.sellAmount.toString(),
      from: req.taker,
      origin: req.taker,
      slippage: (Number(req.slippageBps) / 100).toString(),
      disableEstimate: 'true',
      allowPartialFill: 'false',
    })
    const body = await fetchJson(`/api/1inch/swap/v6.0/${req.chainId}/swap?${q}`, { signal })
    return { to: body.tx.to, data: body.tx.data, value: body.tx.value, buyAmount: body.dstAmount }
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
