import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Address } from 'viem'
import { MARKETS, MORPHO_NETWORKS, aggregatorsFor, getMarket, networkName, type Market } from '../../config'
import { merklQuery } from '../../services/merkl'
import { withData } from '../../services/queryData'
import { snapshotQuery } from '../../protocols/aave/snapshot'
import { scanMarket, type ScanFlag } from './aaveScan'
import { groupLines, spreadOf } from './scanGroups'
import { estimatedRoundTripUsd, gainPerYearUsd, parseAmountUsd, paybackDays } from './sizing'
import type { PairKind } from '../../domain/slippage'
import { useDebounced } from '../../ui/useDebounced'
import { SCAN_HFS, loadScanner, saveScanner, scannerQuery, type ScannerPrefs } from './prefs'
import { morphoMarketsQuery, type MorphoMarket } from '../../protocols/morpho/markets'
import { scanMorpho, type MorphoScanFlag } from './morphoScan'
import { ptInfosQuery } from '../../protocols/pendle/pt'
import { fmtAddress, fmtDays, fmtLltv, fmtDate, fmtDollars, fmtMaturity, fmtPct, fmtX, ptShortSymbol } from '../../ui/format'
import { Card, Fold, Notice, Segmented, Skel, Tag, useSlow } from '../../ui/primitives'
import type { MorphoTab } from '../loop/morpho/MorphoView'

/** A pair to show in the Boucle screen; tab opens it on « Réinvestir » (positions' Merkl rewards) or « Renouveler » (a PT near maturity). */
export type Pick = {
  marketId: string
  collateral: Address
  debt: Address
  emode: number
  leverage: number
  /** the Boucle tab to open; « close » starts its slider at `leverage` (a rebalance from Positions) */
  tab?: 'reinvest' | 'renew' | 'close'
  /** capital to fill in, collateral units as typed text (from the Scanner's amount) */
  amount?: string
}

/** USD → collateral amount to prefill, 6 significant digits; oracle price in 8 decimals */
const tokensFor = (usd: number, price: bigint) => {
  const n = usd / (Number(price) / 1e8)
  return Number.isFinite(n) && n > 0 ? String(Number(n.toPrecision(6))) : undefined
}

const HFS = SCAN_HFS
type Filter = ScannerPrefs['filter']
type Protocol = ScannerPrefs['protocol']
/** sortable columns; numbers sort high first on the first click, the pair A to Z */
type SortKey = 'pair' | 'leverage' | 'apy' | 'spread' | 'rewardsApy' | 'capacityUsd' | 'gainUsd'
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
  /** same pair, network and protocol: shown as one line with variants */
  group: string
  /** unlevered legs (see ScanRow): collateral yield, borrow cost; spread = their difference */
  collateralYield: number
  borrowCost: number
  spread: number
  /** tells apart the markets of one group (Morpho: the oracle) */
  note?: string
  pair: string
  place: string
  protocol: 'aave' | 'morpho'
  tags: ReactNode[]
  leverage: number
  apy: number
  nativeApy: number
  rewardsApy: number
  capacityUsd: number
  /** with an amount: APY before the loop's own effect on the rates, gain a year, estimated days to pay the costs */
  apyBefore?: number
  gainUsd: number
  paybackDays?: number
  /** the amount fits under the capacity (always true without an amount) */
  fits: boolean
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

/** The net APY of a line, leg by leg: collateral yield × leverage, − borrow cost × (leverage − 1), + bonuses. */
function ApyBreakdown({ line: l }: { line: Line }) {
  const L = l.leverage
  return (
    <dl className="breakdown">
      <div>
        <dt>Rendement du collatéral</dt>
        <dd>
          {fmtPct(l.collateralYield)} × {fmtX(L, true)} = {fmtPct(l.collateralYield * L)}
        </dd>
      </div>
      <div>
        <dt>Coût de l’emprunt</dt>
        <dd className={l.borrowCost > 0 ? 'bad' : undefined}>
          {fmtPct(l.borrowCost)} × {fmtX(L - 1, true)} = −{fmtPct(l.borrowCost * (L - 1))}
        </dd>
      </div>
      {l.rewardsApy > 0 && (
        <div>
          <dt>Bonus Merkl</dt>
          <dd className="good">+{fmtPct(l.rewardsApy)}</dd>
        </div>
      )}
      <div className="total">
        <dt>APY net</dt>
        <dd className={l.apy < 0 ? 'bad' : 'good'}>{fmtPct(l.apy)}</dd>
      </div>
    </dl>
  )
}

/**
 * Every pair of every Aave market and every listed Morpho Blue market, looped at a target health factor, ranked by
 * yield (rates + token yield + eligible Merkl on Aave).
 */
export function Scanner({ onPick, onPickMorpho }: { onPick: (p: Pick) => void; onPickMorpho: (m: MorphoMarket, tab?: MorphoTab, leverage?: number) => void }) {
  // filters: from a shared link, else as left in this browser; kept in the address and the browser
  const [initial] = useState(loadScanner)
  const [scope, setScope] = useState<number | 'all'>(initial.scope)
  const [hfText, setHf] = useState<(typeof HFS)[number]>(initial.hf)
  const [filter, setFilter] = useState<Filter>(initial.filter)
  const [showNegative, setShowNegative] = useState(initial.negative)
  const [all, setAll] = useState(false)
  const [protocol, setProtocol] = useState<Protocol>(initial.protocol)
  useEffect(() => {
    const prefs = { protocol, scope, hf: hfText, filter, negative: showNegative }
    saveScanner(prefs)
    const query = scannerQuery(prefs)
    const target = `#scanner${query ? `?${query}` : ''}`
    if (window.location.hash.startsWith('#scanner') && window.location.hash !== target) window.history.replaceState(null, '', target)
  }, [protocol, scope, hfText, filter, showNegative])
  const [search, setSearch] = useState('')
  // capital to loop, USD: rates right after the loop, gain a year, pairs too small greyed
  const [amountText, setAmountText] = useState('')
  const amountUsd = useDebounced(parseAmountUsd(amountText), 400)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'apy', desc: true })
  // network and protocol are separate filters; only what they leave is read
  const networks = networksOf(protocol)
  const chain = networks.some((n) => n.chainId === scope) ? scope : 'all'
  const markets: Market[] = useMemo(
    () => (protocol === 'morpho' ? [] : SCANNABLE.filter((m) => chain === 'all' || m.chain.id === chain)).map((m) => getMarket(m.id)),
    [protocol, chain],
  )
  const morphoNets = useMemo(() => (protocol === 'aave' ? [] : SCANNABLE_MORPHO.filter((n) => chain === 'all' || n.chain.id === chain)), [protocol, chain])
  // `.data` of each keeps its identity until some data really changes: the rows below are recomputed only then
  const { queries: snapshots, data: snapshotData } = useQueries({ queries: markets.map((m) => snapshotQuery(m)), combine: withData })
  const { queries: morphoLists, data: morphoListData } = useQueries({
    queries: morphoNets.map((n) => morphoMarketsQuery(n.chain.id, false)),
    combine: withData,
  })
  // a PT's yield is its Pendle implied APY: read for the PT collaterals of each network's listed markets
  const ptTokens = morphoListData.map((list) => [...new Set((list ?? []).filter((m) => /^PT-/i.test(m.collateral.symbol)).map((m) => m.collateral.address))])
  const { data: morphoPts } = useQueries({ queries: morphoNets.map((n, i) => ptInfosQuery(n.chain.id, ptTokens[i])), combine: withData })
  // one Merkl query per chain (Ethereum Core and Prime share it)
  const chainIds = useMemo(() => [...new Set(markets.map((m) => m.chain.id))], [markets])
  const { queries: merkl, data: merklData } = useQueries({ queries: chainIds.map((id) => merklQuery(id)), combine: withData })
  const targetHf = Number(hfText)
  const label = (id: string) => MARKETS.find((m) => m.id === id)?.label ?? id

  // the parent's handlers are new at every render: the rows call the latest ones without being rebuilt for them
  const picks = useRef({ onPick, onPickMorpho })
  useEffect(() => {
    picks.current = { onPick, onPickMorpho }
  })

  const rows = useMemo(() => {
    /** the amount's figures for a scanned row */
    const sized = (r: { apy: number; apyBefore?: number; leverage: number }, capacityUsd: number, kind: PairKind) => {
      if (amountUsd === undefined) return { gainUsd: 0, fits: true }
      return {
        apyBefore: r.apyBefore,
        gainUsd: gainPerYearUsd(r.apy, amountUsd),
        paybackDays: paybackDays(estimatedRoundTripUsd(kind, r.leverage, amountUsd), r.apy, amountUsd),
        fits: capacityUsd >= amountUsd,
      }
    }
    const out: Line[] = []
    for (const snapshot of snapshotData) {
      if (!snapshot) continue
      const campaigns = merklData[chainIds.indexOf(snapshot.market.chain.id)]
      const equityBase = amountUsd !== undefined ? BigInt(Math.round(amountUsd)) * 10n ** 8n : undefined
      for (const r of scanMarket(snapshot, campaigns, { targetHf, minCapacityBase: LOW_CAPACITY, equityBase }))
        out.push({
          key: `${r.marketId}-${r.collateral.token.address}-${r.debt.token.address}`,
          group: `${r.marketId}-${r.collateral.token.address}-${r.debt.token.address}`,
          collateralYield: r.collateralYield,
          borrowCost: r.borrowCost,
          spread: spreadOf(r),
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
          ...sized(r, Number(r.capacityBase) / 1e8, r.collateral.pt ? 'pt' : r.stable ? 'stable' : r.correlated ? 'correlated' : 'other'),
          rewardsEnd: r.rewardsEnd,
          stable: r.stable,
          correlated: r.correlated,
          nativeUnknown: r.flags.includes('nativeUnknown'),
          open: () =>
            picks.current.onPick({
              marketId: r.marketId,
              collateral: r.collateral.token.address,
              debt: r.debt.token.address,
              emode: r.emode?.id ?? 0,
              leverage: r.leverage,
              amount: amountUsd !== undefined ? tokensFor(amountUsd, r.collateral.price) : undefined,
            }),
        })
    }
    morphoNets.forEach((n, i) => {
      const list = morphoListData[i]
      if (!list) return
      for (const r of scanMorpho(list, { targetHf, pts: morphoPts[i], lowCapacityUsd: LOW_CAPACITY_USD, equityUsd: amountUsd }))
        out.push({
          key: `morpho-${n.chain.id}-${r.market.id}`,
          group: `morpho-${n.chain.id}-${r.market.collateral.address}-${r.market.loan.address}`,
          collateralYield: r.collateralYield,
          borrowCost: r.grossBorrowApy,
          spread: r.collateralYield - r.grossBorrowApy,
          note: `oracle ${r.market.oracleType ? `${r.market.oracleType} ` : ''}${fmtAddress(r.market.params.oracle)}`,
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
          ...sized(r, r.capacityUsd, r.pt ? 'pt' : r.stable ? 'stable' : r.correlated ? 'correlated' : 'other'),
          stable: r.stable,
          correlated: r.correlated,
          nativeUnknown: r.flags.includes('nativeUnknown'),
          open: () => picks.current.onPickMorpho(r.market, 'open', r.leverage),
        })
    })
    return out.sort((a, b) => b.apy - a.apy)
  }, [snapshotData, merklData, chainIds, morphoNets, morphoListData, morphoPts, targetHf, amountUsd])

  const words = search
    .trim()
    .toLowerCase()
    .split(/[\s/]+/)
    .filter(Boolean)
  const shown = rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'stable' ? r.stable : r.correlated)) &&
      (protocol === 'all' || r.protocol === protocol) &&
      words.every((w) => r.pair.toLowerCase().includes(w)) &&
      (showNegative || r.apy > 0 || r.nativeUnknown) &&
      r.capacityUsd >= MIN_CAPACITY_USD,
  )

  const groups = groupLines(shown).sort((x, y) => {
    const a = x.head
    const b = y.head
    // with an amount, pairs it does not fit in go last whatever the sort
    if (a.fits !== b.fits) return a.fits ? -1 : 1
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
  const visible = all ? groups : groups.slice(0, ROWS)
  const [opened, setOpened] = useState<string>()
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
      <div className="scan-inputs">
        <input
          type="search"
          className="scan-search"
          aria-label="Rechercher un token"
          placeholder="Rechercher un token (wstETH, USDC…)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          type="text"
          inputMode="decimal"
          className="scan-amount"
          aria-label="Montant à boucler en dollars"
          placeholder="Montant en $ (ex. 25k)"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
        />
      </div>
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
              {head('spread', 'Écart')}
              {head('rewardsApy', 'Bonus Merkl')}
              {amountUsd !== undefined && head('gainUsd', 'Gain / an')}
              {head('capacityUsd', 'Capacité')}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ head: r, variants }) => {
              const open = opened === r.group
              return (
                <Fragment key={r.group}>
                  <tr className={`clickable ${r.fits ? '' : 'dim'}`} onClick={r.open}>
                    <td className="lead">
                      {r.pair}
                      {(chain === 'all' || protocol === 'all') && <span className="muted"> · {r.place}</span>}
                      <div className="tags">
                        {r.tags}
                        {variants.length > 0 && (
                          <Tag>
                            + {variants.length} marché{variants.length > 1 ? 's' : ''}
                          </Tag>
                        )}
                        <button
                          type="button"
                          className="link"
                          aria-expanded={open}
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpened(open ? undefined : r.group)
                          }}
                        >
                          {open ? 'Masquer le détail' : 'Détail'}
                        </button>
                      </div>
                    </td>
                    <td data-label="Levier" className="num">
                      {fmtX(r.leverage, true)}
                    </td>
                    <td data-label="APY net" className={`num ${r.apy < 0 ? 'bad' : 'good'}`}>
                      <strong>{fmtPct(r.apy)}</strong>
                      {r.apyBefore !== undefined && Math.abs(r.apyBefore - r.apy) >= 0.001 && (
                        <div className="muted small" title="APY avant l’effet de cet emprunt sur les taux">
                          avant : {fmtPct(r.apyBefore)}
                        </div>
                      )}
                    </td>
                    <td data-label="Écart" className={`num detail ${r.spread < 0 ? 'bad' : ''}`}>
                      {fmtPct(r.spread)}
                    </td>
                    <td data-label="Bonus Merkl" className="num detail">
                      {r.rewardsApy > 0 ? fmtPct(r.rewardsApy) : <span className="na">—</span>}
                      {r.rewardsEnd !== undefined && <div className="muted small">jusqu’au {fmtDate(r.rewardsEnd)}</div>}
                    </td>
                    {amountUsd !== undefined && (
                      <td data-label="Gain / an" className={`num ${r.gainUsd < 0 ? 'bad' : ''}`}>
                        {fmtDollars(r.gainUsd, true)}
                        {r.paybackDays !== undefined && <div className="muted small">rentable en {fmtDays(Math.max(1, Math.ceil(r.paybackDays)))}</div>}
                      </td>
                    )}
                    <td data-label="Capacité" className={`num ${r.fits ? '' : 'warn'}`}>
                      {fmtDollars(r.capacityUsd, true)}
                      {!r.fits && <div className="small">trop petit pour ce montant</div>}
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
                  {open && (
                    <tr className="scan-detail">
                      <td colSpan={amountUsd !== undefined ? 8 : 7}>
                        <ApyBreakdown line={r} />
                        {variants.length > 0 && (
                          <table className="reserves variants">
                            <thead>
                              <tr>
                                <th>Autres marchés</th>
                                <th className="num">Levier</th>
                                <th className="num">APY net</th>
                                <th className="num">Écart</th>
                                <th className="num">Capacité</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {variants.map((v) => (
                                <tr key={v.key} className="clickable" onClick={v.open}>
                                  <td className="lead">
                                    <div className="tags">{v.tags}</div>
                                    {v.note && <div className="muted small">{v.note}</div>}
                                  </td>
                                  <td data-label="Levier" className="num">
                                    {fmtX(v.leverage, true)}
                                  </td>
                                  <td data-label="APY net" className={`num ${v.apy < 0 ? 'bad' : 'good'}`}>
                                    {fmtPct(v.apy)}
                                  </td>
                                  <td data-label="Écart" className="num">
                                    {fmtPct(v.spread)}
                                  </td>
                                  <td data-label="Capacité" className="num">
                                    {fmtDollars(v.capacityUsd, true)}
                                  </td>
                                  <td className="row-action">
                                    <button
                                      className="btn small"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        v.open()
                                      }}
                                    >
                                      Ouvrir
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {loading > 0 &&
              visible.length < 5 &&
              Array.from({ length: 5 - visible.length }, (_, i) => (
                <tr key={`skel-${i}`}>
                  <td className="lead" colSpan={amountUsd !== undefined ? 8 : 7}>
                    <Skel w={16} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Aucune paire ne correspond à ces filtres. Changer de health factor ou de type de paire.</p>
      )}
      {groups.length > ROWS && (
        <div className="actions">
          <span className="muted small">
            {all ? groups.length : ROWS} paires sur {groups.length}.
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
          « Écart » est le rendement du collatéral moins le coût de l’emprunt, sans levier ni bonus : ce que la paire rapporte par unité de levier, la mesure à
          comparer entre deux paires. Le rendement du collatéral compte le taux de dépôt et le rendement propre des tokens à rendement (wstETH, sUSDe,
          syrupUSDC…), pris à la source la plus récente qui connaît le token (taux publié on-chain, Pendle, API Morpho, sinon moyenne de l’adaptateur de prix
          Aave) ; le coût de l’emprunt retranche celui d’une dette qui en a un. Sans source, l’étiquette « rendement du token non compté » le signale. Pour un
          PT Pendle (étiquette « PT · J−N », jours avant l’échéance), c’est l’APY fixe de son marché Pendle, valable jusqu’à l’échéance. « Détail » montre l’APY
          net jambe par jambe ; « + N marchés » regroupe les autres marchés Morpho de la même paire sur le même réseau (autre LLTV ou autre oracle).
        </p>
        <p className="muted small">
          Avec un montant : l’APY est celui juste après cette boucle, la dette ajoutée faisant monter le taux d’emprunt (courbe de taux de la réserve Aave,
          AdaptiveCurveIRM de Morpho dont le taux cible dérive ensuite avec le temps) et le collatéral ajouté baisser son taux de dépôt ; « avant » rappelle
          l’APY sans cet effet. « Gain / an » = APY × montant ; « rentable en N j » paie une estimation des deux swaps (entrée et sortie de l’emprunt) au
          slippage par défaut de la paire, sans devis ; une paire dont la capacité est sous le montant passe en fin de liste, grisée. Les APR Merkl ne sont pas
          dilués par le montant.
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
