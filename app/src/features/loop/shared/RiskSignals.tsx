/**
 * Risk signals of the pair being looped (I4), shown at the top of « Risques »: market price against the oracle, past
 * depeg, exit at the position's size and, on Morpho, the largest borrower's share. Each signal is read on its own;
 * one that cannot be read is left out, never guessed.
 */
import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import { maxDrawdown, ratioSeries, riskSignals, type RiskSignal } from '../../../domain/riskSignals'
import { fetchTopBorrower } from '../../../protocols/morpho/markets'
import { priceChartsQuery } from '../../../services/priceHistory'
import { llamaQuotes, tokenKey } from '../../../services/yield/copies'

export const SIGNAL_DAYS = 90

type Input = {
  chainId: number
  collateral: { address: Address; symbol: string }
  debt: { address: Address; symbol: string }
  correlated: boolean
  /** collateral price in debt units at the oracle */
  oracleRatio?: number
  exit?: { loss?: number; noRoute: boolean }
  /** Morpho: the market and its total borrow shares (read on-chain), to weigh the largest borrower */
  morpho?: { id: Hex; totalBorrowShares: bigint; user?: Address; api: boolean }
}

export function useRiskSignals({ chainId, collateral, debt, correlated, oracleRatio, exit, morpho }: Input): RiskSignal[] {
  const c = { chainId, address: collateral.address }
  const d = { chainId, address: debt.address }
  const charts = useQuery(priceChartsQuery([c, d], { days: SIGNAL_DAYS, period: '6h' }))
  // the gap compares the oracle with the market now (the charts' last point can be hours old)
  const spot = useQuery({
    queryKey: ['llama-spot', tokenKey(c), tokenKey(d)],
    queryFn: () => llamaQuotes([c, d]),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: 1,
  })
  const spotC = spot.data?.get(tokenKey(c))?.price
  const spotD = spot.data?.get(tokenKey(d))?.price
  const top = useQuery({
    queryKey: ['morpho-top-borrower', chainId, morpho?.id],
    queryFn: ({ signal }) => fetchTopBorrower(chainId, morpho!.id, signal),
    enabled: !!morpho?.api,
    staleTime: 10 * 60_000,
    retry: 1,
  })
  const a = charts.data?.get(tokenKey(c))
  const b = charts.data?.get(tokenKey(d))
  const series = a && b ? ratioSeries(a, b) : []
  const topShares = top.data?.borrowShares
  return riskSignals({
    collateral: collateral.symbol,
    debt: debt.symbol,
    correlated,
    oracleRatio,
    marketRatio: spotC && spotD ? spotC / spotD : undefined,
    drawdown: series.length >= 2 ? maxDrawdown(series) : undefined,
    days: SIGNAL_DAYS,
    exitLoss: exit?.loss,
    exitNoRoute: exit?.noRoute,
    topBorrower:
      morpho && topShares !== undefined && morpho.totalBorrowShares > 0n
        ? {
            share: Math.min(1, Number(topShares) / Number(morpho.totalBorrowShares)),
            mine: !!morpho.user && top.data!.user.toLowerCase() === morpho.user.toLowerCase(),
          }
        : undefined,
  })
}

/** The signals as a grid of facts, coloured by the charter's tones. */
export function RiskSignalList({ signals }: { signals: RiskSignal[] }) {
  if (signals.length === 0) return null
  return (
    <dl className="breakdown signals">
      {signals.map((s) => (
        <div key={s.key}>
          <dt>{s.label}</dt>
          <dd className={s.tone ? `${s.tone}-text` : undefined}>{s.value}</dd>
          <dd className="muted small">{s.detail}</dd>
        </div>
      ))}
    </dl>
  )
}
