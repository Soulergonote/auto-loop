/**
 * Risk signals of the pair being looped (I4), shown at the top of « Risques »: market price against the oracle, past
 * depeg, exit at the position's size and, on Morpho, the largest borrower's share. Each signal is read on its own;
 * one that cannot be read is left out, never guessed.
 */
import { Metric } from '../../../ui/primitives'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { despike, maxDrawdown, ratioSeries, riskSignals, type RiskSignal } from '../../../domain/riskSignals'
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
}

export function useRiskSignals({ chainId, collateral, debt, correlated, oracleRatio, exit }: Input): RiskSignal[] {
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
  const a = charts.data?.get(tokenKey(c))
  const b = charts.data?.get(tokenKey(d))
  const series = a && b ? ratioSeries(a, b) : []
  return riskSignals({
    collateral: collateral.symbol,
    debt: debt.symbol,
    correlated,
    oracleRatio,
    marketRatio: spotC && spotD ? spotC / spotD : undefined,
    // 6 h prices: a spike up to 12 h long is an aggregator outlier, not a depeg
    drawdown: series.length >= 2 ? maxDrawdown(despike(series, 2)) : undefined,
    days: SIGNAL_DAYS,
    exitLoss: exit?.loss,
    exitNoRoute: exit?.noRoute,
  })
}

/** The signals as tiles (3 per row in « Risques »): a value to watch makes an amber tile, ink text on it. */
export function RiskSignalList({ signals }: { signals: RiskSignal[] }) {
  if (signals.length === 0) return null
  return (
    <div className="metrics risk-tiles">
      {signals.map((s) => (
        <Metric key={s.key} label={s.label} value={s.value} tone={s.tone} sub={s.detail} />
      ))}
    </div>
  )
}
