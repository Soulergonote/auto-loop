import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { MARKETS, aggregatorsFor, getMarket, type Market } from '../config'
import { merklQuery } from '../lib/merkl'
import { snapshotQuery } from '../lib/snapshot'
import { scanMarket, type ScanFlag, type ScanRow } from '../lib/scan'
import { fmtDate, fmtMaturity, fmtPct, fmtUsd, fmtX } from '../lib/format'
import { Card, Fold, Notice, Segmented, Skel, Tag, useSlow } from './ui'

/** A pair to show in the Boucle screen; tab opens it on « Réinvestir » (from the positions' Merkl rewards). */
export type Pick = { marketId: string; collateral: Address; debt: Address; emode: number; leverage: number; tab?: 'reinvest' }

const HFS = ['1.05', '1.1', '1.2', '1.5'] as const
type Filter = 'correlated' | 'stable' | 'all'
const ROWS = 20
/** Pairs where less than this can still be looped are hidden (borrow cap or cash used up). */
const MIN_CAPACITY = 1_000n * 10n ** 8n
/** Flagged as nearly full under this. */
const LOW_CAPACITY = 50_000n * 10n ** 8n

const FLAG_TAG: Record<ScanFlag, { text: string; tone?: 'good' | 'warn' }> = {
  conditional: { text: 'conditions Merkl' },
  nativeUnknown: { text: 'rendement du token non compté' },
  lowCapacity: { text: 'presque plein', tone: 'warn' },
}

/** Markets the app can loop on: an aggregator quotes there. */
const SCANNABLE = MARKETS.filter((m) => !m.soon && aggregatorsFor(m.chain.id).length > 0)

/** Every pair of every market, looped at a target health factor, ranked by yield (Aave rates + token yield + eligible Merkl). */
export function Scanner({ onPick }: { onPick: (p: Pick) => void }) {
  const [scope, setScope] = useState('all')
  const [hfText, setHf] = useState<(typeof HFS)[number]>('1.1')
  const [filter, setFilter] = useState<Filter>('correlated')
  const [showNegative, setShowNegative] = useState(false)
  const [all, setAll] = useState(false)
  const markets: Market[] = useMemo(() => (scope === 'all' ? SCANNABLE : SCANNABLE.filter((m) => m.id === scope)).map((m) => getMarket(m.id)), [scope])
  const snapshots = useQueries({ queries: markets.map((m) => snapshotQuery(m)) })
  // one Merkl query per chain (Ethereum Core and Prime share it)
  const chainIds = [...new Set(markets.map((m) => m.chain.id))]
  const merkl = useQueries({ queries: chainIds.map((id) => merklQuery(id)) })
  const targetHf = Number(hfText)

  // recomputed when a snapshot or a campaign list arrives (the query arrays are new objects at every render)
  const version = [...snapshots, ...merkl].map((q) => q.dataUpdatedAt).join()
  const rows = useMemo(() => {
    const out: ScanRow[] = []
    for (const q of snapshots) {
      if (!q.data) continue
      const campaigns = merkl[chainIds.indexOf(q.data.market.chain.id)]?.data
      out.push(...scanMarket(q.data, campaigns, { targetHf, minCapacityBase: LOW_CAPACITY }))
    }
    return out.sort((a, b) => b.apy - a.apy)
  }, [version, targetHf])

  const shown = rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'stable' ? r.stable : r.correlated)) &&
      (showNegative || r.apy > 0 || r.flags.includes('nativeUnknown')) &&
      r.capacityBase >= MIN_CAPACITY,
  )
  const loading = snapshots.filter((q) => q.isPending).length
  const slow = useSlow(loading > 0)
  const failed = markets.filter((_, i) => snapshots[i].isError)
  const merklFailed = chainIds.filter((_, i) => merkl[i].isError)
  const label = (id: string) => MARKETS.find((m) => m.id === id)?.label ?? id
  const retry = () => snapshots.forEach((q) => (q.isError || q.isPending) && void q.refetch())
  const visible = all ? shown : shown.slice(0, ROWS)
  const hf = hfText.replace('.', ',')

  return (
    <Card title="Scanner">
      <div className="scan-filters">
        <label className="field">
          <span>Réseau</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">Tous les réseaux</option>
            {SCANNABLE.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>Health factor visé</span>
          <Segmented value={hfText} onChange={setHf} options={HFS.map((h) => ({ value: h, label: h.replace('.', ',') }))} />
        </div>
        <div className="field">
          <span>Type de paire</span>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'correlated' as Filter, label: 'Corrélées' },
              { value: 'stable' as Filter, label: 'Stables USD' },
              { value: 'all' as Filter, label: 'Toutes' },
            ]}
          />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={showNegative} onChange={(e) => setShowNegative(e.target.checked)} /> Afficher les APY négatifs
      </label>
      {failed.length > 0 && loading === 0 && (
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
            {loading} marché{loading > 1 ? 's' : ''} encore en lecture : RPC publics lents.
          </span>
          <button className="btn" onClick={retry}>
            Réessayer
          </button>
        </Notice>
      )}
      {merklFailed.length > 0 && (
        <Notice>
          Merkl indisponible pour {merklFailed.map((id) => markets.find((m) => m.chain.id === id)?.chain.name).join(', ')} : APY sans bonus là-bas.
        </Notice>
      )}
      {filter === 'all' && targetHf < 1.2 && (
        <Notice tone="bad">Un health factor de {hf} sur une paire non corrélée se fait liquider au premier mouvement de prix.</Notice>
      )}
      {visible.length > 0 || loading > 0 ? (
        <table className="reserves scan cards">
          <thead>
            <tr>
              <th>Paire</th>
              <th className="num">Levier</th>
              <th className="num">APY net</th>
              <th className="num">dont token</th>
              <th className="num">dont Merkl</th>
              <th className="num">Capacité</th>
              <th>Fin du bonus</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={`${r.marketId}-${r.collateral.token.address}-${r.debt.token.address}`}>
                <td className="lead">
                  {r.collateral.token.symbol} / {r.debt.token.symbol}
                  {scope === 'all' && <span className="muted"> · {label(r.marketId)}</span>}
                  <div className="tags">
                    {r.collateral.pt && (
                      <Tag tone={r.collateral.pt.expiry - Date.now() / 1000 < 14 * 86_400 ? 'warn' : undefined}>PT · {fmtMaturity(r.collateral.pt.expiry)}</Tag>
                    )}
                    {r.emode && <Tag>eMode {r.emode.label}</Tag>}
                    {r.rewardsApy > 0 && <Tag tone="good">bonus</Tag>}
                    {r.flags.map((f) => (
                      <Tag key={f} tone={FLAG_TAG[f].tone}>
                        {FLAG_TAG[f].text}
                      </Tag>
                    ))}
                  </div>
                </td>
                <td data-label="Levier" className="num">
                  {fmtX(r.leverage)}
                </td>
                <td data-label="APY net" className={`num ${r.apy < 0 ? 'bad' : 'good'}`}>
                  <strong>{fmtPct(r.apy)}</strong>
                </td>
                <td data-label="dont token" className="num">
                  {r.nativeApy !== 0 ? fmtPct(r.nativeApy) : '—'}
                </td>
                <td data-label="dont Merkl" className="num">
                  {r.rewardsApy > 0 ? fmtPct(r.rewardsApy) : '—'}
                </td>
                <td data-label="Capacité" className="num">
                  {fmtUsd(r.capacityBase, true)}
                </td>
                <td data-label="Fin du bonus">{r.rewardsEnd ? fmtDate(r.rewardsEnd) : r.rewardsApy > 0 ? 'non indiquée' : '—'}</td>
                <td>
                  <button
                    className="btn small"
                    onClick={() =>
                      onPick({
                        marketId: r.marketId,
                        collateral: r.collateral.token.address,
                        debt: r.debt.token.address,
                        emode: r.emode?.id ?? 0,
                        leverage: r.leverage,
                      })
                    }
                  >
                    Ouvrir
                  </button>
                </td>
              </tr>
            ))}
            {loading > 0 &&
              visible.length < 5 &&
              Array.from({ length: 5 - visible.length }, (_, i) => (
                <tr key={`skel-${i}`}>
                  <td className="lead" colSpan={8}>
                    <Skel w={16} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Aucune paire ne correspond à ces filtres. Changer de health factor ou de type de paire.</p>
      )}
      {shown.length > ROWS && (
        <div className="actions">
          <span className="muted small">
            {all ? shown.length : ROWS} paires sur {shown.length}.
          </span>
          <button className="btn small" onClick={() => setAll(!all)}>
            {all ? `Afficher les ${ROWS} premières` : 'Afficher toutes les paires'}
          </button>
        </div>
      )}
      <Fold title="Méthode" value={`levier à un health factor de ${hf}, meilleur eMode, Merkl si éligible`}>
        <p className="muted small">
          Le levier de chaque paire donne un health factor de {hf}, plafonné comme le curseur de la boucle, dans la configuration eMode qui rapporte le plus.
          Les rewards Merkl ne comptent que si la position y a droit à ce health factor. Les taux sont variables : l’APY change avec l’utilisation du marché.
        </p>
        <p className="muted small">
          « dont token » est le rendement propre des tokens à rendement (wstETH, sUSDe…) : la hausse de leur taux de change depuis le dernier relevé de leur
          adaptateur de prix Aave, annualisée, sur le collatéral moins celle d’une dette qui en a un. Sans adaptateur lisible, l’étiquette « rendement du token
          non compté » le signale. Pour un PT Pendle (étiquette « PT · J−N », jours avant l’échéance), c’est l’APY fixe de son marché Pendle, valable jusqu’à
          l’échéance.
        </p>
        <p className="muted small">
          Non compté : le coût d’entrée et de sortie (affiché dans la boucle) et les campagnes Merkl à public restreint. La capacité est le capital encore «
          bouclable » avant que l’actif emprunté manque de liquidité ou atteigne un plafond.
        </p>
      </Fold>
    </Card>
  )
}
