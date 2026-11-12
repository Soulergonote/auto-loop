import type { Address, Chain } from 'viem'

export type Token = { symbol: string; name: string; address: Address; decimals: number }

/** Default pair on a new market: first symbol found in each list. */
export const DEFAULT_COLLATERAL_SYMBOLS = ['WETH', 'WETH.e', 'ETH', 'WBNB']
export const DEFAULT_DEBT_SYMBOLS = ['USDC', 'USDT0', 'USDT', 'USDt']

/** Base assets used by the demo mode (VITE_DEMO=true), where nothing is read on-chain. */
export const DEMO_TOKENS: Token[] = [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  { symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped stETH', address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18 },
  { symbol: 'weETH', name: 'Wrapped eETH', address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', decimals: 18 },
  { symbol: 'EURC', name: 'Euro Coin', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6 },
]

/**
 * The chain's wrapped native token among the market's assets (WETH, WPOL, WBNB, WAVAX, WXPL, wS, WMON…), to price
 * gas with the Aave oracle. Undefined when the market does not list it.
 */
export function wrappedNative(tokens: Token[] | undefined, chain: Chain): Token | undefined {
  const sym = chain.nativeCurrency.symbol.toUpperCase()
  const names = new Set([`W${sym}`, sym, ...(sym === 'POL' ? ['WMATIC', 'WPOL'] : [])])
  return tokens?.find((t) => names.has(t.symbol.toUpperCase()))
}
