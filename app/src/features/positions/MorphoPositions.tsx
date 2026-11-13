import { useEffect, useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { BaseError, ContractFunctionRevertedError, type Address } from 'viem'
import { MORPHO_NETWORKS } from '../../config'
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
} from '../../protocols/morpho/markets'
import { toBase } from '../../domain/math'
import { withData } from '../../services/queryData'
import { daysToMaturity, isExpired, needsRenewal, ptInfosQuery, type PtInfo } from '../../protocols/pendle/pt'
import { isCorrelated } from '../../domain/pairs'
import { apyTone, hfTone } from '../../ui/tone'
import { fmtLltv, fmtAmount, fmtDate, fmtDollars, fmtHf, fmtMaturity, fmtPct, fmtUsd, fmtX, ptShortSymbol } from '../../ui/format'
import { Card, Fold, Metric, Notice } from '../../ui/primitives'
import { morphoMarketName, type MorphoTab } from '../loop/morpho/MorphoView'
import { PositionHistory } from './PositionHistory'
import { HfProjection } from './HfProjection'
import { HfTargetBlock } from './HfTarget'
import { morphoHistory } from './history'

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
  onManage: (m: MorphoMarket, tab?: MorphoTab, leverage?: number, opts?: { amount?: string; target?: number }) => void
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
  // `.data` of each keeps its identity until some data really changes: what is derived below is recomputed only then
  const { queries: held, data: heldData } = useQueries({
    queries: MORPHO_NETWORKS.map((n, i) => ({
      queryKey: ['morpho-held', n.chain.id, user, listed[i].dataUpdatedAt],
      queryFn: () => readHeldMarkets(n.chain.id, n.morpho, listed[i].data!, user),
      enabled: !!listed[i].data,
      staleTime: 60_000,
      retry: 1,
    })),
    combine: withData,
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
    for (const m of [...heldData.flatMap((d) => d ?? []), ...(api.data ?? [])]) byId.set(`${m.chainId}:${m.id}`, m)
    return [...byId.values()]
  }, [api.data, heldData])
  const { queries: states, data: stateData } = useQueries({
    queries: markets.map((m) => ({
      queryKey: ['morpho-state', m.chainId, m.id, user, undefined],
      queryFn: () => readMorphoState(m.chainId, MORPHO_NETWORKS.find((n) => n.chain.id === m.chainId)!.morpho, m, user),
      refetchInterval: 60_000,
      retry: 1,
    })),
    combine: withData,
  })
  const ptChains = useMemo(() => [...new Set(markets.map((m) => m.chainId))], [markets])
  const { data: ptData } = useQueries({
    queries: ptChains.map((id) =>
      ptInfosQuery(
        id,
        markets.filter((m) => m.chainId === id).map((m) => m.collateral.address),
      ),
    ),
    combine: withData,
  })

  const rows = useMemo(
    () =>
      markets.flatMap((market, i): Row[] => {
        const state = stateData[i]
        if (!state?.user) return []
        const sides = morphoSides(market, state.price)
        if (toBase(state.user.collateral, sides.collateral) < DUST_USD && state.user.debt === 0n) return []
        const pt = ptData[ptChains.indexOf(market.chainId)]?.get(market.collateral.address.toLowerCase())
        return [{ market, state, pt }]
      }),
    [markets, stateData, ptData, ptChains],
  )
  const pending = list.isPending || states.some((s) => s.isPending)
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
  }, [rows, pending])
  useEffect(() => onTotals(totals), [totals, onTotals])
  // a revert (the market's oracle, typically a PT feed after maturity) is not an RPC outage: retrying does not help
  const reverted = (e: unknown) => e instanceof BaseError && !!e.walk((c) => c instanceof ContractFunctionRevertedError)
  const broken = markets.filter((_, i) => states[i].isError && reverted(states[i].error))
  const failed = markets.filter((_, i) => states[i].isError && !reverted(states[i].error))

  if (!list.isPending && !list.isError && markets.length === 0) return null
  return (
    <>
      {(list.isError || failed.length > 0 || broken.length > 0 || (pending && rows.length === 0)) && (
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
          {broken.length > 0 && (
            <Notice>
              <span>Oracle du marché en échec (lecture du prix refusée) : {broken.map(morphoMarketName).join(', ')}. Position non affichée.</span>
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
        <MorphoPosition key={r.market.chainId + r.market.id} {...r} user={user} onManage={onManage} />
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
  const collateralApy = pt ? (isExpired(pt) ? 0 : (pt.impliedApy ?? 0)) : (m.collateralYield?.apy ?? 0)
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

function MorphoPosition({
  onManage,
  user,
  ...row
}: Row & { user: Address; onManage: (m: MorphoMarket, tab?: MorphoTab, leverage?: number, opts?: { amount?: string; target?: number }) => void }) {
  const { market: m, state, pt } = row
  const u = state.user!
  const net = MORPHO_NETWORKS.find((n) => n.chain.id === m.chainId)!
  const { collUsd, debtUsd, equity, hf, leverage, collateralApy, borrowApy, apy, correlated } = figures(row)
  const tone = u.debt > 0n ? hfTone(hf, correlated) : undefined
  const ptDays = pt ? daysToMaturity(pt) : undefined
  const ptTone = pt && (isExpired(pt) ? 'bad' : ptDays! < 14 ? 'warn' : undefined)
  // today's USD price of each side, from the market's oracle (the flows without a price of their day fall back on it)
  const sides = morphoSides(m, state.price)
  const unitUsd = (side: typeof sides.collateral, decimals: number) => Number(toBase(10n ** BigInt(decimals), side)) / 1e8
  const nowPrices = new Map([
    [m.collateral.address.toLowerCase(), unitUsd(sides.collateral, m.collateral.decimals)],
    [m.loan.address.toLowerCase(), unitUsd(sides.loan, m.loan.decimals)],
  ])
  return (
    <Card
      title={
        <>
          {ptShortSymbol(m.collateral.symbol)} / {m.loan.symbol}
          <span className="card-sub">
            Morpho · {net.label} · LLTV {fmtLltv(m.lltv)}
            {!m.listed && (m.source === 'chain' ? ' · marché lu sur la chaîne' : ' · marché non listé')}
          </span>
        </>
      }
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
      <div className="metrics">
        <Metric label="Valeur nette" value={fmtUsd(equity)} sub={`dette ${fmtUsd(debtUsd, true)}`} />
        {pt ? (
          <Metric label="Échéance du PT" value={fmtMaturity(pt.expiry)} tone={ptTone || undefined} sub={`${fmtDate(pt.expiry)} · levier ${fmtX(leverage)}`} />
        ) : (
          <Metric label="Levier" value={fmtX(leverage)} />
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
      {u.debt > 0n && (
        <HfProjection
          healthFactor={hf}
          // a PT: its fixed yield until maturity (the market's oracle follows the PT towards par)
          collateral={[{ value: Number(collUsd), apy: collateralApy, pt: pt && { daysLeft: daysToMaturity(pt) } }]}
          debt={[{ value: Number(debtUsd), apy: borrowApy }]}
          ptDaysLeft={pt && !isExpired(pt) ? ptDays : undefined}
          bar={{ liquidationThreshold: m.lltv, correlated }}
        />
      )}
      {u.debt > 0n && (
        <HfTargetBlock
          id={`morpho:${m.chainId}:${m.id}`.toLowerCase()}
          position={{ collateralBase: collUsd, debtBase: debtUsd, healthFactor: hf, correlated }}
          onRebalance={(r) =>
            r.direction === 'down' ? onManage(m, 'close', r.leverage, { target: r.leverage }) : onManage(m, 'open', r.leverage, { amount: '0' })
          }
        />
      )}
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
      {u.authorized && <Notice tone="bad">Le contrat Auto-loop reste autorisé sur ce compte Morpho : retirer l’autorisation depuis l’écran Boucle.</Notice>}
      <Fold title="Actifs" value={`${m.collateral.symbol} déposé · ${m.loan.symbol} emprunté`}>
        <table className="reserves cards">
          <thead>
            <tr>
              <th>Actif</th>
              <th className="num">Montant</th>
              <th className="num">APY</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="lead">{m.collateral.symbol}</td>
              <td className="num" data-label="Montant">
                {fmtAmount(u.collateral, m.collateral.decimals)} ({fmtUsd(collUsd, true)})
              </td>
              <td className="num" data-label="APY">
                {collateralApy ? `${fmtPct(collateralApy)} ${pt ? 'fixe' : 'token'}` : '—'}
              </td>
            </tr>
            <tr>
              <td className="lead">{m.loan.symbol}</td>
              <td className="num" data-label="Montant">
                {fmtAmount(u.debt, m.loan.decimals)} ({fmtUsd(debtUsd, true)})
              </td>
              <td className="num" data-label="APY">
                emprunt {fmtPct(borrowApy)}
                {m.borrowRewardsApr > 0 && <span className="muted"> − {fmtPct(m.borrowRewardsApr)} rewards</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </Fold>
      {/* the history comes from Morpho's API, which does not cover the chains read on-chain */}
      {!net.onchain && (
        <PositionHistory
          chain={net.chain}
          queryKey={['morpho', m.chainId, m.id, user]}
          load={(signal) => morphoHistory(m.chainId, m.id, user, m.collateral, m.loan, signal)}
          equityUsd={Number(equity) / 1e8}
          now={nowPrices}
          reference={u.debt > 0n ? { address: m.loan.address, symbol: m.loan.symbol } : undefined}
        />
      )}
    </Card>
  )
}
