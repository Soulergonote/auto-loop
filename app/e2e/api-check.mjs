// Checks that every outside API the app reads still answers in the shape the app expects (S1, weekly workflow):
// Velora and KyberSwap quotes, Pendle markets, Morpho's GraphQL, Merkl campaigns, DefiLlama prices and charts.
//   node e2e/api-check.mjs        prints one line per API, exits 1 if any fails
// Same calls and fields as src/services/quotes/quotes.ts, src/protocols/pendle/pt.ts, src/protocols/morpho/api.ts,
// src/services/merkl.ts and src/services/priceHistory.ts.
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const TAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

async function json(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`)
  return JSON.parse(text)
}
const need = (cond, what) => {
  if (!cond) throw new Error(`réponse inattendue : ${what}`)
}
const isAmount = (x) => typeof x === 'string' && /^\d+$/.test(x) && BigInt(x) > 0n

const checks = {
  async velora() {
    const q = new URLSearchParams({
      srcToken: BASE_WETH,
      destToken: BASE_USDC,
      srcDecimals: '18',
      destDecimals: '6',
      amount: (10n ** 18n).toString(),
      side: 'SELL',
      network: '8453',
      userAddress: TAKER,
      version: '6.2',
      partner: 'auto-loop',
    })
    const { priceRoute } = await json(`https://api.paraswap.io/prices?${q}`)
    need(priceRoute && isAmount(priceRoute.destAmount), 'priceRoute.destAmount')
    need(!priceRoute.partnerFee, 'frais partenaire')
    const tx = await json('https://api.paraswap.io/transactions/8453?ignoreChecks=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srcToken: BASE_WETH,
        destToken: BASE_USDC,
        srcDecimals: 18,
        destDecimals: 6,
        srcAmount: (10n ** 18n).toString(),
        slippage: 30,
        priceRoute,
        userAddress: TAKER,
        partner: 'auto-loop',
      }),
    })
    need(/^0x[0-9a-f]{8}/i.test(tx.data ?? '') && /^0x[0-9a-f]{40}$/i.test(tx.to ?? ''), 'transaction')
    return `1 WETH → ${Number(priceRoute.destAmount) / 1e6} USDC`
  },
  async kyberswap() {
    const headers = { 'x-client-id': 'auto-loop' }
    const q = new URLSearchParams({ tokenIn: BASE_WETH, tokenOut: BASE_USDC, amountIn: (10n ** 18n).toString(), gasInclude: 'true' })
    const route = await json(`https://aggregator-api.kyberswap.com/base/api/v1/routes?${q}`, { headers })
    const summary = route?.data?.routeSummary
    need(summary && isAmount(summary.amountOut), 'data.routeSummary.amountOut')
    const built = await json('https://aggregator-api.kyberswap.com/base/api/v1/route/build', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeSummary: summary, sender: TAKER, recipient: TAKER, slippageTolerance: 30, source: 'auto-loop', skipSimulateTx: true }),
    })
    need(/^0x[0-9a-f]{8}/i.test(built?.data?.data ?? '') && built.data.routerAddress, 'data.data / data.routerAddress')
    return `1 WETH → ${Number(summary.amountOut) / 1e6} USDC`
  },
  async pendle() {
    const body = await json('https://api-v2.pendle.finance/core/v1/1/markets/active')
    need(Array.isArray(body.markets) && body.markets.length > 0 && /^0x[0-9a-f]{40}$/i.test(body.markets[0].address), 'markets[].address')
    const page = await json('https://api-v2.pendle.finance/core/v1/1/markets?is_expired=false&limit=5&skip=0')
    need(Array.isArray(page.results), 'results[]')
    return `${body.markets.length} marchés actifs sur Ethereum`
  },
  async morpho() {
    const body = await json('https://blue-api.morpho.org/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          '{ markets(first: 3, where: { chainId_in: [1] }) { items { marketId lltv loanAsset { address symbol decimals } state { borrowApy liquidityAssetsUsd } } } }',
      }),
    })
    const items = body?.data?.markets?.items
    need(Array.isArray(items) && items.length > 0 && /^0x[0-9a-f]{64}$/i.test(items[0].marketId) && items[0].loanAsset?.address, 'markets.items')
    need(!body.errors, JSON.stringify(body.errors ?? '').slice(0, 160))
    return `${items.length} marchés lus`
  },
  async merkl() {
    const q = new URLSearchParams({ chainId: '8453', mainProtocolId: 'aave', status: 'LIVE', items: '20', page: '0', campaigns: 'true' })
    const list = await json(`https://api.merkl.xyz/v4/opportunities?${q}`)
    need(Array.isArray(list), 'tableau d’opportunités')
    need(
      list.every((o) => typeof o.apr === 'number' && Array.isArray(o.tokens ?? [])),
      'apr / tokens',
    )
    return `${list.length} opportunités Aave sur Base`
  },
  async defillama() {
    const id = `base:${BASE_WETH}`
    const now = await json(`https://coins.llama.fi/prices/current/${id}`)
    need(now?.coins?.[id]?.price > 0, 'coins[].price')
    const chart = await json(`https://coins.llama.fi/chart/${id}?span=10&period=1d`)
    need(chart?.coins?.[id]?.prices?.length > 0 && chart.coins[id].prices[0].timestamp > 0, 'coins[].prices[]')
    return `WETH ${Math.round(now.coins[id].price)} $`
  },
}

let failed = 0
for (const [name, check] of Object.entries(checks)) {
  try {
    console.log(`ok    ${name}: ${await check()}`)
  } catch (e) {
    failed++
    console.log(`ECHEC ${name}: ${e.message}`)
  }
}
process.exitCode = failed ? 1 : 0
