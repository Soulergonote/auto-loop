import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { getAddress, isAddress, type Address } from 'viem'
import { MARKETS, getMarket, marketPlace, networkName, type Market } from '../../config'
import { daysLeft, merklQuery, type Campaign } from '../../services/merkl'
import { snapshotQuery, userPositionQuery, type Snapshot, type UserPosition } from '../../protocols/aave/snapshot'
import { merklBalances, summarizePosition, userRewardsQuery, type PositionSummary } from './positions'
import { isCorrelated } from '../../domain/pairs'
import { apyTone, hfTone } from '../../ui/tone'
import { fmtAddress, fmtAmount, fmtDate, fmtDollars, fmtHf, fmtMaturity, fmtNum, fmtPct, fmtUsd, fmtX } from '../../ui/format'
import { daysToMaturity, isExpired, needsRenewal } from '../../protocols/pendle/pt'
import { Card, Fold, Metric, Notice, Tag, useSlow } from '../../ui/primitives'
import type { Pick } from '../scanner/Scanner'
import { MorphoPositions, type MorphoTotals } from './MorphoPositions'
import { V4Positions } from './V4Positions'
import type { V4Seed } from '../loop/aavev4/V4View'
import { PositionHistory } from './PositionHistory'
import { PositionCard } from './PositionCard'
import { HfProjection } from './HfProjection'
import { thresholdOf } from '../../domain/positionBar'
import { HfTargetBlock } from './HfTarget'
import { aaveHistory } from './history'
import type { MorphoTab } from '../loop/morpho/MorphoView'
import type { MorphoMarket } from '../../protocols/morpho/markets'
import { shares, totalGain, type GainState, type PortfolioPart } from '../../domain/portfolio'
import { GainReport } from './gainReport'
import { Shares } from '../../ui/Shares'
import { Place } from '../../ui/Logo'

const READABLE = MARKETS.filter((m) => !m.soon)
/** Totals of the protocols listed under the Aave v3 cards, as one; undefined until each has reported. */
function mergeTotals(a?: MorphoTotals, b?: MorphoTotals): MorphoTotals | undefined {
  if (!a || !b) return undefined
  const lowest = a.lowest && b.lowest ? (a.lowest.hf <= b.lowest.hf ? a.lowest : b.lowest) : (a.lowest ?? b.lowest)
  return {
    equity: a.equity + b.equity,
    weightedApy: a.weightedApy + b.weightedApy,
    lowest,
    count: a.count + b.count,
    pending: a.pending || b.pending,
    parts: [...a.parts, ...b.parts],
  }
}

/** Balances under a cent (leftover interest after a close) are not a position. */
const DUST = 1_000_000n

type Open = { market: Market; snapshot: Snapshot; position: UserPosition; campaigns?: Campaign[]; summary: PositionSummary; correlated: boolean }

/** Every Aave v3 position of an address across the app's networks (total first, then one card per network), then its Morpho Blue positions. */
export function Positions({
  account,
  onManage,
  onManageMorpho,
  onManageV4,
  onScan,
  onEmpty,
}: {
  account?: Address
  onManage: (p: Pick) => void
  onManageMorpho: (m: MorphoMarket, tab?: MorphoTab, leverage?: number, opts?: { amount?: string; target?: number }) => void
  onManageV4: (p: Omit<V4Seed, 'nonce'>) => void
  onScan: () => void
  /** called once the connected wallet is read on every network and holds nothing (arrival on the app) */
  onEmpty?: () => void
}) {
  const [typed, setTyped] = useState('')
  const [morphoOnly, setMorpho] = useState<MorphoTotals>()
  const [v4, setV4] = useState<MorphoTotals>()
  // Morpho Blue and Aave v4 report their totals the same way: counted as one once both are read
  const morpho = useMemo(() => mergeTotals(morphoOnly, v4), [morphoOnly, v4])
  // each position's « Gain réel », reported by its fold (J5)
  const [gains, setGains] = useState<Record<string, GainState>>({})
  const reportGain = useCallback(
    (key: string, state: GainState | undefined) =>
      setGains((g) => {
        if (state === undefined) {
          if (!(key in g)) return g
          const { [key]: _, ...rest } = g
          return rest
        }
        const was = g[key]
        if (was === state || (typeof was === 'object' && typeof state === 'object' && was.usd === state.usd && was.since === state.since)) return g
        return { ...g, [key]: state }
      }),
    [],
  )
  const user: Address | undefined = isAddress(typed.trim()) ? getAddress(typed.trim()) : account
  const markets: Market[] = useMemo(() => READABLE.map((m) => getMarket(m.id)), [])
  const snapshots = useQueries({ queries: markets.map((m) => ({ ...snapshotQuery(m), enabled: !!user })) })
  const positions = useQueries({ queries: snapshots.map((s) => userPositionQuery(s.data, user)) })
  const chainIds = [...new Set(markets.map((m) => m.chain.id))]
  const campaigns = useQueries({ queries: chainIds.map((id) => merklQuery(id)) })
  const rewards = useQueries({ queries: chainIds.map((id) => userRewardsQuery(id, user)) })

  const pending = markets.filter((_, i) => snapshots[i].isPending || positions[i].isPending).length
  const failed = markets.filter((_, i) => snapshots[i].isError || positions[i].isError)
  const slow = useSlow(!!user && pending > 0)
  const retry = () => {
    snapshots.forEach((q) => q.isError && void q.refetch())
    positions.forEach((q) => q.isError && void q.refetch())
  }

  const open: Open[] = markets.flatMap((market, i) => {
    const snapshot = snapshots[i].data
    const raw = positions[i].data
    if (!snapshot || !raw) return []
    const holdings = raw.holdings.filter((h) => h.suppliedBase + h.borrowedBase >= DUST)
    if (holdings.length === 0) return []
    const position = { ...raw, holdings }
    const marketCampaigns = campaigns[chainIds.indexOf(market.chain.id)]?.data
    const summary = summarizePosition(holdings, marketCampaigns, raw.healthFactor)
    const collateral = biggest(holdings, 'suppliedBase')
    const debt = biggest(holdings, 'borrowedBase')
    const correlated = summary.debtBase > 0n && isCorrelated(collateral.reserve, debt.reserve)
    return [{ market, snapshot, position, campaigns: marketCampaigns, summary, correlated }]
  })
  const claim = chainIds
    .map((id, i) => ({ chain: markets.find((m) => m.chain.id === id)!.chain, balances: merklBalances(rewards[i].data) }))
    .filter((c) => c.balances.length > 0)

  // total over every network: net value, APY weighted by net value, lowest health factor
  // Morpho Blue positions count in the total once read (they are listed under the Aave cards)
  const m = user && morpho && !morpho.pending ? morpho : undefined
  const equity = open.reduce((s, x) => s + x.summary.equityBase, 0n) + (m?.equity ?? 0n)
  const weighted = open.reduce((s, x) => s + (Number.isFinite(x.summary.apy) ? x.summary.apy * Number(x.summary.equityBase) : 0), 0) + (m?.weightedApy ?? 0)
  const levered = open.filter((x) => x.summary.debtBase > 0n)
  const lowestAave = levered.reduce<Open | undefined>((m, x) => (!m || x.position.healthFactor < m.position.healthFactor ? x : m), undefined)
  const lowest =
    m?.lowest && (!lowestAave || m.lowest.hf < lowestAave.position.healthFactor)
      ? m.lowest
      : lowestAave && { hf: lowestAave.position.healthFactor, correlated: lowestAave.correlated, label: lowestAave.market.label }
  const count = open.length + (m?.count ?? 0)
  const parts: PortfolioPart[] = [
    ...open.map((x) => ({ network: networkName(x.market.label), protocol: x.market.fork ?? 'Aave v3', usd: Number(x.summary.equityBase) / 1e8 })),
    ...(m?.parts ?? []),
  ]
  const byNetwork = shares(parts, 'network')
  const byProtocol = shares(parts, 'protocol')
  const gain = totalGain(Object.values(gains))
  const claimUsd = claim.reduce((s, c) => s + c.balances.reduce((t, b) => t + b.usd, 0), 0)
  // the total shows as soon as one network is read; unreachable networks are named in a banner
  const read = markets.length - pending
  const done = !!user && (pending === 0 || count > 0)
  const avgApy = done && equity > 0n ? weighted / Number(equity) : undefined
  const empty = !!user && !typed.trim() && pending === 0 && count === 0 && !!morpho && !morpho.pending && failed.length === 0 && claim.length === 0
  useEffect(() => {
    if (empty) onEmpty?.()
  }, [empty, onEmpty])

  return (
    <GainReport.Provider value={reportGain}>
      <Card title="Vue d’ensemble">
        <label className="field">
          <span>Adresse {account && !typed ? '(portefeuille connecté)' : '(lecture seule)'}</span>
          <input placeholder={account ?? '0x…'} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
        </label>
        {typed.trim() && !isAddress(typed.trim()) && <Notice>Adresse invalide.</Notice>}
        {!user && (
          <p className="muted">Connecter le portefeuille ou coller une adresse : ses positions Aave v3 et Morpho Blue s’affichent pour tous les réseaux.</p>
        )}
        {user && (count > 0 || pending > 0) && (
          <div className="metrics">
            <Metric
              label="Valeur nette"
              value={done ? fmtUsd(equity) : undefined}
              sub={
                done
                  ? pending > 0
                    ? `${read} réseaux Aave lus sur ${markets.length}`
                    : claimUsd > 0
                      ? `+ ${fmtDollars(claimUsd)} à réclamer`
                      : `${count} position${count > 1 ? 's' : ''}`
                  : undefined
              }
            />
            <Metric
              label="APY moyen"
              value={avgApy !== undefined ? fmtPct(avgApy) : undefined}
              tone={apyTone(avgApy)}
              sub={done ? 'pondéré par valeur nette' : undefined}
            />
            <Metric
              label="Health factor minimum"
              value={done ? (lowest ? fmtHf(lowest.hf) : '∞') : undefined}
              tone={lowest && hfTone(lowest.hf, lowest.correlated)}
              sub={lowest?.label}
              tile
            />
            <Metric
              label="Gain réel"
              value={done && gain.counted > 0 ? `${gain.usd >= 0 ? '+' : ''}${fmtDollars(gain.usd)}` : done && gain.pending === 0 ? null : undefined}
              tone={gain.counted > 0 ? apyTone(gain.usd) : undefined}
              sub={
                done && gain.counted > 0 ? (gain.counted < count ? `${gain.counted} positions sur ${count}` : `depuis le ${fmtDate(gain.since!)}`) : undefined
              }
            />
          </div>
        )}
        {user && done && (byNetwork.length > 1 || byProtocol.length > 1) && (
          <div className="split-grid">
            {byNetwork.length > 1 && <Shares title="Par réseau" shares={byNetwork} />}
            {byProtocol.length > 1 && <Shares title="Par protocole" shares={byProtocol} />}
          </div>
        )}
        {done && count === 0 && !morpho?.pending && failed.length < markets.length && (
          <div className="actions">
            <span className="muted">Aucune position Aave v3 ni Morpho Blue sur ces réseaux. Le Scanner liste les boucles disponibles.</span>
            <button className="btn" onClick={onScan}>
              Ouvrir le Scanner
            </button>
          </div>
        )}
        {user && failed.length > 0 && pending === 0 && (
          <Notice>
            <span>Illisible depuis ce navigateur : {failed.map((m) => m.label).join(', ')} (RPC public qui ne répond pas).</span>
            <button className="btn" onClick={retry}>
              Réessayer
            </button>
          </Notice>
        )}
        {slow && (
          <Notice>
            <span>
              {pending} réseau{pending > 1 ? 'x' : ''} encore en lecture : RPC publics lents.
            </span>
            <button className="btn" onClick={retry}>
              Réessayer
            </button>
          </Notice>
        )}
      </Card>

      {open.map((x) => (
        <MarketPosition
          key={x.market.id}
          {...x}
          user={user!}
          onManage={onManage}
          // rewards are claimed by the connected wallet only, not for an address typed in read-only
          canReinvest={!!account && user === account && claim.some((c) => c.chain.id === x.market.chain.id && c.balances.some((b) => b.claimable > 0))}
        />
      ))}

      {user && <V4Positions key={`v4-${user}`} user={user} onManage={onManageV4} onTotals={setV4} />}

      {user && <MorphoPositions key={user} user={user} onManage={onManageMorpho} onTotals={setMorpho} />}

      {claim.length > 0 && user && (
        <Card
          title="Récompenses à réclamer"
          aside={
            <a href={`https://app.merkl.xyz/users/${user}`} target="_blank" rel="noreferrer">
              Réclamer sur Merkl
            </a>
          }
        >
          <table className="reserves cards">
            <thead>
              <tr>
                <th>Réseau</th>
                <th>Token</th>
                <th className="num">À réclamer</th>
                <th className="num">En cours</th>
                <th className="num">Valeur</th>
              </tr>
            </thead>
            <tbody>
              {claim.flatMap((c) =>
                c.balances.map((b) => (
                  <tr key={`${c.chain.id}-${b.address}`}>
                    <td className="lead">{c.chain.name}</td>
                    <td data-label="Token">
                      {b.symbol}
                      {/* two tokens with one symbol (two WMON on Monad): the address tells them apart */}
                      {c.balances.some((o) => o !== b && o.symbol === b.symbol) && (
                        <span className="muted small">
                          {' '}
                          <span className="addr">{fmtAddress(b.address)}</span>
                        </span>
                      )}
                    </td>
                    <td className="num" data-label="À réclamer">
                      {fmtNum(b.claimable)}
                    </td>
                    <td className="num" data-label="En cours">
                      {fmtNum(b.pending)}
                    </td>
                    <td className="num" data-label="Valeur">
                      {b.usd > 0 ? fmtDollars(b.usd) : '—'}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <p className="muted small">« En cours » devient réclamable à la prochaine mise à jour de Merkl, en général toutes les 8 h.</p>
        </Card>
      )}
    </GainReport.Provider>
  )
}

const biggest = (holdings: UserPosition['holdings'], key: 'suppliedBase' | 'borrowedBase') =>
  [...holdings].sort((a, b) => (b[key] > a[key] ? 1 : b[key] < a[key] ? -1 : 0))[0]

function MarketPosition({
  market,
  snapshot,
  position,
  campaigns,
  summary: s,
  correlated,
  onManage,
  canReinvest,
  user,
}: Open & { onManage: (p: Pick) => void; canReinvest: boolean; user: Address }) {
  const { holdings, healthFactor, eModeCategory } = position
  const emode = snapshot.emodes.find((c) => c.id === eModeCategory)
  const collateral = biggest(holdings, 'suppliedBase')
  const debt = biggest(holdings, 'borrowedBase')
  const excluded = s.campaigns.filter((c) => c.reasons.length > 0)
  const paying = s.campaigns.filter((c) => c.apy > 0)
  const tone = s.debtBase > 0n ? hfTone(healthFactor, correlated) : undefined
  // a PT collateral: its maturity replaces the leverage tile (leverage moves to its second line)
  const pt = collateral.suppliedBase > 0n ? collateral.reserve.pt : undefined
  const ptDays = pt ? daysToMaturity(pt) : undefined
  const ptTone = pt && (isExpired(pt) ? 'bad' : ptDays! < 14 ? 'warn' : undefined)
  const canRenew = !!pt && needsRenewal(pt) && market.executorVersion !== 1
  const manage = (tab?: Pick['tab']) =>
    onManage({
      marketId: market.id,
      collateral: collateral.reserve.token.address,
      debt: debt.reserve.token.address,
      emode: eModeCategory,
      leverage: s.leverage,
      tab,
    })
  // history: aTokens of the market (to find the ones a contract moved) and today's oracle prices
  const aTokens = new Map(
    snapshot.reserves.map((r) => [r.aToken.toLowerCase(), { token: r.token.address, symbol: r.token.symbol, decimals: r.config.decimals }]),
  )
  const nowPrices = new Map(snapshot.reserves.map((r) => [r.token.address.toLowerCase(), Number(r.price) / 1e8]))
  const warnings = (pt && (isExpired(pt) || ptDays! < 14) ? 1 : 0) + s.endingSoon.length + excluded.length
  return (
    <PositionCard
      title={
        <>
          {collateral.reserve.token.symbol}
          {s.debtBase > 0n && ` / ${debt.reserve.token.symbol}`}
        </>
      }
      place={<Place text={marketPlace(market)} />}
      hf={healthFactor}
      tone={tone}
      levered={s.debtBase > 0n}
      tags={
        <>
          {emode && <Tag>eMode {emode.label}</Tag>}
          {pt && ptDays !== undefined && <Tag tone={ptTone === 'warn' || ptTone === 'bad' ? 'warn' : undefined}>PT · {fmtMaturity(pt.expiry)}</Tag>}
        </>
      }
      warnings={warnings}
      equity={fmtUsd(s.equityBase)}
      apy={fmtPct(s.apy)}
      apyTone={apyTone(s.apy)}
      actions={
        s.debtBase > 0n && (
          <>
            {canRenew && (
              <button className="btn small" onClick={() => manage('renew')}>
                Renouveler
              </button>
            )}
            {canReinvest && (
              <button className="btn small" onClick={() => manage('reinvest')}>
                Réinvestir
              </button>
            )}
            <button className="btn small" onClick={() => manage()}>
              Gérer
            </button>
          </>
        )
      }
    >
      <div className="metrics">
        <Metric label="Valeur nette" value={fmtUsd(s.equityBase)} sub={`dette ${fmtUsd(s.debtBase, true)}`} />
        {pt ? (
          <Metric label="Échéance du PT" value={fmtMaturity(pt.expiry)} tone={ptTone || undefined} sub={`${fmtDate(pt.expiry)} · levier ${fmtX(s.leverage)}`} />
        ) : (
          <Metric label="Levier" value={fmtX(s.leverage)} sub={emode ? `eMode ${emode.label}` : 'sans eMode'} />
        )}
        <Metric
          label="APY net"
          value={fmtPct(s.apy)}
          tone={apyTone(s.apy)}
          sub={`${fmtDollars((Number(s.equityBase) / 1e8) * (Number.isFinite(s.apy) ? s.apy : 0))} par an${s.nativeApy ? `, dont ${fmtPct(s.nativeApy)} ${pt ? 'fixe' : 'token'}` : ''}`}
        />
      </div>
      {s.debtBase > 0n && (
        <HfProjection
          healthFactor={healthFactor}
          collateral={holdings.map((h) => ({
            value: Number(h.suppliedBase),
            apy: h.reserve.supplyApy + (h.reserve.pt ? 0 : (h.reserve.native?.apy ?? 0)),
            pt: h.reserve.pt && { daysLeft: daysToMaturity(h.reserve.pt), discount: h.reserve.pt.discount },
          }))}
          debt={holdings.map((h) => ({ value: Number(h.borrowedBase), apy: h.reserve.borrowApy + (h.reserve.native?.apy ?? 0) }))}
          ptDaysLeft={pt && !isExpired(pt) ? ptDays : undefined}
          bar={{ liquidationThreshold: thresholdOf(healthFactor, Number(s.equityBase + s.debtBase), Number(s.debtBase)), correlated }}
        />
      )}
      {s.debtBase > 0n && (
        <HfTargetBlock
          id={`aave:${market.id}:${collateral.reserve.token.address}:${debt.reserve.token.address}`.toLowerCase()}
          position={{ collateralBase: s.collateralBase, debtBase: s.debtBase, healthFactor, correlated }}
          onRebalance={(r) =>
            onManage({
              marketId: market.id,
              collateral: collateral.reserve.token.address,
              debt: debt.reserve.token.address,
              emode: eModeCategory,
              leverage: r.leverage,
              // down: « Fermer / réduire » set to the target leverage; up: « Augmenter » without new capital
              ...(r.direction === 'down' ? { tab: 'close' as const } : { amount: '0' }),
            })
          }
        />
      )}
      {pt && isExpired(pt) && (
        <Notice tone="bad">
          {collateral.reserve.token.symbol} est échu depuis le {fmtDate(pt.expiry)} : il ne rapporte plus rien et la dette continue de coûter. Renouveler ou
          fermer.
        </Notice>
      )}
      {pt && !isExpired(pt) && ptDays! < 14 && (
        <Notice>
          {collateral.reserve.token.symbol} arrive à échéance le {fmtDate(pt.expiry)} ({fmtMaturity(pt.expiry)}) : après, il ne rapporte plus rien. Renouveler
          dans un PT plus long ou fermer.
        </Notice>
      )}
      {s.endingSoon.map((c) => (
        <Notice key={c.name + c.token}>
          Campagne Merkl « {c.name} » : fin le {fmtDate(c.endsAt!)} ({Math.floor(daysLeft(c))} j) : sans renouvellement, l’APY tombe à{' '}
          {fmtPct(s.apy - (s.campaigns.find((x) => x.campaign === c)?.apy ?? 0))}.
        </Notice>
      ))}
      {excluded.map((c) => (
        <Notice key={c.campaign.name + c.campaign.token}>
          « {c.campaign.name} » ({fmtPct(c.campaign.apr)}) ne paie pas cette position : {c.reasons.join(', ')}.
        </Notice>
      ))}
      {!campaigns && <p className="muted small">Merkl indisponible : APY sans bonus.</p>}
      <Fold title="Actifs" value={holdings.map((h) => `${h.reserve.token.symbol} ${h.suppliedBase > 0n ? 'déposé' : 'emprunté'}`).join(' · ')}>
        <table className="reserves cards">
          <thead>
            <tr>
              <th>Actif</th>
              <th className="num">Déposé</th>
              <th className="num">Emprunté</th>
              <th className="num">APY</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.reserve.token.address}>
                <td className="lead">{h.reserve.token.symbol}</td>
                <td className="num" data-label="Déposé">
                  {h.supplied > 0n ? `${fmtAmount(h.supplied, h.reserve.config.decimals)} (${fmtUsd(h.suppliedBase, true)})` : '—'}
                </td>
                <td className="num" data-label="Emprunté">
                  {h.borrowed > 0n ? `${fmtAmount(h.borrowed, h.reserve.config.decimals)} (${fmtUsd(h.borrowedBase, true)})` : '—'}
                </td>
                <td className="num" data-label="APY">
                  {h.supplied > 0n && `dépôt ${fmtPct(h.reserve.supplyApy)}`}
                  {h.supplied > 0n && h.borrowed > 0n && ' · '}
                  {h.borrowed > 0n && `emprunt ${fmtPct(h.reserve.borrowApy)}`}
                  {h.reserve.native && (
                    <span className="muted">
                      {' '}
                      + {fmtPct(h.reserve.native.apy)} {h.reserve.native.fixedUntil ? 'fixe' : 'token'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Fold>
      <PositionHistory
        chain={market.chain}
        queryKey={['aave', market.id, user]}
        load={(signal) => aaveHistory(market.chain.id, market.pool, user, aTokens, signal)}
        equityUsd={Number(s.equityBase) / 1e8}
        now={nowPrices}
        reference={s.debtBase > 0n ? { address: debt.reserve.token.address, symbol: debt.reserve.token.symbol } : undefined}
      />
      {paying.length > 0 && (
        <Fold title="Bonus Merkl" value={`+ ${fmtPct(s.rewardsApy)} · ${paying.length} campagne${paying.length > 1 ? 's' : ''}`}>
          <table className="reserves campaigns cards">
            <thead>
              <tr>
                <th>Campagne</th>
                <th className="num">APR affiché</th>
                <th className="num">Sur la position</th>
                <th>Fin</th>
              </tr>
            </thead>
            <tbody>
              {paying.map((c) => (
                <tr key={c.campaign.name + c.campaign.token}>
                  <td className="lead">{c.campaign.name}</td>
                  <td className="num" data-label="APR affiché">
                    {fmtPct(c.campaign.apr)}
                  </td>
                  <td className="num" data-label="Sur la position">
                    {fmtPct(c.apy)}
                  </td>
                  <td data-label="Fin">
                    <span className={daysLeft(c.campaign) < 7 ? 'warn-text' : undefined}>
                      {c.campaign.endsAt ? fmtDate(c.campaign.endsAt) : 'non indiquée'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Fold>
      )}
    </PositionCard>
  )
}
