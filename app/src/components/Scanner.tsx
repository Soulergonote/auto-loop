import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { MARKETS, aggregatorsFor, getMarket, type Market } from '../config'
import { merklQuery } from '../lib/merkl'
import { snapshotQuery } from '../lib/snapshot'
import { scanMarket, type ScanFlag, type ScanRow } from '../lib/scan'
import { fmtHf, fmtPct, fmtX } from '../lib/format'
import { Card, Notice, Segmented } from './ui'

export type Pick = { marketId: string; collateral: Address; debt: Address; emode: number; leverage: number }

const HFS = ['1.05', '1.1', '1.2', '1.5'] as const
type Filter = 'correlated' | 'stable' | 'all'
const ROWS = 60
/** Pairs where less than this can still be looped are hidden (borrow cap or cash used up). */
const MIN_CAPACITY = 1_000n * 10n ** 8n
/** Flagged as nearly full under this. */
const LOW_CAPACITY = 50_000n * 10n ** 8n

const FLAG_TEXT: Record<ScanFlag, string> = {
  conditional: 'conditions Merkl à vérifier',
  yieldBearing: 'rendement propre du token en plus',
  lowCapacity: 'presque plein',
}

const fmtCapacity = (base: bigint) => `${new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(base) / 1e8)} $`

const fmtDate = (s: number) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(s * 1000))

/** Markets the app can loop on: an aggregator quotes there. */
const SCANNABLE = MARKETS.filter((m) => !m.soon && aggregatorsFor(m.chain.id).length > 0)

/** Every pair of every market, looped at a target health factor, ranked by yield (Aave rates + eligible Merkl). */
export function Scanner({ onPick }: { onPick: (p: Pick) => void }) {
  const [scope, setScope] = useState('all')
  const [hfText, setHf] = useState<(typeof HFS)[number]>('1.1')
  const [filter, setFilter] = useState<Filter>('correlated')
  const [showNegative, setShowNegative] = useState(false)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, targetHf])

  const shown = rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'stable' ? r.stable : r.correlated)) &&
      (showNegative || r.apy > 0 || r.flags.includes('yieldBearing')) &&
      r.capacityBase >= MIN_CAPACITY,
  )
  const loading = snapshots.filter((q) => q.isPending).length
  const failed = markets.filter((_, i) => snapshots[i].isError)
  const merklFailed = chainIds.filter((_, i) => merkl[i].isError)
  const label = (id: string) => MARKETS.find((m) => m.id === id)?.label ?? id

  return (
    <Card title="Scanner d’opportunités">
      <div className="grid2">
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
      </div>
      <div className="actions">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'correlated' as Filter, label: 'Paires corrélées' },
            { value: 'stable' as Filter, label: 'Stablecoins USD' },
            { value: 'all' as Filter, label: 'Toutes' },
          ]}
        />
        <label className="check">
          <input type="checkbox" checked={showNegative} onChange={(e) => setShowNegative(e.target.checked)} /> Afficher les APY négatifs
        </label>
      </div>
      <p className="muted small">
        {loading > 0 ? `Lecture de ${loading} marché${loading > 1 ? 's' : ''} sur ${markets.length}… ` : `${markets.length - failed.length} marché(s) lus. `}
        Levier calculé pour un health factor de {hfText.replace('.', ',')} (plafonné comme le curseur de la boucle), meilleure configuration eMode de chaque
        paire, rewards Merkl comptés seulement si la position y a droit à ce health factor. Taux variables : l’APY change avec l’utilisation du marché.
      </p>
      {failed.length > 0 && (
        <Notice>
          Illisible depuis ton navigateur : {failed.map((m) => m.label).join(', ')} (RPC public qui ne répond pas).{' '}
          <button className="btn ghost" onClick={() => snapshots.forEach((q) => q.isError && void q.refetch())}>
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
        <Notice tone="bad">Un health factor de {hfText.replace('.', ',')} sur une paire non corrélée se fait liquider au premier mouvement de prix.</Notice>
      )}
      {shown.length > 0 ? (
        <table className="reserves scan">
          <thead>
            <tr>
              {scope === 'all' && <th>Réseau</th>}
              <th>Paire</th>
              <th>Levier</th>
              <th>APY net</th>
              <th className="opt">dont Merkl</th>
              <th className="opt">Capacité</th>
              <th className="opt">Fin du bonus</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, ROWS).map((r) => (
              <tr key={`${r.marketId}-${r.collateral.token.address}-${r.debt.token.address}`}>
                {scope === 'all' && <td>{label(r.marketId)}</td>}
                <td>
                  {r.collateral.token.symbol} / {r.debt.token.symbol}
                  <div className="muted small">
                    {r.emode ? `eMode ${r.emode.label}` : 'sans eMode'}
                    {r.flags.map((f) => ` · ${FLAG_TEXT[f]}`).join('')}
                  </div>
                </td>
                <td>
                  {fmtX(r.leverage)}
                  <div className="muted small">HF {fmtHf(r.healthFactor)}</div>
                </td>
                <td className={r.apy < 0 ? 'bad' : undefined}>
                  <strong>{fmtPct(r.apy)}</strong>
                  <div className="muted small">sans Merkl {fmtPct(r.ratesApy)}</div>
                </td>
                <td className="opt">{r.rewardsApy > 0 ? <span className="reward">{fmtPct(r.rewardsApy)}</span> : '—'}</td>
                <td className="opt">{fmtCapacity(r.capacityBase)}</td>
                <td className="opt">{r.rewardsEnd ? fmtDate(r.rewardsEnd) : r.rewardsApy > 0 ? 'non indiquée' : '—'}</td>
                <td>
                  <button
                    className="btn ghost"
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
          </tbody>
        </table>
      ) : (
        loading === 0 && <p className="muted">Aucune paire ne correspond à ces filtres.</p>
      )}
      {shown.length > ROWS && (
        <p className="muted small">
          {ROWS} premières paires sur {shown.length}.
        </p>
      )}
      <p className="muted small">
        Non compté : le rendement propre des tokens à rendement (sUSDe, wstETH…), le coût d’entrée et de sortie (affiché dans la boucle), et les campagnes Merkl
        à public restreint. La capacité est le capital encore « bouclable » avant que l’actif emprunté manque de liquidité ou atteigne un plafond.
      </p>
    </Card>
  )
}
