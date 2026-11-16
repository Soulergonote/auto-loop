import { useEffect, useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { AAVE_V4_CHAINS, V4_NETWORKS, networkName } from '../../config'
import { v4ReservesQuery } from '../../protocols/aavev4/reserves'
import { readV4Positions, summarizeV4, type V4SpokePosition } from '../../protocols/aavev4/positions'
import { v4BorrowApy } from '../../protocols/aavev4/state'
import { withData } from '../../services/queryData'
import { isCorrelated } from '../../domain/pairs'
import { apyTone, hfTone } from '../../ui/tone'
import { fmtAmount, fmtDollars, fmtHf, fmtLltv, fmtPct, fmtUsd, fmtX } from '../../ui/format'
import { Card, Fold, Metric, Notice } from '../../ui/primitives'
import type { V4Seed, V4Tab } from '../loop/aavev4/V4View'
import { HfProjection } from './HfProjection'
import { HfTargetBlock } from './HfTarget'
import { Place } from '../../ui/Logo'
import type { PortfolioPart } from '../../domain/portfolio'
import type { MorphoTotals } from './MorphoPositions'

/** A position under a cent's worth is leftover dust. */
const DUST_USD = 1_000_000n
const chainLabel = (chainId: number) => networkName(V4_NETWORKS.find((n) => n.chain.id === chainId)?.label ?? String(chainId))

type Manage = (p: Omit<V4Seed, 'nonce'>) => void

/**
 * Aave v4 positions of an address: one card per spoke (a v4 account is per spoke). The API lists the reserves, the
 * amounts, health factor and risk premium are read on chain.
 */
export function V4Positions({ user, onManage, onTotals }: { user: Address; onManage: Manage; onTotals: (t: MorphoTotals) => void }) {
  const list = useQuery(v4ReservesQuery(AAVE_V4_CHAINS))
  const { queries, data } = useQueries({
    queries: AAVE_V4_CHAINS.map((chainId) => ({
      queryKey: ['v4-positions', chainId, user, list.dataUpdatedAt],
      queryFn: () => readV4Positions(chainId, list.data!, user),
      enabled: !!list.data,
      refetchInterval: 60_000,
      retry: 1,
    })),
    combine: withData,
  })
  const rows = useMemo(
    () =>
      data
        .flatMap((d) => d ?? [])
        .map((position) => ({ position, summary: summarizeV4(position) }))
        .filter((r) => r.summary.collateralBase >= DUST_USD || r.summary.debtBase >= DUST_USD),
    [data],
  )
  const pending = !list.isError && (list.isPending || queries.some((q) => q.isPending))
  const totals = useMemo<MorphoTotals>(() => {
    let equity = 0n
    let weightedApy = 0
    let lowest: MorphoTotals['lowest']
    const parts: PortfolioPart[] = []
    for (const { position: p, summary: s } of rows) {
      equity += s.equityBase
      parts.push({ network: chainLabel(p.chainId), protocol: 'Aave v4', usd: Number(s.equityBase) / 1e8 })
      if (s.apy !== undefined) weightedApy += s.apy * Number(s.equityBase)
      if (s.debtBase > 0n && (!lowest || p.healthFactor < lowest.hf))
        lowest = { hf: p.healthFactor, correlated: pairCorrelated(s), label: `Aave v4 · ${chainLabel(p.chainId)}` }
    }
    return { equity, weightedApy, lowest, count: rows.length, pending, parts }
  }, [rows, pending])
  useEffect(() => onTotals(totals), [totals, onTotals])

  const failed = AAVE_V4_CHAINS.filter((_, i) => queries[i].isError)
  return (
    <>
      {(list.isError || failed.length > 0) && (
        <Card title="Aave v4">
          {list.isError && (
            <Notice>
              <span>API Aave v4 injoignable : les positions Aave v4 ne sont pas listées.</span>
              <button className="btn" onClick={() => void list.refetch()}>
                Réessayer
              </button>
            </Notice>
          )}
          {failed.length > 0 && (
            <Notice>
              <span>Illisible on-chain : Aave v4 sur {failed.map(chainLabel).join(', ')} (RPC public qui ne répond pas).</span>
              <button className="btn" onClick={() => queries.forEach((q) => q.isError && void q.refetch())}>
                Réessayer
              </button>
            </Notice>
          )}
        </Card>
      )}
      {rows.map((r) => (
        <V4Position key={`${r.position.chainId}:${r.position.spoke.address}`} {...r} onManage={onManage} />
      ))}
    </>
  )
}

type Summary = ReturnType<typeof summarizeV4>
const pairCorrelated = (s: Summary) => !!s.collateral && !!s.debt && isCorrelated(s.collateral.reserve, s.debt.reserve)

function V4Position({ position: p, summary: s, onManage }: { position: V4SpokePosition; summary: Summary; onManage: Manage }) {
  const correlated = pairCorrelated(s)
  const levered = s.debtBase > 0n
  const supplies = p.holdings.filter((h) => h.supplied > 0n)
  const debts = p.holdings.filter((h) => h.debt > 0n)
  const C = s.collateral
  const D = s.debt
  // the Boucle screen works on one pair: the biggest collateral against the biggest debt
  const manage = (tab: V4Tab, leverage?: number, opts?: { amount?: string; target?: number }) =>
    C && D && onManage({ chainId: p.chainId, spoke: p.spoke.address, collateralId: C.reserve.reserveId, debtId: D.reserve.reserveId, tab, leverage, ...opts })
  const single = supplies.length === 1 && debts.length === 1
  const title = single ? `${supplies[0].reserve.token.symbol} / ${debts[0].reserve.token.symbol}` : p.spoke.name
  return (
    <Card
      title={
        <>
          {title}
          <span className="card-sub">
            <Place text={`Aave v4 · ${chainLabel(p.chainId)}`} /> · spoke {p.spoke.name}
            {s.threshold > 0 && ` · seuil ${fmtLltv(s.threshold)}`}
          </span>
        </>
      }
      aside={
        C &&
        D && (
          <div className="actions">
            <button className="btn" onClick={() => manage('close', Number.isFinite(s.leverage) ? s.leverage : undefined)}>
              Gérer
            </button>
            {levered && (
              <button className="btn" onClick={() => manage('refinance')} title="Déplacer la position vers un autre spoke, Aave v3 ou Morpho">
                Refinancer
              </button>
            )}
          </div>
        )
      }
    >
      <div className="metrics">
        <Metric label="Valeur nette" value={fmtUsd(s.equityBase)} sub={`dette ${fmtUsd(s.debtBase, true)}`} />
        <Metric label="Levier" value={fmtX(s.leverage)} />
        <Metric
          label="Health factor"
          value={fmtHf(p.healthFactor)}
          tone={levered ? hfTone(p.healthFactor, correlated) : undefined}
          sub={correlated ? 'paire corrélée' : undefined}
        />
        <Metric
          label="APY net"
          value={s.apy !== undefined ? fmtPct(s.apy) : '—'}
          tone={apyTone(s.apy)}
          sub={
            s.apy !== undefined
              ? `${fmtDollars((Number(s.equityBase) / 1e8) * s.apy)} par an${levered && p.riskPremium > 0 ? `, prime de risque ${fmtPct(p.riskPremium, 1)} du taux de base` : ''}`
              : undefined
          }
        />
      </div>
      {levered && (
        <HfProjection
          healthFactor={p.healthFactor}
          collateral={supplies.filter((h) => h.collateral).map((h) => ({ value: Number(h.suppliedBase), apy: h.reserve.supplyApy + h.reserve.underlyingApy }))}
          debt={debts.map((h) => ({ value: Number(h.debtBase), apy: v4BorrowApy(h.reserve.borrowApy, p.riskPremium) }))}
          bar={s.threshold > 0 ? { liquidationThreshold: s.threshold, correlated } : undefined}
        />
      )}
      {levered && single && (
        <HfTargetBlock
          id={`v4:${p.chainId}:${p.spoke.address}:${C!.reserve.reserveId}:${D!.reserve.reserveId}`.toLowerCase()}
          position={{ collateralBase: s.collateralBase, debtBase: s.debtBase, healthFactor: p.healthFactor, correlated }}
          onRebalance={(r) => (r.direction === 'down' ? manage('close', r.leverage, { target: r.leverage }) : manage('open', r.leverage, { amount: '0' }))}
        />
      )}
      {supplies.some((h) => !h.collateral && h.reserve.collateralFactor > 0) && levered && (
        <Notice>Un dépôt de ce spoke n’est pas marqué comme collatéral : il ne garantit pas la dette et ne compte pas dans le health factor.</Notice>
      )}
      <Fold
        title="Actifs"
        value={`${supplies.map((h) => h.reserve.token.symbol).join(', ') || '—'} déposé · ${debts.map((h) => h.reserve.token.symbol).join(', ') || 'rien'} emprunté`}
      >
        <table className="reserves cards">
          <thead>
            <tr>
              <th>Actif</th>
              <th className="num">Montant</th>
              <th className="num">APY</th>
            </tr>
          </thead>
          <tbody>
            {supplies.map((h) => (
              <tr key={`s${h.reserve.reserveId}`}>
                <td className="lead">
                  {h.reserve.token.symbol}
                  {!h.collateral && <span className="muted"> · hors collatéral</span>}
                </td>
                <td className="num" data-label="Montant">
                  {fmtAmount(h.supplied, h.reserve.token.decimals)} ({fmtUsd(h.suppliedBase, true)})
                </td>
                <td className="num" data-label="APY">
                  {fmtPct(h.reserve.supplyApy + h.reserve.underlyingApy)}
                  {h.reserve.supplyRewardApy > 0 && <span className="muted"> + {fmtPct(h.reserve.supplyRewardApy)} rewards</span>}
                </td>
              </tr>
            ))}
            {debts.map((h) => (
              <tr key={`d${h.reserve.reserveId}`}>
                <td className="lead">{h.reserve.token.symbol}</td>
                <td className="num" data-label="Montant">
                  {fmtAmount(h.debt, h.reserve.token.decimals)} ({fmtUsd(h.debtBase, true)})
                </td>
                <td className="num" data-label="APY">
                  emprunt {fmtPct(v4BorrowApy(h.reserve.borrowApy, p.riskPremium))}
                  {h.reserve.borrowRewardApy > 0 && <span className="muted"> − {fmtPct(h.reserve.borrowRewardApy)} rewards</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Fold>
    </Card>
  )
}
