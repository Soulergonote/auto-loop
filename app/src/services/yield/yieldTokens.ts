/**
 * Hand-kept data for intrinsic yields (see tokenYield.ts for how it is used). Most tokens need nothing here: Pendle and
 * Morpho's API are read for any address. Add a token here only when:
 *
 * - its contract publishes its own current rate (`ONCHAIN_RATES`): the most exact source, read on-chain;
 * - it is an ERC-4626 vault no API knows (`VAULTS`): its share price is read now and 7 days ago, on-chain;
 * - only as a last resort, a bridged copy that copies.ts cannot match on its own (`SAME_TOKEN`). Copies are found
 *   automatically (same symbol and price, on any chain): a new chain or a new bridged token needs nothing here.
 */
import type { Address } from 'viem'

/** A rate the token's contract (or its savings module) publishes: a per-second ray (1e27), as Maker/Sky contracts do. */
export type OnchainRate = { chainId: number; token: Address; source: Address; fn: 'dsr' | 'ssr' | 'str'; label: string }

export const ONCHAIN_RATES: OnchainRate[] = [
  // sDAI earns the DAI Savings Rate, set in the Pot
  { chainId: 1, token: '0x83F20F44975D03b1b09e64809B757c47f942BEeA', source: '0x197E90f9FAD81970bA7976f33CbD77088E5D7cf7', fn: 'dsr', label: 'DSR' },
  // sUSDS earns the Sky Savings Rate, stored in the token itself
  { chainId: 1, token: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', source: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', fn: 'ssr', label: 'SSR' },
  // stUSDS (Sky staking) stores its rate as `str`
  { chainId: 1, token: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9', source: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9', fn: 'str', label: 'STR' },
]

/**
 * ERC-4626 vaults whose yield no API gives: the growth of `convertToAssets` over the last 7 days, annualised. Only the
 * vault's home chain is listed; its bridged copies are found automatically. The chain needs an archive RPC (ARCHIVE_RPCS).
 * Checked 12 Nov 2026 (7-day yield then): savUSD 7.8 %, wsrUSD 6.2 %, syrupUSDG 4.9 %, yoUSD 5.1 %.
 * Not listed: wstUSR, whose rate has not moved for 30 days (USR depegged to ~0.03 $ in the meantime).
 */
export const VAULTS: { chainId: number; token: Address; /** the share price read: ERC-4626 convertToAssets(1e18) by default */ fn?: 'getRate' }[] = [
  // Avant savUSD (avUSD staked), native on Avalanche
  { chainId: 43114, token: '0x06d47F3fb376649c3A9Dafe069B3D6E35572219E' },
  // Reservoir wsrUSD (rUSD savings), native on Ethereum
  { chainId: 1, token: '0xd3fD63209FA2D55B07A0f6db36C2f43900be3094' },
  // Maple syrupUSDG (USDG pool), native on Ethereum
  { chainId: 1, token: '0x87b65C4aAFFA76881f9E96F3e7ED945ddFC3Cd7A' },
  // YO yoUSD (USDC), Base vault; the Ethereum vault at the same address keeps the same share price
  { chainId: 8453, token: '0x0000000f2eB9f69274678c76222B35eEc7588a65' },
  // spUSDG (USDG savings vault), Robinhood Chain only; 3.8 % over 7 and 30 days on 12 Nov 2026
  { chainId: 4663, token: '0xde770c84FE66E063336b31737cFE9790f18c4087' },
  // Yields the Morpho GraphQL API gave (its REST API has none), read the same way since 26 Nov 2026; 7-day yield then
  // (Morpho's figure in brackets): syrupUSDC 5.3 % (5.2), syrupUSDT 4.8 % (4.0), sDOLA 5.2 % (5.4), weETH 2.4 % (2.4),
  // v-wmtUSDC 8.9 % (8.5), v-wmtUSDT 9.2 % (8.8), v-wmtWBTC 3.6 % (3.5)
  { chainId: 1, token: '0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b' },
  { chainId: 1, token: '0x356B8d89c1e1239Cbbb9dE4815c39A1474d5BA7D' },
  { chainId: 1, token: '0xb45ad160634c528Cc3D2926d9807104FA3157305' },
  // weETH: not a 4626 vault, eETH per weETH from getRate()
  { chainId: 1, token: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', fn: 'getRate' },
  { chainId: 1, token: '0xF65460B84c13eeb911303336Ab0f9D63CC79839f' },
  { chainId: 1, token: '0x82c3C0f95f2b7b6b1F0D2c9bA2334a2aff66d0c1' },
  { chainId: 1, token: '0x7D7f0fC27E53239e8e50dE461d2a544917AB4366' },
]

/**
 * Copies copies.ts cannot match (a token no price feed knows): by chain id, the copies earn what the original earns.
 * Empty since 12 Nov 2026: every former entry (sUSDe, syrupUSDC, sUSDS, sUSDai, sUSN, reUSD, savUSD, wsrUSD,
 * syrupUSDG, yoUSD) is matched automatically. Check that prices match before adding one.
 */
export const SAME_TOKEN: Record<string, Record<number, Address>> = {}
