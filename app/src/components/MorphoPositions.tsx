import { useEffect, useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { MORPHO_NETWORKS } from '../config'
import {
  fetchPositionMarkets,
  morphoMarketsQuery,
  readHeldMarkets,
  morphoHf,
  morphoLeverage,
  morphoNetApy,
  morphoSides,
  readMorphoState,
  type MorphoMarket,
  type MorphoState,
} from '../lib/morpho'
import { toBase } from '../lib/math'
import { daysToMaturity, isExpired, needsRenewal, ptInfosQuery, type PtInfo } from '../lib/pendle'
import { isCorrelated } from '../lib/scan'
import { apyTone, hfTone } from '../lib/tone'
import { fmtAmount, fmtDate, fmtDollars, fmtHf, fmtMaturity, fmtPct, fmtUsd, fmtX } from '../lib/format'
import { Card, Fold, Metric, Notice } from './ui'
import { morphoMarketName, type MorphoTab } from './MorphoView'

const CHAIN_IDS = MORPHO_NETWORKS.map((n) => n.chain.id)
/** Collateral under a cent's worth is leftover dust, not a position. */
const DUST_USD = 1_000_000n

type Row = { market: MorphoMarket; state: MorphoState; pt?: PtInfo }

/**
 * Morpho Blue positions of an address: the API says on which markets it has collateral, each one is then read
 * on-chain (amounts, oracle price, rate), so that what is shown is the chain's state, not the API's.
 */
export function MorphoPositions({
  user,
  onManage,
  onTotals,
}: {
  user: Address
  onManage: (m: MorphoMarket, tab?: MorphoTab, leverage?: number) => void
  onTotals: (t: MorphoTotals) => void
}) {
  // the API's positions (unlisted markets included) plus an on-chain read of every listed market (just-opened positions)
  const api = useQuery({
    queryKey: ['morpho-positions', user],
    queryFn: ({ signal }) => fetchPositionMarkets(user, CHAIN_IDS, signal),
    staleTime: 60_000,
    retry: 1,
  })
  const listed = useQueries({ queries: MORPHO_NETWORKS.map((n) => morphoMarketsQuery(n.chain.id, false)) })
  const held = useQueries({
    queries: MORPHO_NETWORKS.map((n, i) => ({
      queryKey: ['morpho-held', n.chain.id, user, listed[i].dataUpdatedAt],
      queryFn: () => readHeldMarkets(n.chain.id, n.morpho, listed[i].data!, user),
      enabled: !!listed[i].data,
      staleTime: 60_000,
      retry: 1,
    })),
  })
  const list = {
    isPending: api.isPending && held.every((q) => q.isPending),
    isError: api.isError && held.every((q) => q.isError || !q.data),
    refetch: () => {
      void api.refetch()
      listed.forEach((q) => q.isError && void q.refetch())
      held.forEach((q) => q.isError && void q.refetch())
    },
  }
  const markets = useMemo(() => {
    const byId = new Map<string, MorphoMarket>()
    for (const m of [...held.flatMap((q) => q.data ?? []), ...(api.data ?? [])]) byId.set(`${m.chainId}:${m.id}`, m)
    return [...byId.values()]
  }, [api.dataUpdatedAt, ...held.map((q) => q.dataUpdatedAt)])
  const states = useQueries({
    queries: markets.map((m) => ({
      queryKey: ['morpho-state', m.chainId, m.id, user, undefined],
      queryFn: () => readMorphoState(m.chainId, MORPHO_NETWORKS.find((n) => n.chain.id === m.chainId)!.morpho, m, user),
      refetchInterval: 60_000,
      retry: 1,
    })),
  })
  const ptChains = [...new Set(markets.map((m) => m.chainId))]
  const pts = useQueries({
    queries: ptChains.map((id) =>
      ptInfosQuery(
        id,
        markets.filter((m) => m.chainId === id).map((m) => m.collateral.address),
      ),
    ),
  })

  const rows: Row[] = markets.flatMap((market, i) => {
    const state = states[i].data
    if (!state?.user) return []
    const sides = morphoSides(market, state.price)
    if (toBase(state.user.collateral, sides.collateral) < DUST_USD && state.user.debt === 0n) return []
    const pt = pts[ptChains.indexOf(market.chainId)]?.data?.get(market.collateral.address.toLowerCase())
    return [{ market, state, pt }]
  })
  const pending = list.isPending || states.some((s) => s.isPending)
  const totalsKey = [pending, ...markets.map((m) => m.id), ...states.map((q) => q.dataUpdatedAt), ...pts.map((q) => q.dataUpdatedAt)].join()
  const totals = useMemo<MorphoTotals>(() => {
    let equity = 0n
    let weightedApy = 0
    let lowest: MorphoTotals['lowest']
    for (const r of rows) {
      const f = figures(r)
      equity += f.equity
      if (f.apy !== undefined) weightedApy += f.apy * Number(f.equity)
      if (r.state.user!.debt > 0n && (!lowest || f.hf < lowest.hf))
        lowest = { hf: f.hf, correlated: f.correlated, label: `Morpho · ${MORPHO_NETWORKS.find((n) => n.chain.id === r.market.chainId)!.label}` }
    }
    return { equity, weightedApy, lowest, count: rows.length, pending }
    // rows are rebuilt at every render: their content is keyed by the markets and the queries' update times
  }, [totalsKey])
  useEffect(() => onTotals(totals), [totals, onTotals])
  const failed = markets.filter((_, i) => states[i].isError)

  if (!list.isPending && !list.isError && markets.length === 0) return null
  return (
    <>
      {(list.isError || failed.length > 0 || (pending && rows.length === 0)) && (
        <Card title="Morpho Blue">
          {pending && rows.length === 0 && !list.isError && <p className="muted">Lecture des positions Morpho Blue…</p>}
          {list.isError && (
            <Notice>
              <span>API Morpho injoignable : les positions Morpho Blue ne sont pas listées.</span>
              <button className="btn" onClick={list.refetch}>
                Réessayer
              </button>
            </Notice>
          )}
          {failed.length > 0 && (
            <Notice>
              <span>Illisible on-chain : {failed.map(morphoMarketName).join(', ')} (RPC public qui ne répond pas).</span>
              <button className="btn" onClick={() => states.forEach((q) => q.isError && void q.refetch())}>
                Réessayer
              </button>
            </Notice>
          )}
        </Card>
      )}
      {rows.map((r) => (
        <MorphoPosition key={r.market.chainId + r.market.id} {...r} onManage={onManage} />
      ))}
    </>
  )
}

/** What a position card shows: USD sides from the market's oracle, health factor and leverage as Morpho computes them. */
function figures({ market: m, state, pt }: Row) {
  const u = state.user!
  const sides = morphoSides(m, state.price)
  const collUsd = toBase(u.collateral, sides.collateral)
  const debtUsd = toBase(u.debt, sides.loan)
  const leverage = morphoLeverage(u.collateral, u.debt, state.price)
  const collateralApy = pt ? (isExpired(pt) ? 0 : (pt.impliedApy ?? 0)) : (m.collateralYield ?? 0)
  const borrowApy = state.borrowApy ?? m.borrowApy
  return {
    collUsd,
    debtUsd,
    equity: collUsd - debtUsd,
    hf: morphoHf(u.collateral, u.debt, state.price, m.params.lltv),
    leverage,
    collateralApy,
    borrowApy,
    apy: Number.isFinite(leverage) ? morphoNetApy(leverage, collateralApy, borrowApy - m.borrowRewardsApr) : undefined,
    correlated: isCorrelated({ price: sides.collateral.price, token: m.collateral }, { price: sides.loan.price, token: m.loan }),
  }
}

/** Totals of the Morpho positions, added to the Positions screen's own: net value (USD, 1e8), APY x value, lowest health factor. */
export type MorphoTotals = { equity: bigint; weightedApy: number; lowest?: { hf: number; correlated: boolean; label: string }; count: number; pending: boolean }

function MorphoPosition({ onManage, ...row }: Row & { onManage: (m: MorphoMarket, tab?: MorphoTab, leverage?: number) => void }) {
  const { market: m, state, pt } = row
  const u = state.user!
  const net = MORPHO_NETWORKS.find((n) => n.chain.id === m.chainId)!
  const { collUsd, debtUsd, equity, hf, leverage, collateralApy, borrowApy, apy, correlated } = figures(row)
  const tone = u.debt > 0n ? hfTone(hf, correlated) : undefined
  const ptDays = pt ? daysToMaturity(pt) : undefined
  const ptTone = pt && (isExpired(pt) ? 'bad' : ptDays! < 14 ? 'warn' : undefined)
  return (
    <Card
      title={`Morpho · ${net.label}`}
      aside={
        <div className="actions">
          {pt && needsRenewal(pt) && u.debt > 0n && (
            <button className="btn" onClick={() => onManage(m, 'roll')}>
              Renouveler
            </button>
          )}
          <button className="btn" onClick={() => onManage(m, 'close', Number.isFinite(leverage) ? leverage : undefined)}>
            Gérer
          </button>
        </div>
      }
    >
      <p className="muted small">
        {morphoMarketName(m)}
        {!m.listed && ' · marché non listé'}
      </p>
      <div className="metrics">
        <Metric label="Valeur nette" value={fmtUsd(equity)} sub={`dette ${fmtUsd(debtUsd, true)}`} />
        {pt ? (
          <Metric label="Échéance du PT" value={fmtMaturity(pt.expiry)} tone={ptTone || undefined} sub={`${fmtDate(pt.expiry)} · levier ${fmtX(leverage)}`} />
        ) : (
          <Metric label="Levier" value={fmtX(leverage)} sub={`LLTV ${fmtPct(m.lltv, 1)}`} />
        )}
        <Metric label="Health factor" value={fmtHf(hf)} tone={tone} sub={correlated ? 'paire corrélée' : undefined} />
        <Metric
          label="APY net"
          value={apy !== undefined ? fmtPct(apy) : '—'}
          tone={apyTone(apy)}
          sub={
            apy !== undefined
              ? `${fmtDollars((Number(equity) / 1e8) * apy)} par an${collateralApy ? `, dont ${fmtPct(collateralApy)} ${pt ? 'fixe' : 'token'}` : ''}`
              : undefined
          }
        />
      </div>
      {tone === 'bad' && <Notice tone="bad">Health factor {fmtHf(hf)} : une petite baisse du collatéral ou la hausse des intérêts suffit à liquider.</Notice>}
      {pt && isExpired(pt) && (
        <Notice tone="bad">
          {m.collateral.symbol} est échu depuis le {fmtDate(pt.expiry)} : il ne rapporte plus rien et la dette continue de coûter. Renouveler ou fermer.
        </Notice>
      )}
      {pt && !isExpired(pt) && ptDays! < 14 && (
        <Notice>
          {m.collateral.symbol} arrive à échéance le {fmtDate(pt.expiry)} ({fmtMaturity(pt.expiry)}) : après, il ne rapporte plus rien. Renouveler dans un PT
          plus long ou fermer.
        </Notice>
      )}
      {u.authorized && <Notice tone="bad">L’exécuteur Auto-loop reste autorisé sur ce compte Morpho : retirer l’autorisation depuis l’écran Boucle.</Notice>}
      <Fold title="Actifs" value={`${m.collateral.symbol} déposé · ${m.loan.symbol} emprunté`}>
        <table className="reserves cards">
          <thead>
            <tr>
              <th>Actif</th>
              <th>Montant</th>
              <th>APY</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="lead">{m.collateral.symbol}</td>
              <td data-label="Montant">
                {fmtAmount(u.collateral, m.collateral.decimals)} ({fmtUsd(collUsd, true)})
              </td>
              <td data-label="APY">{collateralApy ? `${fmtPct(collateralApy)} ${pt ? 'fixe' : 'token'}` : '—'}</td>
            </tr>
            <tr>
              <td className="lead">{m.loan.symbol}</td>
              <td data-label="Montant">
                {fmtAmount(u.debt, m.loan.decimals)} ({fmtUsd(debtUsd, true)})
              </td>
              <td data-label="APY">
                emprunt {fmtPct(borrowApy)}
                {m.borrowRewardsApr > 0 && <span className="muted"> − {fmtPct(m.borrowRewardsApr)} rewards</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </Fold>
    </Card>
  )
}
