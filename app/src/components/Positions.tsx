import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { getAddress, isAddress, type Address } from 'viem'
import { MARKETS, getMarket, type Market } from '../config'
import { daysLeft, merklQuery, type Campaign } from '../lib/merkl'
import { snapshotQuery, userPositionQuery, type Snapshot, type UserPosition } from '../lib/snapshot'
import { biggest, merklBalances, openPosition, userRewardsQuery, type PositionSummary } from '../lib/positions'
import { apyTone, hfTone } from '../lib/tone'
import { fmtAmount, fmtDate, fmtDollars, fmtHf, fmtNum, fmtPct, fmtUsd, fmtX } from '../lib/format'
import { Card, Fold, Metric, Notice, useSlow } from './ui'
import type { Pick } from './Scanner'

const READABLE = MARKETS.filter((m) => !m.soon)

type Open = { market: Market; snapshot: Snapshot; position: UserPosition; campaigns?: Campaign[]; summary: PositionSummary; correlated: boolean }

/** Every Aave v3 position of an address across the app's networks: total first, then one card per network. */
export function Positions({ account, onManage, onScan }: { account?: Address; onManage: (p: Pick) => void; onScan: () => void }) {
  const [typed, setTyped] = useState('')
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
    const marketCampaigns = campaigns[chainIds.indexOf(market.chain.id)]?.data
    const p = openPosition(raw.holdings, raw.healthFactor, marketCampaigns)
    if (!p) return []
    return [{ market, snapshot, position: { ...raw, holdings: p.holdings }, campaigns: marketCampaigns, summary: p.summary, correlated: p.correlated }]
  })
  const claim = chainIds
    .map((id, i) => ({ chain: markets.find((m) => m.chain.id === id)!.chain, balances: merklBalances(rewards[i].data) }))
    .filter((c) => c.balances.length > 0)

  // total over every network: net value, APY weighted by net value, lowest health factor
  const equity = open.reduce((s, x) => s + x.summary.equityBase, 0n)
  const weighted = open.reduce((s, x) => s + (Number.isFinite(x.summary.apy) ? x.summary.apy * Number(x.summary.equityBase) : 0), 0)
  const levered = open.filter((x) => x.summary.debtBase > 0n)
  const lowest = levered.reduce<Open | undefined>((m, x) => (!m || x.position.healthFactor < m.position.healthFactor ? x : m), undefined)
  const claimUsd = claim.reduce((s, c) => s + c.balances.reduce((t, b) => t + b.usd, 0), 0)
  // the total shows as soon as one network is read; unreachable networks are named in a banner
  const read = markets.length - pending
  const done = !!user && (pending === 0 || open.length > 0)
  const avgApy = done && equity > 0n ? weighted / Number(equity) : undefined

  return (
    <>
      <Card title="Positions">
        <label className="field">
          <span>Adresse {account && !typed ? '(portefeuille connecté)' : '(lecture seule)'}</span>
          <input placeholder={account ?? '0x…'} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
        </label>
        {typed.trim() && !isAddress(typed.trim()) && <Notice>Adresse invalide.</Notice>}
        {!user && <p className="muted">Connecter le portefeuille ou coller une adresse : ses positions Aave v3 s’affichent pour tous les réseaux.</p>}
        {user && (open.length > 0 || pending > 0) && (
          <div className="metrics">
            <Metric
              label="Valeur nette"
              value={done ? fmtUsd(equity) : undefined}
              sub={done ? (pending > 0 ? `${read} réseaux lus sur ${markets.length}` : `${open.length} réseau${open.length > 1 ? 'x' : ''}`) : undefined}
            />
            <Metric
              label="APY moyen"
              value={avgApy !== undefined ? fmtPct(avgApy) : undefined}
              tone={apyTone(avgApy)}
              sub={done ? 'pondéré par valeur nette' : undefined}
            />
            <Metric
              label="Health factor minimum"
              value={done ? (lowest ? fmtHf(lowest.position.healthFactor) : '∞') : undefined}
              tone={lowest && hfTone(lowest.position.healthFactor, lowest.correlated)}
              sub={lowest?.market.label}
            />
            <Metric label="Merkl à réclamer" value={done ? fmtDollars(claimUsd) : undefined} sub={done ? 'réclamable et en cours' : undefined} />
          </div>
        )}
        {done && open.length === 0 && failed.length < markets.length && (
          <div className="actions">
            <span className="muted">Aucune position Aave v3 sur ces réseaux. Le Scanner liste les boucles disponibles.</span>
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
        <MarketPosition key={x.market.id} {...x} onManage={onManage} />
      ))}

      {claim.length > 0 && user && (
        <Card
          title="Rewards Merkl"
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
                <th>À réclamer</th>
                <th>En cours</th>
                <th>Valeur</th>
              </tr>
            </thead>
            <tbody>
              {claim.flatMap((c) =>
                c.balances.map((b) => (
                  <tr key={c.chain.id + b.symbol}>
                    <td className="lead">{c.chain.name}</td>
                    <td data-label="Token">{b.symbol}</td>
                    <td data-label="À réclamer">{fmtNum(b.claimable)}</td>
                    <td data-label="En cours">{fmtNum(b.pending)}</td>
                    <td data-label="Valeur">{b.usd > 0 ? fmtDollars(b.usd) : '—'}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <p className="muted small">« En cours » devient réclamable à la prochaine mise à jour de Merkl, en général toutes les 8 h.</p>
        </Card>
      )}
    </>
  )
}

function MarketPosition({ market, snapshot, position, campaigns, summary: s, correlated, onManage }: Open & { onManage: (p: Pick) => void }) {
  const { holdings, healthFactor, eModeCategory } = position
  const emode = snapshot.emodes.find((c) => c.id === eModeCategory)
  const collateral = biggest(holdings, 'suppliedBase')
  const debt = biggest(holdings, 'borrowedBase')
  const excluded = s.campaigns.filter((c) => c.reasons.length > 0)
  const paying = s.campaigns.filter((c) => c.apy > 0)
  const tone = s.debtBase > 0n ? hfTone(healthFactor, correlated) : undefined
  return (
    <Card
      title={market.label}
      aside={
        s.debtBase > 0n && (
          <button
            className="btn"
            onClick={() =>
              onManage({
                marketId: market.id,
                collateral: collateral.reserve.token.address,
                debt: debt.reserve.token.address,
                emode: eModeCategory,
                leverage: s.leverage,
              })
            }
          >
            Gérer
          </button>
        )
      }
    >
      <div className="metrics">
        <Metric label="Valeur nette" value={fmtUsd(s.equityBase)} sub={`dette ${fmtUsd(s.debtBase, true)}`} />
        <Metric label="Levier" value={fmtX(s.leverage)} sub={emode ? `eMode ${emode.label}` : 'sans eMode'} />
        <Metric label="Health factor" value={fmtHf(healthFactor)} tone={tone} sub={correlated ? 'paire corrélée' : undefined} />
        <Metric
          label="APY net"
          value={fmtPct(s.apy)}
          tone={apyTone(s.apy)}
          sub={`${fmtDollars((Number(s.equityBase) / 1e8) * (Number.isFinite(s.apy) ? s.apy : 0))} par an${s.nativeApy ? `, dont ${fmtPct(s.nativeApy)} token` : ''}`}
        />
      </div>
      {tone === 'bad' && (
        <Notice tone="bad">Health factor {fmtHf(healthFactor)} : une petite baisse du collatéral ou la hausse des intérêts suffit à liquider.</Notice>
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
              <th>Déposé</th>
              <th>Emprunté</th>
              <th>APY</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.reserve.token.address}>
                <td className="lead">{h.reserve.token.symbol}</td>
                <td data-label="Déposé">{h.supplied > 0n ? `${fmtAmount(h.supplied, h.reserve.config.decimals)} (${fmtUsd(h.suppliedBase, true)})` : '—'}</td>
                <td data-label="Emprunté">{h.borrowed > 0n ? `${fmtAmount(h.borrowed, h.reserve.config.decimals)} (${fmtUsd(h.borrowedBase, true)})` : '—'}</td>
                <td data-label="APY">
                  {h.supplied > 0n && `dépôt ${fmtPct(h.reserve.supplyApy)}`}
                  {h.supplied > 0n && h.borrowed > 0n && ' · '}
                  {h.borrowed > 0n && `emprunt ${fmtPct(h.reserve.borrowApy)}`}
                  {h.reserve.native && <span className="muted"> + {fmtPct(h.reserve.native.apy)} token</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Fold>
      {paying.length > 0 && (
        <Fold title="Bonus Merkl" value={`+ ${fmtPct(s.rewardsApy)} · ${paying.length} campagne${paying.length > 1 ? 's' : ''}`}>
          <table className="reserves campaigns cards">
            <thead>
              <tr>
                <th>Campagne</th>
                <th>APR affiché</th>
                <th>Sur la position</th>
                <th>Fin</th>
              </tr>
            </thead>
            <tbody>
              {paying.map((c) => (
                <tr key={c.campaign.name + c.campaign.token}>
                  <td className="lead">{c.campaign.name}</td>
                  <td data-label="APR affiché">{fmtPct(c.campaign.apr)}</td>
                  <td data-label="Sur la position">{fmtPct(c.apy)}</td>
                  <td data-label="Fin" className={daysLeft(c.campaign) < 7 ? 'warn' : undefined}>
                    {c.campaign.endsAt ? fmtDate(c.campaign.endsAt) : 'non indiquée'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Fold>
      )}
    </Card>
  )
}
