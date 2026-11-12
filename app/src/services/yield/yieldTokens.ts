/**
 * Hand-kept data for intrinsic yields (see tokenYield.ts for how it is used). Most tokens need nothing here: Pendle and
 * Morpho's API are read for any address. Add a token here only when:
 *
 * - its contract publishes its own current rate (`ONCHAIN_RATES`): the most exact source, read on-chain;
 * - it is an ERC-4626 vault no API knows (`VAULTS`): its share price is read now and 7 days ago, on-chain;
 * - it exists on several chains and a source only knows one of them (`SAME_TOKEN`): the bridged copies earn what the
 *   original earns, e.g. syrupUSDC on Base gets the Ethereum figure. Check that prices match before adding a copy.
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
 * vault's home chain is listed; its bridged copies are in SAME_TOKEN. The chain needs an archive RPC (ARCHIVE_RPCS).
 * Checked 12 Nov 2026 (7-day yield then): savUSD 7.8 %, wsrUSD 6.2 %, syrupUSDG 4.9 %, yoUSD 5.1 %.
 * Not listed: wstUSR, whose rate has not moved for 30 days (USR depegged to ~0.03 $ in the meantime).
 */
export const VAULTS: { chainId: number; token: Address }[] = [
  // Avant savUSD (avUSD staked), native on Avalanche
  { chainId: 43114, token: '0x06d47F3fb376649c3A9Dafe069B3D6E35572219E' },
  // Reservoir wsrUSD (rUSD savings), native on Ethereum
  { chainId: 1, token: '0xd3fD63209FA2D55B07A0f6db36C2f43900be3094' },
  // Maple syrupUSDG (USDG pool), native on Ethereum
  { chainId: 1, token: '0x87b65C4aAFFA76881f9E96F3e7ED945ddFC3Cd7A' },
  // YO yoUSD (USDC), Base vault; the Ethereum vault at the same address keeps the same share price
  { chainId: 8453, token: '0x0000000f2eB9f69274678c76222B35eEc7588a65' },
]

/**
 * One token on several chains, by chain id: a copy no source knows takes the yield found for another copy (its own
 * figure always wins). Prices checked equal across copies on 10 Nov 2026 (savUSD, wsrUSD, syrupUSDG, yoUSD: 12 Nov).
 */
export const SAME_TOKEN: Record<string, Record<number, Address>> = {
  sUSDe: {
    1: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    // Ethena's OFT copy, same address on every other chain
    42161: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2',
    8453: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2',
    43114: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2',
    9745: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2',
    143: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2',
  },
  syrupUSDC: {
    1: '0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b',
    8453: '0x660975730059246A68521a3e2FBD4740173100f5',
    42161: '0x41CA7586cC1311807B4605fBB748a3B8862b42b5',
    5042: '0x0dC6b79F3c3854E4d74514fD4d29BE6c96Beee39',
  },
  sUSDS: {
    1: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
    42161: '0xdDb46999F8891663a8F2828d25298f70416d7610',
  },
  sUSDai: {
    42161: '0x0B2b2B2076d95dda7817e785989fE353fe955ef9',
    1: '0x0B2b2B2076d95dda7817e785989fE353fe955ef9',
    5042: '0x0B2b2B2076d95dda7817e785989fE353fe955ef9',
  },
  sUSN: {
    1: '0xE24a3DC889621612422A64E6388927901608B91D',
    8453: '0x34a2798D47b238A7CbA9D87D49618DEE6C4D999F',
  },
  reUSD: {
    1: '0x5086bf358635B81D8C47C66d1C8b9E567Db70c72',
    8453: '0x7D214438D0F27AfCcC23B3d1e1a53906aCE5CFEa',
  },
  savUSD: {
    43114: '0x06d47F3fb376649c3A9Dafe069B3D6E35572219E',
    1: '0xb8D89678E75a973E74698c976716308abB8a46A4',
    8453: '0xa6EF20FE18CD529cA15A8a53A29D1832B1F848ff',
    143: '0x9648dB94F1e6B19e7D755585542981F97dc806c6',
  },
  wsrUSD: {
    1: '0xd3fD63209FA2D55B07A0f6db36C2f43900be3094',
    8453: '0x62344be8CA1c339B46274a4017dd87AF436900B1',
    42161: '0x4809010926aec940b550D34a46A52739f996D75D',
    143: '0x4809010926aec940b550D34a46A52739f996D75D',
  },
  syrupUSDG: {
    1: '0x87b65C4aAFFA76881f9E96F3e7ED945ddFC3Cd7A',
    42161: '0xE1B0dC5A21b10f1634fBfbE9976fBA2Ee2e1c762',
  },
  yoUSD: {
    8453: '0x0000000f2eB9f69274678c76222B35eEc7588a65',
    1: '0x0000000f2eB9f69274678c76222B35eEc7588a65',
  },
}
