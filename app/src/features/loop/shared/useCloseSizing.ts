/**
 * Sizing of « Fermer ou réduire » for a position that is one collateral against one debt (Morpho market, Aave v4 pair):
 * the leverage aimed at, the debt to repay, the collateral to sell for it and its quote.
 */
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import type { AggregatorChoice } from '../../../config'
import { collateralToSellForRepay, roundSignificant, type Side } from '../../../domain/math'
import type { SlippageBps } from '../../../domain/slippage'
import { collateralInLoan, morphoLeverage, repayForMorphoLeverage } from '../../../protocols/morpho/markets'
import type { QuoteRequest } from '../../../services/quotes/quotes'
import { useQuote } from '../../../services/quotes/useQuote'
import { useDebounced } from '../../../ui/useDebounced'

export function useCloseSizing(p: {
  /** the position, in token units, and the oracle price of the collateral in the debt token (Morpho's scale) */
  coll: bigint
  debt: bigint
  price: bigint
  sides: { collateral: Side; loan: Side }
  slippage: SlippageBps
  /** leverage to start at (a rebalance from Positions); otherwise 1 = close everything */
  seedTarget?: number
  /** a full close sells all the collateral whatever the debt (a matured PT: nothing to hold any more) */
  sellAllOnFull?: boolean
  swap: { aggregator: AggregatorChoice; chainId: number; sell: QuoteRequest['sell']; buy: QuoteRequest['buy']; taker: Address }
}) {
  const { coll, debt, sides } = p
  const [target, setTarget] = useState(p.seedTarget ? Math.floor(p.seedTarget * 20) / 20 : 1)
  const currentLev = coll > 0n ? morphoLeverage(coll, debt, p.price) : 1
  const sliderMax = Number.isFinite(currentLev) ? Math.max(1, Math.floor(currentLev * 20) / 20 - 0.05) : 1
  const full = target <= 1 || sliderMax <= 1
  const sellAll = full && !!p.sellAllOnFull
  const debouncedTarget = useDebounced(target)
  const value = collateralInLoan(coll, p.price)

  // full: the whole debt (as owed at execution), collateral sold to cover it with a margin.
  // Partial: the repayment that brings the leverage down, and what covers it.
  const repay = full ? debt : roundSignificant(repayForMorphoLeverage(value, debt, BigInt(Math.round(debouncedTarget * 10_000))), 5)
  // sized at the oracle's price, then corrected by the quote (effect below) until its minimum just covers the repayment:
  // a swap's price impact (a PT sold on Pendle's market) can exceed the sizing margin
  const [scale, setScale] = useState(1)
  const sized = repay > 0n ? collateralToSellForRepay(repay, 0n, BigInt(p.slippage), sides.collateral, sides.loan) : 0n
  const needed = (sized * BigInt(Math.round(scale * 1e6))) / 1_000_000n
  const sell = sellAll ? coll : roundSignificant(needed > coll ? coll : needed, 6) + (needed > 0n ? 1n : 0n)
  const toSell = sell > coll ? coll : sell
  const withdraw = full ? coll : toSell

  const quoteReq: QuoteRequest | undefined =
    toSell > 0n
      ? {
          aggregator: p.swap.aggregator,
          chainId: p.swap.chainId,
          sell: p.swap.sell,
          buy: p.swap.buy,
          sellAmount: toSell,
          taker: p.swap.taker,
          slippageBps: BigInt(p.slippage),
          oracle: { sell: sides.collateral, buy: sides.loan },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = quote.data
  // full close: the debt accrues until execution, keep a small margin over it
  const required = full ? (repay * 10_005n) / 10_000n : repay
  useEffect(() => {
    if (sellAll || !q || q.simulated || q.sellAmount !== toSell || q.minOut === 0n || required === 0n) return
    const ratio = Number(required) / Number(q.minOut)
    // short of the repayment, or selling more than 1 % too much: resize (0,1 % of room), at most the whole balance
    if ((ratio > 1 && toSell < coll) || (ratio < 0.99 && !full)) setScale((x) => Math.min(x * ratio * 1.001, 10))
  }, [q, toSell, required, full, sellAll, coll])

  /** the quote is not that of the target on screen yet */
  const stale = quote.isFetching || target !== debouncedTarget
  return { target, setTarget, currentLev, sliderMax, full, repay, toSell, withdraw, quoteReq, quote, q, stale }
}
