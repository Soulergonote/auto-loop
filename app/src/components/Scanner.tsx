import { useMemo, useState, type ReactNode } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { MARKETS, MORPHO_NETWORKS, aggregatorsFor, getMarket, networkName, type Market } from '../config'
import { merklQuery } from '../lib/merkl'
import { snapshotQuery } from '../lib/snapshot'
import { scanMarket, type ScanFlag } from '../lib/scan'
import { morphoMarketsQuery, type MorphoMarket } from '../lib/morpho'
import { scanMorpho, type MorphoScanFlag } from '../lib/morphoScan'
import { ptInfosQuery } from '../lib/pendle'
import { fmtLltv, fmtDate, fmtDollars, fmtMaturity, fmtPct, fmtX, ptShortSymbol } from '../lib/format'
import { Card, Fold, Notice, Segmented, Skel, Tag, useSlow } from './ui'
import type { MorphoTab } from './MorphoView'

/** A pair to show in the Boucle screen; tab opens it on « Réinvestir » (positions' Merkl rewards) or « Renouveler » (a PT near maturity). */
export type Pick = { marketId: string; collateral: Address; debt: Address; emode: number; leverage: number; tab?: 'reinvest' | 'renew' }

const HFS = ['1.05', '1.1', '1.2', '1.5'] as const
type Filter = 'correlated' | 'stable' | 'all'
type Protocol = 'all' | 'aave' | 'morpho'
/** sortable columns; numbers sort high first on the first click, the pair A to Z */
type SortKey = 'pair' | 'leverage' | 'apy' | 'nativeApy' | 'rewardsApy' | 'capacityUsd'
const ROWS = 20
/** Pairs where less than this (USD) can still be looped are hidden (borrow cap or cash used up). */
const MIN_CAPACITY_USD = 1_000
/** Flagged as nearly full under this. */
const LOW_CAPACITY_USD = 50_000
const LOW_CAPACITY = BigInt(LOW_CAPACITY_USD) * 10n ** 8n

const FLAG_TAG: Record<ScanFlag | MorphoScanFlag, { text: string; tone?: 'good' | 'warn' }> = {
  conditional: { text: 'conditions Merkl' },
  nativeUnknown: { text: 'rendement du token non compté' },
  lowCapacity: { text: 'presque plein', tone: 'warn' },
  unlisted: { text: 'non listé', tone: 'warn' },
}

/** Markets the app can loop on: an aggregator quotes there. */
const SCANNABLE = MARKETS.filter((m) => !m.soon && aggregatorsFor(m.chain.id).length > 0)
const SCANNABLE_MORPHO = MORPHO_NETWORKS.filter((n) => aggregatorsFor(n.chain.id).length > 0)
/** Networks the protocol filter leaves, one per chain (Ethereum Core and Prime are one network). */
function networksOf(protocol: Protocol): { chainId: number; label: string }[] {
  const all = [
    ...(protocol === 'morpho' ? [] : SCANNABLE.map((m) => ({ chainId: m.chain.id, label: networkName(m.label) }))),
    ...(protocol === 'aave' ? [] : SCANNABLE_MORPHO.map((n) => ({ chainId: n.chain.id, label: n.label }))),
  ]
  return all.filter((n, i) => all.findIndex((x) => x.chainId === n.chainId) === i)
}

/** One line of the table, Aave pair or Morpho market. */
type Line = {
  key: string
  pair: string
  place: string
  protocol: 'aave' | 'morpho'
  tags: ReactNode[]
  leverage: number
  apy: number
  nativeApy: number
  rewardsApy: number
  capacityUsd: number
  rewardsEnd?: number
  stable: boolean
  correlated: boolean
  nativeUnknown: boolean
  open: () => void
}

const ptTag = (expiry: number) => <Tag tone={expiry - Date.now() / 1000 < 14 * 86_400 ? 'warn' : undefined}>PT · {fmtMaturity(expiry)}</Tag>
const flagTags = (flags: (ScanFlag | MorphoScanFlag)[]) =>
  flags.map((f) => (
    <Tag key={f} tone={FLAG_TAG[f].tone}>
      {FLAG_TAG[f].text}
    </Tag>
  ))

/**
 * Every pair of every Aave market and every listed Morpho Blue market, looped at a target health factor, ranked by
 * yield (rates + token yield + eligible Merkl on Aave).
 */
export function Scanner({ onPick, onPickMorpho }: { onPick: (p: Pick) => void; onPickMorpho: (m: MorphoMarket, tab?: MorphoTab, leverage?: number) => void }) {
  const [scope, setScope] = useState<number | 'all'>('all')
  const [hfText, setHf] = useState<(typeof HFS)[number]>('1.1')
  const [filter, setFilter] = useState<Filter>('correlated')
  const [showNegative, setShowNegative] = useState(false)
  const [all, setAll] = useState(false)
  const [protocol, setProtocol] = useState<Protocol>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'apy', desc: true })
  // network and protocol are separate filters; only what they leave is read
  const networks = networksOf(protocol)
  const chain = networks.some((n) => n.chainId === scope) ? scope : 'all'
  const markets: Market[] = useMemo(
    () => (protocol === 'morpho' ? [] : SCANNABLE.filter((m) => chain === 'all' || m.chain.id === chain)).map((m) => getMarket(m.id)),
    [protocol, chain],
  )
  const morphoNets = protocol === 'aave' ? [] : SCANNABLE_MORPHO.filter((n) => chain === 'all' || n.chain.id === chain)
  const snapshots = useQueries({ queries: markets.map((m) => snapshotQuery(m)) })
  const morphoLists = useQueries({ queries: morphoNets.map((n) => morphoMarketsQuery(n.chain.id, false)) })
  // a PT's yield is its Pendle implied APY: read for the PT collaterals of each network's listed markets
  const ptTokens = morphoLists.map((q) => [...new Set((q.data ?? []).filter((m) => /^PT-/i.test(m.collateral.symbol)).map((m) => m.collateral.address))])
  const morphoPts = useQueries({ queries: morphoNets.map((n, i) => ptInfosQuery(n.chain.id, ptTokens[i])) })
  // one Merkl query per chain (Ethereum Core and Prime share it)
  const chainIds = [...new Set(markets.map((m) => m.chain.id))]
  const merkl = useQueries({ queries: chainIds.map((id) => merklQuery(id)) })
  const targetHf = Number(hfText)
  const label = (id: string) => MARKETS.find((m) => m.id === id)?.label ?? id

  // recomputed when a snapshot, a Morpho list or a campaign list arrives (the query arrays are new objects at every render)
  const version = [...snapshots, ...merkl, ...morphoLists, ...morphoPts].map((q) => q.dataUpdatedAt).join()
  const rows = useMemo(() => {
    const out: Line[] = []
    for (const q of snapshots) {
      if (!q.data) continue
      const campaigns = merkl[chainIds.indexOf(q.data.market.chain.id)]?.data
      for (const r of scanMarket(q.data, campaigns, { targetHf, minCapacityBase: LOW_CAPACITY }))
        out.push({
          key: `${r.marketId}-${r.collateral.token.address}-${r.debt.token.address}`,
          pair: `${r.collateral.token.symbol} / ${r.debt.token.symbol}`,
          place: `Aave · ${label(r.marketId)}`,
          protocol: 'aave',
          tags: [
            r.collateral.pt && <span key="pt">{ptTag(r.collateral.pt.expiry)}</span>,
            r.emode && <Tag key="emode">eMode {r.emode.label}</Tag>,
            r.rewardsApy > 0 && (
              <Tag key="bonus" tone="good">
                bonus
              </Tag>
            ),
            ...flagTags(r.flags),
          ],
          leverage: r.leverage,
          apy: r.apy,
          nativeApy: r.nativeApy,
          rewardsApy: r.rewardsApy,
          capacityUsd: Number(r.capacityBase) / 1e8,
          rewardsEnd: r.rewardsEnd,
          stable: r.stable,
          correlated: r.correlated,
          nativeUnknown: r.flags.includes('nativeUnknown'),
          open: () =>
            onPick({ marketId: r.marketId, collateral: r.collateral.token.address, debt: r.debt.token.address, emode: r.emode?.id ?? 0, leverage: r.leverage }),
        })
    }
    morphoNets.forEach((n, i) => {
      const list = morphoLists[i].data
      if (!list) return
      for (const r of scanMorpho(list, { targetHf, pts: morphoPts[i].data, lowCapacityUsd: LOW_CAPACITY_USD }))
        out.push({
          key: `morpho-${n.chain.id}-${r.market.id}`,
          pair: `${ptShortSymbol(r.market.collateral.symbol)} / ${r.market.loan.symbol}`,
          place: `Morpho · ${n.label}`,
          protocol: 'morpho',
          tags: [
            <Tag key="lltv">LLTV {fmtLltv(r.market.lltv)}</Tag>,
            r.pt && <span key="pt">{ptTag(r.pt.expiry)}</span>,
            r.market.borrowRewardsApr > 0 && (
              <Tag key="bonus" tone="good">
                bonus
              </Tag>
            ),
            ...flagTags(r.flags),
          ],
          leverage: r.leverage,
          apy: r.apy,
          nativeApy: r.nativeApy,
          rewardsApy: r.market.borrowRewardsApr * (r.leverage - 1),
          capacityUsd: r.capacityUsd,
          stable: r.stable,
          correlated: r.correlated,
          nativeUnknown: r.flags.includes('nativeUnknown'),
          open: () => onPickMorpho(r.market, 'open', r.leverage),
        })
    })
    return out.sort((a, b) => b.apy - a.apy)
  }, [version, targetHf])

  const words = search
    .trim()
    .toLowerCase()
    .split(/[\s/]+/)
    .filter(Boolean)
  const shown = rows
    .filter(
      (r) =>
        (filter === 'all' || (filter === 'stable' ? r.stable : r.correlated)) &&
        (protocol === 'all' || r.protocol === protocol) &&
        words.every((w) => r.pair.toLowerCase().includes(w)) &&
        (showNegative || r.apy > 0 || r.nativeUnknown) &&
        r.capacityUsd >= MIN_CAPACITY_USD,
    )
    .sort((a, b) => {
      const d = sort.key === 'pair' ? a.pair.localeCompare(b.pair) : a[sort.key] - b[sort.key]
      return sort.desc ? -d : d
    })
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'pair' }))
  const head = (key: SortKey, text: string, num = true) => (
    <th className={`sortable ${num ? 'num' : ''}`} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button onClick={() => sortBy(key)}>
        {text}
        {sort.key === key && <span aria-hidden="true">{sort.desc ? ' ↓' : ' ↑'}</span>}
      </button>
    </th>
  )
  const loading = snapshots.filter((q) => q.isPending).length + morphoLists.filter((q) => q.isPending).length
  const slow = useSlow(loading > 0)
  const failed = [
    ...markets.filter((_, i) => snapshots[i].isError).map((m) => m.label),
    ...morphoNets.filter((_, i) => morphoLists[i].isError).map((n) => `Morpho · ${n.label}`),
  ]
  const merklFailed = chainIds.filter((_, i) => merkl[i].isError)
  const retry = () => [...snapshots, ...morphoLists].forEach((q) => (q.isError || q.isPending) && void q.refetch())
  const visible = all ? shown : shown.slice(0, ROWS)
  const hf = hfText.replace('.', ',')

  return (
    <Card>
      <div className="scan-filters">
        <div className="field">
          <span>Protocole</span>
          <Segmented
            value={protocol}
            onChange={setProtocol}
            options={[
              { value: 'all' as Protocol, label: 'Tous' },
              { value: 'aave' as Protocol, label: 'Aave' },
              { value: 'morpho' as Protocol, label: 'Morpho' },
            ]}
          />
        </div>
        <label className="field">
          <span>Réseau</span>
          <select value={chain} onChange={(e) => setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">Tous les réseaux</option>
            {networks.map((n) => (
              <option key={n.chainId} value={n.chainId}>
                {n.label}
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
      <input
        type="search"
        className="scan-search"
        aria-label="Rechercher un token"
        placeholder="Rechercher un token (wstETH, USDC…)"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <label className="check">
        <input type="checkbox" checked={showNegative} onChange={(e) => setShowNegative(e.target.checked)} /> Afficher les APY négatifs
      </label>
      {failed.length > 0 && loading === 0 && (
        <Notice>
          <span>Illisible depuis ce navigateur : {failed.join(', ')} (RPC public ou API Morpho qui ne répond pas).</span>
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
              {head('pair', 'Paire', false)}
              {head('leverage', 'Levier')}
              {head('apy', 'APY net')}
              {head('nativeApy', 'Rendement du token')}
              {head('rewardsApy', 'Bonus Merkl')}
              {head('capacityUsd', 'Capacité')}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key} className="clickable" onClick={r.open}>
                <td className="lead">
                  {r.pair}
                  {(chain === 'all' || protocol === 'all') && <span className="muted"> · {r.place}</span>}
                  <div className="tags">{r.tags}</div>
                </td>
                <td data-label="Levier" className="num">
                  {fmtX(r.leverage, true)}
                </td>
                <td data-label="APY net" className={`num ${r.apy < 0 ? 'bad' : 'good'}`}>
                  <strong>{fmtPct(r.apy)}</strong>
                </td>
                <td data-label="Rendement du token" className="num detail">
                  {r.nativeApy !== 0 ? fmtPct(r.nativeApy) : <span className="na">—</span>}
                </td>
                <td data-label="Bonus Merkl" className="num detail">
                  {r.rewardsApy > 0 ? fmtPct(r.rewardsApy) : <span className="na">—</span>}
                  {r.rewardsEnd !== undefined && <div className="muted small">jusqu’au {fmtDate(r.rewardsEnd)}</div>}
                </td>
                <td data-label="Capacité" className="num">
                  {fmtDollars(r.capacityUsd, true)}
                </td>
                <td className="row-action">
                  <button
                    className="btn small"
                    onClick={(e) => {
                      e.stopPropagation()
                      r.open()
                    }}
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
                  <td className="lead" colSpan={7}>
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
      <Fold title="Méthode" value={`levier à un health factor de ${hf}, meilleur eMode, Merkl si éligible, Morpho listé`}>
        <p className="muted small">
          Le levier de chaque paire donne un health factor de {hf}, plafonné comme le curseur de la boucle, dans la configuration eMode qui rapporte le plus.
          Les bonus Merkl ne comptent que si la position y a droit à ce health factor. Les taux sont variables : l’APY change avec l’utilisation du marché.
        </p>
        <p className="muted small">
          « Rendement du token » est le rendement propre des tokens à rendement (wstETH, sUSDe, syrupUSDC…) : la hausse de leur taux de change, prise à la
          source la plus récente qui connaît le token (taux publié on-chain, Pendle, API Morpho, sinon moyenne de l’adaptateur de prix Aave), sur le collatéral
          moins celle d’une dette qui en a un, multipliée par le levier : un rendement brut, avant le coût de l’emprunt, qui peut dépasser l’APY net. Sans
          source, l’étiquette « rendement du token non compté » le signale. Pour un PT Pendle (étiquette « PT · J−N », jours avant l’échéance), c’est l’APY fixe
          de son marché Pendle, valable jusqu’à l’échéance.
        </p>
        <p className="muted small">
          Non compté : le coût d’entrée et de sortie (affiché dans la boucle) et les campagnes Merkl à public restreint. La capacité est le capital encore «
          bouclable » avant que l’actif emprunté manque de liquidité ou atteigne un plafond.
        </p>
        <p className="muted small">
          Morpho Blue : chaque marché listé par Morpho (un collatéral, un actif emprunté, une LLTV), au levier qui donne ce health factor, plafonné au levier
          d’un health factor de 1,02 comme le curseur. Taux de l’API Morpho, relus on-chain à l’ouverture ; « Bonus Merkl » y est la part des récompenses
          d’emprunt que l’API compte. Les marchés avec un avertissement rouge de l’API sont écartés.
        </p>
      </Fold>
    </Card>
  )
}
