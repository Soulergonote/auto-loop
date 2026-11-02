import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { getAddress, isAddress, type Address } from 'viem'
import { MARKETS, getMarket, type Market } from '../config'
import { daysLeft, merklQuery, type Campaign } from '../lib/merkl'
import { snapshotQuery, userPositionQuery, type Snapshot, type UserPosition } from '../lib/snapshot'
import { merklBalances, summarizePosition, userRewardsQuery } from '../lib/positions'
import { fmtAmount, fmtHf, fmtPct, fmtUsd, fmtX } from '../lib/format'
import { Card, Metric, Notice, hfTone } from './ui'
import type { Pick } from './Scanner'

const READABLE = MARKETS.filter((m) => !m.soon)
/** Balances under a cent (leftover interest after a close) are not a position. */
const DUST = 1_000_000n
const fmtDate = (s: number) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(s * 1000))
const fmtNum = (x: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: x >= 100 ? 0 : 4 }).format(x)

/** Every Aave v3 position of an address across the app's networks: value, leverage, health factor, yield, Merkl rewards. */
export function Positions({ account, onManage }: { account?: Address; onManage: (p: Pick) => void }) {
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
  const open = markets
    .map((m, i) => {
      const position = positions[i].data
      return {
        market: m,
        snapshot: snapshots[i].data,
        position: position && { ...position, holdings: position.holdings.filter((h) => h.suppliedBase + h.borrowedBase >= DUST) },
        campaigns: campaigns[chainIds.indexOf(m.chain.id)]?.data,
      }
    })
    .filter((x): x is typeof x & { snapshot: Snapshot; position: UserPosition } => !!x.snapshot && !!x.position && x.position.holdings.length > 0)
  const claim = chainIds
    .map((id, i) => ({ chain: markets.find((m) => m.chain.id === id)!.chain, balances: merklBalances(rewards[i].data) }))
    .filter((c) => c.balances.length > 0)

  return (
    <>
      <Card title="Mes positions">
        <label className="field">
          <span>Adresse {account && !typed ? '(portefeuille connecté)' : '(lecture seule)'}</span>
          <input placeholder={account ?? '0x… (ou connecte ton portefeuille)'} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
        </label>
        {typed.trim() && !isAddress(typed.trim()) && <Notice>Adresse invalide.</Notice>}
        {!user ? (
          <p className="muted">Connecte ton portefeuille ou colle une adresse pour voir ses positions Aave v3 sur tous les réseaux.</p>
        ) : (
          <p className="muted small">
            {pending > 0 ? `Lecture de ${pending} réseau${pending > 1 ? 'x' : ''} sur ${markets.length}… ` : `${markets.length - failed.length} réseaux lus. `}
            {pending === 0 && open.length === 0 && failed.length < markets.length && 'Aucune position Aave v3 sur ces réseaux. '}
            Actualisé toutes les minutes.
          </p>
        )}
        {user && failed.length > 0 && pending === 0 && (
          <Notice>
            Illisible depuis ton navigateur : {failed.map((m) => m.label).join(', ')} (RPC public qui ne répond pas).{' '}
            <button
              className="btn ghost"
              onClick={() => {
                snapshots.forEach((q) => q.isError && void q.refetch())
                positions.forEach((q) => q.isError && void q.refetch())
              }}
            >
              Réessayer
            </button>
          </Notice>
        )}
      </Card>

      {open.map((x) => (
        <MarketPosition key={x.market.id} {...x} onManage={onManage} />
      ))}

      {claim.length > 0 && user && (
        <Card title="Rewards Merkl">
          <table className="reserves">
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
                    <td>{c.chain.name}</td>
                    <td>{b.symbol}</td>
                    <td>{fmtNum(b.claimable)}</td>
                    <td>{fmtNum(b.pending)}</td>
                    <td>{b.usd > 0 ? `${fmtNum(b.usd)} $` : '—'}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <p className="muted small">
            « En cours » devient réclamable à la prochaine mise à jour de Merkl (en général toutes les 8 h).{' '}
            <a href={`https://app.merkl.xyz/users/${user}`} target="_blank" rel="noreferrer">
              Réclamer sur Merkl
            </a>
          </p>
        </Card>
      )}
    </>
  )
}

type MarketPositionProps = { market: Market; snapshot: Snapshot; position: UserPosition; campaigns?: Campaign[]; onManage: (p: Pick) => void }

function MarketPosition({ market, snapshot, position, campaigns, onManage }: MarketPositionProps) {
  const { holdings, healthFactor, eModeCategory } = position
  const s = summarizePosition(holdings, campaigns, healthFactor)
  const emode = snapshot.emodes.find((c) => c.id === eModeCategory)
  const biggest = (key: 'suppliedBase' | 'borrowedBase') => [...holdings].sort((a, b) => (b[key] > a[key] ? 1 : b[key] < a[key] ? -1 : 0))[0]
  const collateral = biggest('suppliedBase')
  const debt = biggest('borrowedBase')
  const excluded = s.campaigns.filter((c) => c.reasons.length > 0)
  return (
    <Card
      title={market.label}
      aside={
        s.debtBase > 0n && (
          <button
            className="btn ghost"
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
        <Metric label="Valeur nette" value={fmtUsd(s.equityBase)} sub={`dépôts ${fmtUsd(s.collateralBase)} · dette ${fmtUsd(s.debtBase)}`} />
        <Metric label="Levier" value={fmtX(s.leverage)} sub={emode ? `eMode ${emode.label}` : 'sans eMode'} />
        <Metric label="Health factor" value={fmtHf(healthFactor)} tone={s.debtBase > 0n ? hfTone(healthFactor, 1.1) : undefined} />
        <Metric
          label="APY net (taux actuels)"
          value={fmtPct(s.apy)}
          tone={s.apy < 0 ? 'bad' : 'good'}
          sub={
            s.rewardsApy > 0 ? `dont ${fmtPct(s.rewardsApy)} Merkl · sans Merkl ${fmtPct(s.ratesApy)}` : campaigns ? 'pas de bonus Merkl' : 'Merkl indisponible'
          }
        />
        <Metric
          label="Gain estimé par an"
          value={fmtUsd(BigInt(Math.round(Number(s.equityBase) * (Number.isFinite(s.apy) ? s.apy : 0))))}
          sub="aux taux et bonus actuels"
        />
      </div>
      {healthFactor < 1.05 && (
        <Notice tone="bad">Health factor sous 1,05 : une petite baisse du collatéral ou la hausse des intérêts suffit à liquider.</Notice>
      )}
      {s.endingSoon.map((c) => (
        <Notice key={c.name + c.token}>
          La campagne Merkl « {c.name} » se termine le {fmtDate(c.endsAt!)} ({Math.floor(daysLeft(c))} j) : sans renouvellement, l’APY tombe à{' '}
          {fmtPct(s.apy - (s.campaigns.find((x) => x.campaign === c)?.apy ?? 0))}.
        </Notice>
      ))}
      {excluded.map((c) => (
        <Notice key={c.campaign.name + c.campaign.token}>
          « {c.campaign.name} » ({fmtPct(c.campaign.apr)}) ne paie pas cette position : {c.reasons.join(', ')}.
        </Notice>
      ))}
      <table className="reserves">
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
              <td>{h.reserve.token.symbol}</td>
              <td>{h.supplied > 0n ? `${fmtAmount(h.supplied, h.reserve.config.decimals)} (${fmtUsd(h.suppliedBase)})` : '—'}</td>
              <td>{h.borrowed > 0n ? `${fmtAmount(h.borrowed, h.reserve.config.decimals)} (${fmtUsd(h.borrowedBase)})` : '—'}</td>
              <td>
                {h.supplied > 0n && `dépôt ${fmtPct(h.reserve.supplyApy)}`}
                {h.supplied > 0n && h.borrowed > 0n && ' · '}
                {h.borrowed > 0n && `emprunt ${fmtPct(h.reserve.borrowApy)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.campaigns.some((c) => c.apy > 0) && (
        <table className="reserves campaigns">
          <thead>
            <tr>
              <th>Bonus Merkl</th>
              <th>APR affiché</th>
              <th>Sur ta position</th>
              <th>Fin</th>
            </tr>
          </thead>
          <tbody>
            {s.campaigns
              .filter((c) => c.apy > 0)
              .map((c) => (
                <tr key={c.campaign.name + c.campaign.token}>
                  <td>{c.campaign.name}</td>
                  <td>{fmtPct(c.campaign.apr)}</td>
                  <td>{fmtPct(c.apy)}</td>
                  <td className={daysLeft(c.campaign) < 7 ? 'warn' : undefined}>{c.campaign.endsAt ? fmtDate(c.campaign.endsAt) : 'non indiquée'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
