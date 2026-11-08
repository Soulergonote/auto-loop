import { useQuery } from '@tanstack/react-query'
import type { Market } from '../config'
import type { Reserve } from '../lib/useMarket'
import type { Quote } from '../lib/quotes'
import { daysToMaturity, isExpired, ptPriceFromApy, readPtTwap } from '../lib/pendle'
import { fmtNum, fmtPct, fmtPrice } from '../lib/format'
import { Fold } from './ui'

/** The three prices of a PT: Aave's (linear discount, the one the health factor uses), the one paid, and Pendle's TWAP. */
export function PtPrices({ market, reserve: C, quote }: { market: Market; reserve: Reserve; quote?: Quote }) {
  const pt = C.pt!
  const days = daysToMaturity(pt)
  const twap = useQuery({
    queryKey: ['pt-twap', market.chain.id, pt.market],
    queryFn: () => readPtTwap(market.chain.id, pt.market!),
    enabled: !!pt.market && !isExpired(pt),
    staleTime: 60_000,
  })
  const paidApy = quote?.pendle?.kind === 'buy' ? quote.pendle.fixedApy : undefined
  const paid = paidApy !== undefined ? ptPriceFromApy(paidApy, days) : undefined
  const implied = pt.impliedApy !== undefined ? ptPriceFromApy(pt.impliedApy, days) : undefined
  const asset = (x?: number) => (x !== undefined ? fmtNum(x) : '—')
  return (
    <Fold title="Prix du PT" value={`Aave ${fmtPrice(C.price)}${paid !== undefined ? ` · payé ${asset(paid)}` : ''}`}>
      <table className="reserves cards">
        <thead>
          <tr>
            <th>Source</th>
            <th className="num">Prix</th>
            <th>Rendement</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="lead">Oracle Aave</td>
            <td data-label="Prix" className="num">
              {fmtPrice(C.price)}
            </td>
            <td data-label="Rendement">{pt.discount !== undefined ? `décote ${fmtPct(pt.discount)} par an` : '—'}</td>
          </tr>
          {paid !== undefined && (
            <tr>
              <td className="lead">Prix payé (devis)</td>
              <td data-label="Prix" className="num">
                {asset(paid)}
              </td>
              <td data-label="Rendement">APY fixe {fmtPct(paidApy!)}</td>
            </tr>
          )}
          <tr>
            <td className="lead">Marché Pendle</td>
            <td data-label="Prix" className="num">
              {asset(implied)}
            </td>
            <td data-label="Rendement">{pt.impliedApy !== undefined ? `APY implicite ${fmtPct(pt.impliedApy)}` : 'marché inconnu'}</td>
          </tr>
          {twap.data !== undefined && (
            <tr>
              <td className="lead">TWAP Pendle 15 min</td>
              <td data-label="Prix" className="num">
                {asset(twap.data)}
              </td>
              <td data-label="Rendement">APY {fmtPct(Math.pow(1 / twap.data, 365 / Math.max(days, 1)) - 1)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted small">
        Prix Pendle en {pt.tokensOut[0]?.symbol ? `actif sous-jacent de ${pt.tokensOut[0].symbol}` : 'actif sous-jacent'} (1 = au pair, à l’échéance). Aave ne
        lit pas le marché Pendle : son prix monte chaque jour vers le pair selon la décote, et c’est lui qui fixe le health factor.
      </p>
    </Fold>
  )
}
