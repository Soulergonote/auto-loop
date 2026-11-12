/**
 * Default slippage per pair: tight between two USD stablecoins, a bit wider between correlated assets (wstETH / WETH),
 * wider still between assets that move apart and for Pendle routes (several legs, a PT's own price impact).
 * The user's own choice in "Réglages" always wins; a swap that fails on its minimum offers the next step up.
 */
import { useEffect, useState } from 'react'
import { isCorrelated, isUsdStable } from './pairs'

/** choices in bps shown in "Réglages" (0,01 % kept: the tightest, Azerty's former default) */
export const SLIPPAGES = ['1', '5', '10', '30', '100'] as const
export type SlippageBps = (typeof SLIPPAGES)[number]

export type PairKind = 'stable' | 'correlated' | 'pt' | 'other'

/** an asset as the pair classifier needs it: its symbol and its USD price */
export type PricedSymbol = { symbol: string; usd: number }

type ReserveLike = Parameters<typeof isUsdStable>[0]
const asReserve = (a: PricedSymbol) => ({ price: BigInt(Math.round(Math.max(a.usd, 0) * 1e8)), token: { symbol: a.symbol } }) as unknown as ReserveLike

/** an Aave reserve as the classifier needs it (oracle price in 8 decimals USD) */
export const reserveAsset = (r: { token: { symbol: string }; price: bigint }): PricedSymbol => ({ symbol: r.token.symbol, usd: Number(r.price) / 1e8 })

export function pairKind(collateral: PricedSymbol, debt: PricedSymbol, opts: { pt?: boolean } = {}): PairKind {
  if (opts.pt) return 'pt'
  const C = asReserve(collateral)
  const D = asReserve(debt)
  if (isUsdStable(C) && isUsdStable(D)) return 'stable'
  return isCorrelated(C, D) ? 'correlated' : 'other'
}

const DEFAULTS: Record<PairKind, SlippageBps> = { stable: '5', correlated: '10', pt: '30', other: '30' }

export const defaultSlippage = (kind: PairKind): SlippageBps => DEFAULTS[kind]

/** the next wider choice, none past the widest */
export function nextSlippage(s: SlippageBps): SlippageBps | undefined {
  const i = SLIPPAGES.indexOf(s)
  return i >= 0 && i < SLIPPAGES.length - 1 ? SLIPPAGES[i + 1] : undefined
}

/** the error text (from explainError) says the swap returned less than its minimum */
export function isSlippageFailure(text: string | undefined): boolean {
  return !!text && /moins que le minimum|InsufficientOutput|Return amount is not enough|InsufficientReturn|Too little received|insufficient output/i.test(text)
}

/** Extra worst-case loss in USD when the minimum of a swap of `sellUsd` goes from `from` to `to` bps. */
export const extraWorstCaseUsd = (sellUsd: number, from: SlippageBps, to: SlippageBps) => (sellUsd * (Number(to) - Number(from))) / 10_000

/**
 * The slippage of a panel: the pair's default until the user picks one; picking the default again keeps following
 * the pair. The pair kind changes when the user picks another pair, which resets to that pair's default.
 */
export function useSlippage(kind: PairKind) {
  const [chosen, setChosen] = useState<SlippageBps>()
  useEffect(() => setChosen(undefined), [kind])
  const slippage = chosen ?? defaultSlippage(kind)
  return { slippage, setSlippage: setChosen, auto: chosen === undefined }
}

/** "0,05 % (auto)" in the folded settings line */
export const slippageNote = (auto: boolean) => (auto ? ' (auto)' : '')
