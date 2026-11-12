/** What kind of pair two priced assets make (same family, USD stablecoins), from their oracle price and symbol. */

/** An asset as the oracle prices it (8 decimals, USD) with its symbol. */
export type PricedToken = { price: bigint; token: { symbol: string } }

const NOT_USD = /EUR|GBP|CHF|JPY|XAU|PAXG|GOLD|BTC|ETH|SOL|AVAX|BNB|POL|MATIC|XPL|MON|LINK|AAVE/i

/** USD stablecoin, including yield-bearing ones (sUSDe, sUSDS…): oracle price between 0.95 and 1.35 USD. */
export function isUsdStable(r: PricedToken): boolean {
  const usd = Number(r.price) / 1e8
  return usd >= 0.95 && usd <= 1.35 && !NOT_USD.test(r.token.symbol)
}

/** What an asset follows, from its symbol: USD stablecoins (by price), EUR, BTC and ETH with their derivatives. */
export function assetFamily(r: PricedToken): string {
  if (isUsdStable(r)) return 'USD'
  const sym = r.token.symbol.toUpperCase()
  for (const f of ['EUR', 'BTC', 'ETH']) if (sym.includes(f)) return f
  return sym
}

/**
 * Both legs move together: two USD stablecoins, or the same family priced alike (wstETH / WETH, cbBTC / WBTC):
 * a staked derivative is worth a bit more than its base, up to 1.6x. EURC / USDC is not correlated.
 */
export function isCorrelated(C: PricedToken, D: PricedToken): boolean {
  if (isUsdStable(C) && isUsdStable(D)) return true
  const ratio = Number(C.price) / Number(D.price)
  return assetFamily(C) === assetFamily(D) && ratio >= 0.97 && ratio <= 1.6
}
