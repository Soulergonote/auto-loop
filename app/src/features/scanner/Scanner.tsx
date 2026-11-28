import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { getMarket, marketPlace, networkName, type Market } from '../../config'
import { bonusPagesQuery, merklQuery, morphoCampaignsQuery, v4BonusPage } from '../../services/merkl'
import { aaveMarketUrl, aaveV4SpokeUrl, morphoMarketUrl, pendleMarketUrl } from '../../services/links'
import { ExtLink } from '../../ui/ExtLink'
import { withData } from '../../services/queryData'
import { snapshotQuery } from '../../protocols/aave/snapshot'
import { scanMarket, type ScanFlag } from './aaveScan'
import { groupLines, spreadOf } from './scanGroups'
import { estimatedRoundTripUsd, gainPerYearUsd, parseAmountUsd, paybackDays } from './sizing'
import type { PairKind } from '../../domain/slippage'
import { useDebounced } from '../../ui/useDebounced'
import { SCAN_CAPACITIES, SCAN_CAPACITY_USD, SCAN_HFS, loadScanner, saveScanner, scannerQuery, type ScannerPrefs } from './prefs'
import { morphoMarketsQuery, type MorphoMarket } from '../../protocols/morpho/markets'
import { scanMorpho, type MorphoScanFlag } from './morphoScan'
import { ptInfosQuery } from '../../protocols/pendle/pt'
import { fmtAddress, fmtBonusEnd, fmtDays, fmtLltv, fmtDate, fmtDollars, fmtMaturity, fmtPct, fmtX, ptShortSymbol } from '../../ui/format'
import { Card, Fold, Notice, Segmented, Skel, Tag, useSlow } from '../../ui/primitives'
import type { MorphoTab } from '../loop/morpho/MorphoView'
import { priceChartsQuery } from '../../services/priceHistory'
import { tokenKey } from '../../services/yield/copies'
import { depegTone, despike, maxDrawdown, ratioSeries } from '../../domain/riskSignals'
import { useSparklines, type SeriesSource } from './sparklines'
import { Sparkline } from '../../ui/Sparkline'
import { Logo, Place } from '../../ui/Logo'
import { Picker } from '../../ui/Picker'
import { networkProgress, sourceStatus } from './sources'
import { AAVE_V4_CHAINS, executorRouters, v4NetOfSpoke } from '../../config'
import type { V4Seed } from '../loop/aavev4/V4View'
import { v4ReservesQuery } from '../../protocols/aavev4/reserves'
import { scanV4 } from './v4Scan'
import { apyLines, type ApyParts } from '../../domain/apyParts'
import { SCANNABLE, SCANNABLE_MORPHO, ptTokensOf } from './snapshotPlan'
import { scannerSnapshotAt } from '../../services/scannerSnapshot'
import { stabilityStats } from '../../domain/apyHistory'

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
type Capacity = ScannerPrefs['capacity']
/** sortable columns; numbers sort high first on the first click, the pair A to Z */
type SortKey = 'pair' | 'leverage' | 'apy' | 'spread' | 'rewardsApy' | 'capacityUsd' | 'gainUsd' | HistoryKey
/** A6: sorted on the line's 30-day series (average, or deviation with the steadiest first); lines without one last */
type HistoryKey = 'apy30' | 'stability'
const isHistoryKey = (k: SortKey): k is HistoryKey => k === 'apy30' || k === 'stability'
const ROWS = 20
/** window of the « décroché » tag: largest fall of a correlated pair's price ratio */
const DEPEG_DAYS = 90
/** Flagged as nearly full under this. */
const LOW_CAPACITY_USD = 50_000
const LOW_CAPACITY = BigInt(LOW_CAPACITY_USD) * 10n ** 8n

const FLAG_TAG: Record<ScanFlag | MorphoScanFlag, { text: string; tone?: 'good' | 'warn' }> = {
  conditional: { text: 'conditions Merkl' },
  nativeUnknown: { text: 'rendement du token non compté' },
  lowCapacity: { text: 'presque plein', tone: 'warn' },
  unlisted: { text: 'non listé', tone: 'warn' },
}

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
  /** the net APY contribution by contribution, for « Détail » */
  parts: ApyParts
  /** tells apart the markets of one group (Morpho: the oracle) */
  note?: string
  pair: string
  /** ↗ after the pair: the market on the protocol's app */
  links: { href?: string; title: string }[]
  /** ↗ next to a PT's fixed yield in « Détail »: its Pendle market */
  ptUrl?: string
  /** where the Merkl page of the bonus is: known (Aave v3 and Morpho campaigns) or looked up on Merkl (Aave v4) */
  bonus?: { urls: string[] } | { chainId: number; v4: { collateral: Address; debt: Address } }
  place: string
  protocol: 'aave' | 'morpho'
  tags: ReactNode[]
  leverage: number
  apy: number
  /** A5: the APY once the Merkl bonuses with a known end (rewardsEnd) are over */
  apyAfterRewards: number
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
  /** the pair's tokens, for its price history */
  tokens: { chainId: number; collateral: Address; debt: Address }
  /** where its rate history is read (mini-curve); none for a fork of Aave the API does not follow */
  series?: SeriesSource
  /** opens the pair in the Boucle; none for a read-only line (Aave v4 where no aggregator quotes) */
  open?: () => void
}

const ptTag = (expiry: number) => (
  <Tag tone={expiry - Date.now() / 1000 < 14 * 86_400 ? 'warn' : undefined}>
    <Logo name="Pendle" />
    PT · {fmtMaturity(expiry)}
  </Tag>
)
const flagTags = (flags: (ScanFlag | MorphoScanFlag)[]) =>
  flags.map((f) => (
    <Tag key={f} tone={FLAG_TAG[f].tone}>
      {FLAG_TAG[f].text}
    </Tag>
  ))

/** The net APY of a line, one row per contribution (deposit rate apart from the token's own yield), the net APY last. */
function ApyBreakdown({ line: l, bonusUrls = [] }: { line: Line; bonusUrls?: string[] }) {
  const { lines, total } = apyLines(l.parts, { lends: l.protocol === 'aave' })
  const signed = (x: number) => `${x > 0 ? '+' : ''}${fmtPct(x)}`
  return (
    <div className="apy-detail">
      <div className="apy-detail-title">Décomposition de l’APY net · levier {fmtX(l.leverage, true)}</div>
      <div className="contribs" role="table" aria-label="Décomposition de l’APY net">
        {lines.map((c) => (
          <div role="row" key={c.label}>
            <span role="rowheader">
              {c.label}
              {c.label === 'Bonus Merkl' && bonusUrls.map((u) => <ExtLink key={u} href={u} title="Bonus sur Merkl" />)}
              {l.parts.nativeFixed && c.label === 'Rendement fixe du PT' && <ExtLink href={l.ptUrl} title="Marché du PT sur Pendle" />}
            </span>
            <span role="cell" className="num muted">
              {c.rate !== undefined && c.factor !== undefined && `${fmtPct(c.rate)} × ${fmtX(c.factor, true)}`}
            </span>
            <span role="cell" className={`num ${c.value < 0 ? 'bad' : c.value > 0 ? 'good' : ''}`}>
              {signed(c.value)}
            </span>
          </div>
        ))}
        <div role="row" className="total">
          <span role="rowheader">APY net</span>
          <span role="cell" />
          <span role="cell" className={`num ${total < 0 ? 'bad' : 'good'}`}>
            {fmtPct(total)}
          </span>
        </div>
        {l.rewardsEnd !== undefined && (
          <div role="row">
            <span role="rowheader">Sans bonus après le {fmtDate(l.rewardsEnd)}</span>
            <span role="cell" />
            <span role="cell" className={`num ${l.apyAfterRewards < 0 ? 'bad' : ''}`}>
              {fmtPct(l.apyAfterRewards)}
            </span>
          </div>
        )}
      </div>
      <p className="muted small">Taux variables du jour, hors coûts d’entrée et de sortie.</p>
    </div>
  )
}

/**
 * Every pair of every Aave market and every listed Morpho Blue market, looped at a target health factor, ranked by
 * yield (rates + token yield + eligible Merkl on Aave).
 */
export function Scanner({
  onPick,
  onPickMorpho,
  onPickV4,
}: {
  onPick: (p: Pick) => void
  onPickMorpho: (m: MorphoMarket, tab?: MorphoTab, leverage?: number) => void
  onPickV4: (p: Omit<V4Seed, 'nonce'>) => void
}) {
  // filters: from a shared link, else as left in this browser; kept in the address and the browser
  const [initial] = useState(loadScanner)
  const [scope, setScope] = useState<number | 'all'>(initial.scope)
  const [hfText, setHf] = useState<(typeof HFS)[number]>(initial.hf)
  const [filter, setFilter] = useState<Filter>(initial.filter)
  const [showNegative, setShowNegative] = useState(initial.negative)
  const [noBonus, setNoBonus] = useState(initial.noBonus)
  const [all, setAll] = useState(false)
  const [protocol, setProtocol] = useState<Protocol>(initial.protocol)
  // U1: pairs where less than this (USD) can still be looped are hidden (borrow cap or cash used up)
  const [capacity, setCapacity] = useState<Capacity>(initial.capacity)
  useEffect(() => {
    const prefs = { protocol, scope, hf: hfText, filter, negative: showNegative, noBonus, capacity }
    saveScanner(prefs)
    const query = scannerQuery(prefs)
    const target = `#scanner${query ? `?${query}` : ''}`
    if (window.location.hash.startsWith('#scanner') && window.location.hash !== target) window.history.replaceState(null, '', target)
  }, [protocol, scope, hfText, filter, showNegative, noBonus, capacity])
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
  const ptTokens = morphoListData.map(ptTokensOf)
  // M7: Merkl campaigns on Morpho the API does not count (collateral; borrow too where the network is read on-chain)
  const { queries: morphoMerklQs, data: morphoMerklData } = useQueries({
    queries: morphoNets.map((n) => morphoCampaignsQuery(n.chain.id)),
    combine: withData,
  })
  const { queries: ptQueries, data: morphoPts } = useQueries({ queries: morphoNets.map((n, i) => ptInfosQuery(n.chain.id, ptTokens[i])), combine: withData })
  // Aave v4, read-only (O3): one request for every spoke of the chains the filters leave
  const v4Chains = useMemo(() => (protocol === 'morpho' ? [] : AAVE_V4_CHAINS.filter((id) => chain === 'all' || id === chain)), [protocol, chain])
  const v4 = useQuery(v4ReservesQuery(v4Chains))
  // one Merkl query per chain (Ethereum Core and Prime share it)
  const chainIds = useMemo(() => [...new Set(markets.map((m) => m.chain.id))], [markets])
  const { queries: merkl, data: merklData } = useQueries({ queries: chainIds.map((id) => merklQuery(id)), combine: withData })
  const targetHf = Number(hfText)

  // the parent's handlers are new at every render: the rows call the latest ones without being rebuilt for them
  const picks = useRef({ onPick, onPickMorpho, onPickV4 })
  useEffect(() => {
    picks.current = { onPick, onPickMorpho, onPickV4 }
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
          parts: {
            leverage: r.leverage,
            deposit: r.collateralYield - (r.collateral.native?.apy ?? 0),
            native: r.collateral.native?.apy ?? 0,
            nativeFixed: !!r.collateral.pt,
            borrow: r.borrowCost - (r.debt.native?.apy ?? 0),
            debtNative: r.debt.native?.apy ?? 0,
            rewards: r.rewardsApy,
          },
          pair: `${r.collateral.token.symbol} / ${r.debt.token.symbol}`,
          links: [{ href: aaveMarketUrl(snapshot.market), title: `Marché ${marketPlace(snapshot.market)}` }],
          ptUrl: pendleMarketUrl(snapshot.market.chain.id, r.collateral.pt?.market),
          bonus: { urls: [...new Set(r.campaigns.flatMap((c) => (c.merklUrl ? [c.merklUrl] : [])))] },
          place: marketPlace(snapshot.market),
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
          apyAfterRewards: r.apyAfterRewards,
          nativeApy: r.nativeApy,
          rewardsApy: r.rewardsApy,
          capacityUsd: Number(r.capacityBase) / 1e8,
          ...sized(r, Number(r.capacityBase) / 1e8, r.collateral.pt ? 'pt' : r.stable ? 'stable' : r.correlated ? 'correlated' : 'other'),
          rewardsEnd: r.rewardsEnd,
          stable: r.stable,
          correlated: r.correlated,
          nativeUnknown: r.flags.includes('nativeUnknown'),
          tokens: { chainId: snapshot.market.chain.id, collateral: r.collateral.token.address, debt: r.debt.token.address },
          series: snapshot.market.fork
            ? undefined
            : {
                kind: 'aave',
                chainId: snapshot.market.chain.id,
                pool: snapshot.market.pool,
                collateral: r.collateral.token.address,
                debt: r.debt.token.address,
              },
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
      for (const r of scanMorpho(list, {
        targetHf,
        pts: morphoPts[i],
        lowCapacityUsd: LOW_CAPACITY_USD,
        equityUsd: amountUsd,
        merkl: morphoMerklData[i],
      }))
        out.push({
          key: `morpho-${n.chain.id}-${r.market.id}`,
          group: `morpho-${n.chain.id}-${r.market.collateral.address}-${r.market.loan.address}`,
          collateralYield: r.collateralYield,
          borrowCost: r.grossBorrowApy,
          spread: r.collateralYield - r.grossBorrowApy,
          parts: {
            leverage: r.leverage,
            deposit: 0,
            native: r.collateralYield,
            nativeFixed: !!r.pt,
            borrow: r.grossBorrowApy,
            rewards: r.merklApy,
          },
          note: `oracle ${fmtAddress(r.market.params.oracle)}`,
          pair: `${ptShortSymbol(r.market.collateral.symbol)} / ${r.market.loan.symbol}`,
          links: [{ href: morphoMarketUrl(n.chain.id, r.market.id), title: 'Marché sur Morpho' }],
          ptUrl: pendleMarketUrl(n.chain.id, r.pt?.market),
          bonus: { urls: r.merkl.urls },
          place: `Morpho · ${n.label}`,
          protocol: 'morpho',
          tags: [
            <Tag key="lltv">LLTV {fmtLltv(r.market.lltv)}</Tag>,
            r.pt && <span key="pt">{ptTag(r.pt.expiry)}</span>,
            r.merklApy > 0 && (
              <Tag key="bonus" tone="good">
                bonus
              </Tag>
            ),
            ...flagTags(r.flags),
          ],
          leverage: r.leverage,
          apy: r.apy,
          apyAfterRewards: r.apyAfterRewards,
          nativeApy: r.nativeApy,
          rewardsApy: r.merklApy,
          capacityUsd: r.capacityUsd,
          rewardsEnd: r.merkl.endsAt,
          ...sized(r, r.capacityUsd, r.pt ? 'pt' : r.stable ? 'stable' : r.correlated ? 'correlated' : 'other'),
          stable: r.stable,
          correlated: r.correlated,
          nativeUnknown: r.flags.includes('nativeUnknown'),
          tokens: { chainId: n.chain.id, collateral: r.market.collateral.address, debt: r.market.loan.address },
          // markets read on-chain only (O2) are not in the API
          series: n.onchain ? undefined : { kind: 'morpho', chainId: n.chain.id, marketId: r.market.id },
          open: () => picks.current.onPickMorpho(r.market, 'open', r.leverage),
        })
    })
    for (const r of v4.data ? scanV4(v4.data, { targetHf }) : []) {
      const C = r.collateral
      const D = r.debt
      // executable where the spoke has position managers known to the app and an aggregator quotes on the chain
      const executable = !!v4NetOfSpoke(C.chainId, C.spoke.address) && executorRouters(C.chainId).length > 0
      out.push({
        key: `v4-${C.chainId}-${C.spoke.address}-${C.token.address}-${D.token.address}-${D.borrowApy}`,
        group: `v4-${C.chainId}-${C.token.address}-${D.token.address}`,
        collateralYield: r.collateralYield,
        borrowCost: r.borrowCost,
        spread: r.collateralYield - r.borrowCost,
        parts: {
          leverage: r.leverage,
          deposit: C.supplyApy,
          native: C.underlyingApy,
          borrow: D.borrowApy,
          riskPremium: D.borrowApy * C.collateralRisk,
          rewards: r.rewardsApy,
        },
        note: `spoke ${C.spoke.name}`,
        pair: `${C.token.symbol} / ${D.token.symbol}`,
        links: [{ href: aaveV4SpokeUrl(C.chainId, C.spoke.address), title: `Spoke ${C.spoke.name} sur Aave v4` }],
        bonus: { chainId: C.chainId, v4: { collateral: C.token.address, debt: D.token.address } },
        place: `Aave v4 · ${C.network}`,
        protocol: 'aave',
        tags: [
          <Tag key="spoke">{C.spoke.name}</Tag>,
          !executable && <Tag key="ro">non exécutable</Tag>,
          r.rewardsApy > 0 && (
            <Tag key="bonus" tone="good">
              bonus
            </Tag>
          ),
          ...flagTags([...(r.nativeUnknown ? (['nativeUnknown'] as const) : []), ...(r.capacityUsd < LOW_CAPACITY_USD ? (['lowCapacity'] as const) : [])]),
        ],
        leverage: r.leverage,
        apy: r.apy,
        apyAfterRewards: r.apyAfterRewards,
        nativeApy: r.nativeApy,
        rewardsApy: r.rewardsApy,
        capacityUsd: r.capacityUsd,
        ...sized(r, r.capacityUsd, r.stable ? 'stable' : r.correlated ? 'correlated' : 'other'),
        rewardsEnd: r.rewardsEnd,
        stable: r.stable,
        correlated: r.correlated,
        nativeUnknown: r.nativeUnknown,
        tokens: { chainId: C.chainId, collateral: C.token.address, debt: D.token.address },
        open: executable
          ? () =>
              picks.current.onPickV4({
                chainId: C.chainId,
                spoke: C.spoke.address,
                collateralId: C.reserveId,
                debtId: D.reserveId,
                tab: 'open',
                leverage: r.leverage,
                amount: amountUsd !== undefined ? tokensFor(amountUsd, C.price) : undefined,
              })
          : undefined,
      })
    }
    return out.sort((a, b) => b.apy - a.apy)
  }, [snapshotData, merklData, chainIds, morphoNets, morphoListData, morphoPts, morphoMerklData, targetHf, amountUsd, v4.data])

  // Merkl pages of the Morpho and Aave v4 bonuses, read only on the chains that have one
  const bonusChains = useMemo(
    () => [...new Set(rows.flatMap((r) => (r.rewardsApy > 0 && r.bonus && 'chainId' in r.bonus ? [r.bonus.chainId] : [])))].sort((a, b) => a - b),
    [rows],
  )
  const { data: bonusPages } = useQueries({ queries: bonusChains.map((id) => bonusPagesQuery(id)), combine: withData })
  const bonusUrls = (r: Line): string[] => {
    const b = r.bonus
    if (!b) return []
    if ('urls' in b) return b.urls
    const pages = bonusPages[bonusChains.indexOf(b.chainId)]
    const urls = [v4BonusPage(pages, b.v4.collateral, 'supply'), v4BonusPage(pages, b.v4.debt, 'borrow')]
    return [...new Set(urls.filter((u): u is string => !!u))]
  }

  // past depeg of the correlated pairs (I4): daily prices over 90 days, one DefiLlama request per 25 tokens
  const depegTokens = useMemo(() => {
    const all = rows
      .filter((r) => r.correlated)
      .flatMap((r) => [
        { chainId: r.tokens.chainId, address: r.tokens.collateral },
        { chainId: r.tokens.chainId, address: r.tokens.debt },
      ])
    return [...new Map(all.map((t) => [tokenKey(t), t])).values()]
  }, [rows])
  const charts = useQuery(priceChartsQuery(depegTokens, { days: DEPEG_DAYS, period: '1d' }))
  const depegTag = (r: Line) => {
    if (!r.correlated || !charts.data) return null
    const a = charts.data.get(tokenKey({ chainId: r.tokens.chainId, address: r.tokens.collateral }))
    const b = charts.data.get(tokenKey({ chainId: r.tokens.chainId, address: r.tokens.debt }))
    if (!a || !b) return null
    const dd = maxDrawdown(despike(ratioSeries(a, b, 12 * 3600)))
    return depegTone(dd, true) === 'good' ? null : (
      <Tag key="depeg" tone="warn">
        décroché −{fmtPct(dd, 1)} sur {DEPEG_DAYS} j
      </Tag>
    )
  }

  const words = search
    .trim()
    .toLowerCase()
    .split(/[\s/]+/)
    .filter(Boolean)
  // « Toutes » (key 1k) hides nothing, not even an almost full market
  const minCapacity = capacity === '1k' ? 0 : SCAN_CAPACITY_USD[capacity]
  const matching = rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'stable' ? r.stable : r.correlated)) &&
      (protocol === 'all' || r.protocol === protocol) &&
      words.every((w) => r.pair.toLowerCase().includes(w)) &&
      (showNegative || r.apy > 0 || r.nativeUnknown),
  )
  const shown = matching.filter((r) => r.capacityUsd >= minCapacity)
  // pairs the other filters keep and the capacity hides, counted once per group (as the table shows them)
  const tooSmall = new Set(matching.filter((r) => r.capacityUsd < minCapacity && r.capacityUsd >= SCAN_CAPACITY_USD['1k']).map((r) => r.group))
  shown.forEach((r) => tooSmall.delete(r.group))

  const historySort = isHistoryKey(sort.key)
  // A5: « Trier sans le bonus Merkl » ranks, and picks the best market of a group, on the APY after the dated bonuses
  const apyOf = (l: Line) => (noBonus ? l.apyAfterRewards : l.apy)
  const unsorted = groupLines(shown, apyOf)
  /** the groups in the chosen order; a history sort uses `history` (line key → its value), lines without one last */
  const order = (history?: Map<string, number>) =>
    [...unsorted].sort((x, y) => {
      const a = x.head
      const b = y.head
      // with an amount, pairs it does not fit in go last whatever the sort
      if (a.fits !== b.fits) return a.fits ? -1 : 1
      if (isHistoryKey(sort.key)) {
        const ha = history?.get(a.key)
        const hb = history?.get(b.key)
        if (ha === undefined || hb === undefined) return ha !== undefined ? -1 : hb !== undefined ? 1 : apyOf(b) - apyOf(a)
        return sort.desc ? hb - ha : ha - hb
      }
      const d = sort.key === 'pair' ? a.pair.localeCompare(b.pair) : sort.key === 'apy' ? apyOf(a) - apyOf(b) : a[sort.key] - b[sort.key]
      return sort.desc ? -d : d
    })
  const byToday = historySort ? unsorted : order()
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'pair' }))
  const head = (key: SortKey, text: string, num = true, detail = false) => (
    <th
      className={`sortable ${num ? 'num' : ''} ${detail ? 'detail' : ''}`}
      aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}
    >
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
  const merklFailed = [
    ...new Set([...chainIds.filter((_, i) => merkl[i].isError), ...morphoNets.filter((_, i) => morphoMerklQs[i].isError).map((n) => n.chain.id)]),
  ]
  const retry = () => [...snapshots, ...morphoLists].forEach((q) => (q.isError || q.isPending) && void q.refetch())
  const [opened, setOpened] = useState<string>()
  // J3: 30-day mini-curve of each shown line (A6: of every filtered line, to sort on them); per-network progress
  // while reading. I7: what was read, what did not answer
  const sparks = useSparklines(
    (historySort || all ? byToday : byToday.slice(0, ROWS)).map((g) => g.head),
    !historySort || loading === 0,
  )
  const stats = new Map(
    unsorted.flatMap((g) => {
      const st = sparks.points.has(g.head.key) ? stabilityStats(sparks.points.get(g.head.key)!) : undefined
      return st ? [[g.head.key, st] as const] : []
    }),
  )
  // the steadiest first on the first click (« desc »): the deviation sorts negated; a line losing money on average
  // is steady for nothing, it ranks after those that earn
  const historyValue = (st: { average: number; deviation: number }) => (sort.key === 'apy30' ? st.average : st.average > 0 ? -st.deviation : -1 - st.deviation)
  const groups = historySort ? order(new Map([...stats].map(([k, st]) => [k, historyValue(st)]))) : byToday
  const visible = all ? groups : groups.slice(0, ROWS)
  const progress = networkProgress([
    ...markets.map((m, i) => ({ label: networkName(m.label), pending: snapshots[i].isPending, failed: snapshots[i].isError })),
    ...morphoNets.map((n, i) => ({ label: n.label, pending: morphoLists[i].isPending, failed: morphoLists[i].isError })),
  ])
  // D1: networks still shown from the hourly snapshot (their live read not back yet)
  const snapAt = scannerSnapshotAt()
  const fromSnapshot = new Set([
    ...markets.filter((_, i) => snapAt !== undefined && snapshots[i].dataUpdatedAt === snapAt).map((m) => networkName(m.label)),
    ...morphoNets.filter((_, i) => snapAt !== undefined && morphoLists[i].dataUpdatedAt === snapAt).map((n) => n.label),
  ])
  const status = sourceStatus({
    snapshot: snapAt !== undefined ? { at: snapAt, networks: fromSnapshot.size } : undefined,
    networks: progress,
    readAt: Math.max(0, ...snapshots.map((q) => q.dataUpdatedAt), ...morphoLists.map((q) => q.dataUpdatedAt)),
    silent: [
      ptQueries.some((q) => q.isError) && 'Pendle',
      charts.isError && 'DefiLlama',
      v4.isError && 'Aave v4',
      sparks.failed.aave && 'historique Aave',
      sparks.failed.morpho && 'historique Morpho',
    ],
  })
  const hf = hfText

  return (
    <>
      <Card title="Filtres">
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
          <Picker
            label="Réseau"
            value={String(chain)}
            onChange={(v) => setScope(v === 'all' ? 'all' : Number(v))}
            options={[
              { value: 'all', label: 'Tous les réseaux' },
              ...networks.map((n) => ({ value: String(n.chainId), label: n.label, icon: <Logo name={n.label} /> })),
            ]}
          />
          <div className="field">
            <span>Health factor visé</span>
            <Segmented value={hfText} onChange={setHf} options={HFS.map((h) => ({ value: h, label: h }))} />
          </div>
          <div className="field">
            <span>Capacité min.</span>
            <Segmented
              value={capacity}
              onChange={setCapacity}
              options={SCAN_CAPACITIES.map((c) => ({ value: c, label: c === '1k' ? 'Toutes' : fmtDollars(SCAN_CAPACITY_USD[c], true) }))}
            />
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
        <label className="check" title="Classe sur l’APY une fois finies les campagnes Merkl dont la date de fin est connue">
          <input type="checkbox" checked={noBonus} onChange={(e) => setNoBonus(e.target.checked)} /> Trier sans le bonus Merkl
        </label>
      </Card>
      <Card title={`Meilleures boucles · HF visé ${hf}`} aside={status && <span className="scan-status">{status}</span>}>
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
            Merkl indisponible pour{' '}
            {merklFailed.map((id) => markets.find((m) => m.chain.id === id)?.chain.name ?? morphoNets.find((n) => n.chain.id === id)?.label).join(', ')} : APY
            sans bonus là-bas.
          </Notice>
        )}
        {filter === 'all' && targetHf < 1.2 && (
          <Notice tone="bad">Un health factor de {hf} sur une paire non corrélée se fait liquider au premier mouvement de prix.</Notice>
        )}
        {loading > 0 && (
          <p className="scan-progress small" aria-live="polite">
            {progress.map((n, i) => (
              <Fragment key={n.label}>
                {i > 0 && ' · '}
                <span className={n.state === 'failed' ? 'warn-text' : n.state === 'pending' ? 'muted' : undefined}>
                  {n.label} {n.state === 'failed' ? 'échec' : n.state === 'pending' ? 'en cours' : 'lu'}
                </span>
              </Fragment>
            ))}
          </p>
        )}
        {visible.length > 0 || loading > 0 ? (
          <table className="reserves scan cards">
            <thead>
              <tr>
                {head('pair', 'Paire', false)}
                {head('leverage', 'Levier')}
                {head('apy', 'APY net')}
                {head('spread', 'Écart', true, true)}
                {head('rewardsApy', 'Bonus Merkl', true, true)}
                {head('apy30', 'Moy. 30 j', true, true)}
                {head('stability', 'Stabilité', true, true)}
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
                    <tr className={`${r.open ? 'clickable' : ''} ${r.fits ? '' : 'dim'} ${open ? 'open' : ''}`} onClick={r.open}>
                      <td className="lead">
                        <b className="scan-pair">
                          {r.pair}
                          {r.links.map((l) => (
                            <ExtLink key={l.title} href={l.href} title={l.title} />
                          ))}
                        </b>
                        <div className="tags">
                          <span className="scan-place">
                            <Place text={r.place} />
                          </span>
                          {r.tags}
                          {depegTag(r)}
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
                        {sparks.points.has(r.key) && <Sparkline points={sparks.points.get(r.key)!} />}
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
                        {r.rewardsEnd !== undefined && (
                          <div className={`small ${r.apyAfterRewards < 0 ? 'bad' : 'muted'}`}>{fmtBonusEnd(r.rewardsEnd, r.apyAfterRewards)}</div>
                        )}
                      </td>
                      {(() => {
                        const st = stats.get(r.key)
                        return (
                          <>
                            <td data-label="Moy. 30 j" className={`num detail ${st && st.average < 0 ? 'bad' : ''}`}>
                              {st ? fmtPct(st.average) : <span className="na">—</span>}
                            </td>
                            <td data-label="Stabilité" className="num detail" title={st ? `écart-type de l’APY net sur ${st.days} jours` : undefined}>
                              {st ? `±\u00a0${fmtPct(st.deviation)}` : <span className="na">—</span>}
                            </td>
                          </>
                        )
                      })()}
                      {amountUsd !== undefined && (
                        <td data-label="Gain / an" className={`num ${r.gainUsd < 0 ? 'bad' : ''}`}>
                          {r.fits ? fmtDollars(r.gainUsd, true) : <span className="na">—</span>}
                          {r.fits && r.paybackDays !== undefined && (
                            <div className="muted small">rentable en {fmtDays(Math.max(1, Math.ceil(r.paybackDays)))}</div>
                          )}
                        </td>
                      )}
                      <td data-label="Capacité" className="num" title={r.fits ? undefined : 'Trop petit pour ce montant'}>
                        {r.fits ? fmtDollars(r.capacityUsd, true) : <span className="warn-text">{fmtDollars(r.capacityUsd, true)}</span>}
                      </td>
                      <td className="row-action">
                        {r.open && (
                          <button
                            className="btn small"
                            onClick={(e) => {
                              e.stopPropagation()
                              r.open?.()
                            }}
                          >
                            Ouvrir
                          </button>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="scan-detail">
                        <td colSpan={amountUsd !== undefined ? 10 : 9}>
                          <ApyBreakdown line={r} bonusUrls={bonusUrls(r)} />
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
                                  <tr key={v.key} className={v.open ? 'clickable' : undefined} onClick={v.open}>
                                    <td className="lead">
                                      <div className="tags">
                                        {v.tags}
                                        {depegTag(v)}
                                      </div>
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
                                      {v.open && (
                                        <button
                                          className="btn small"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            v.open?.()
                                          }}
                                        >
                                          Ouvrir
                                        </button>
                                      )}
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
                    <td className="lead" colSpan={amountUsd !== undefined ? 10 : 9}>
                      <Skel w={16} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Aucune paire ne correspond à ces filtres. Changer de health factor ou de type de paire.</p>
        )}
        {historySort && sparks.pending && (
          <p className="muted small scan-status">Historique sur 30 jours en lecture pour toutes les paires : tri provisoire.</p>
        )}
        {visible.some((g) => !g.head.fits) && <p className="muted small scan-status">Capacité en ambre, ligne grisée : trop petite pour ce montant.</p>}
        {capacity !== '1k' && tooSmall.size > 0 && loading === 0 && (
          <p className="muted small scan-status">
            {tooSmall.size} paire{tooSmall.size > 1 ? 's' : ''} sous {fmtDollars(minCapacity, true)} de capacité masquée{tooSmall.size > 1 ? 's' : ''}.{' '}
            <button type="button" className="link" onClick={() => setCapacity('1k')}>
              Tout afficher
            </button>
          </p>
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
            « Écart » est le rendement du collatéral moins le coût de l’emprunt, sans levier ni bonus : ce que la paire rapporte par unité de levier, la mesure
            à comparer entre deux paires. Le rendement du collatéral compte le taux de dépôt et le rendement propre des tokens à rendement (wstETH, sUSDe,
            syrupUSDC…), pris à la source la plus récente qui connaît le token (taux publié on-chain, prix de part d’un coffre, Pendle, sinon moyenne de
            l’adaptateur de prix Aave) ; le coût de l’emprunt retranche celui d’une dette qui en a un. Sans source, l’étiquette « rendement du token non compté
            » le signale. Pour un PT Pendle (étiquette « PT · J−N », jours avant l’échéance), c’est l’APY fixe de son marché Pendle, valable jusqu’à l’échéance.
            « Détail » montre l’APY net, une ligne par contribution ; « + N marchés » regroupe les autres marchés Morpho de la même paire sur le même réseau
            (autre LLTV ou autre oracle).
          </p>
          <p className="muted small">
            « Moy. 30 j » est l’APY net moyen des 30 derniers jours au levier de la ligne, « Stabilité » son écart-type (la plus stable en tête) : la courbe de
            la colonne APY, taux de l’API Aave ou Morpho, rendement du token et Merkl au niveau du jour. Une paire sans historique (SparkLend, Aave v4, Morpho
            lu on-chain) passe en fin de liste sur ces deux tris ; sur « Stabilité », une paire à APY moyen négatif passe après celles qui rapportent.
          </p>
          <p className="muted small">
            Avec un montant : l’APY est celui juste après cette boucle, la dette ajoutée faisant monter le taux d’emprunt (courbe de taux de la réserve Aave,
            AdaptiveCurveIRM de Morpho dont le taux cible dérive ensuite avec le temps) et le collatéral ajouté baisser son taux de dépôt ; « avant » rappelle
            l’APY sans cet effet. « Gain / an » = APY × montant ; « rentable en N j » paie une estimation des deux swaps (entrée et sortie de l’emprunt) au
            slippage par défaut de la paire, sans devis ; une paire dont la capacité est sous le montant passe en fin de liste, grisée. Les APR Merkl ne sont
            pas dilués par le montant.
          </p>
          <p className="muted small">
            Non compté : le coût d’entrée et de sortie (affiché dans la boucle) et les campagnes Merkl à public restreint. La capacité est le capital encore «
            bouclable » avant que l’actif emprunté manque de liquidité ou atteigne un plafond ; « Capacité min. » masque les paires qui en ont moins (toujours
            celles sous 1 000 $).
          </p>
          <p className="muted small">
            Aave v4 : chaque paire collatéral / dette d’un même spoke, d’après l’API publique d’Aave, au levier qui donne ce health factor avec le facteur de
            collatéral du spoke. Le coût de l’emprunt compte la prime de risque que ce collatéral ajoute au taux de base ; les bonus Merkl de l’API sont comptés
            sans vérifier leurs conditions. La ligne s’ouvre dans la Boucle ; l’étiquette « non exécutable » marque un réseau où aucun agrégateur ne cote.
          </p>
          <p className="muted small">
            Morpho Blue : chaque marché listé par Morpho (un collatéral, un actif emprunté, une LLTV), au levier qui donne ce health factor, plafonné au levier
            d’un health factor de 1,02 comme le curseur. Marchés de l’API Morpho, taux lus on-chain sur l’IRM de chaque marché ; « Bonus Merkl » y additionne
            les campagnes Merkl : dépôt du collatéral (sur ce marché ou sur tout marché), au levier ; emprunt, au levier moins un. Une campagne à public
            restreint est écartée, une campagne à règles non lues porte « conditions Merkl ». Les marchés avec un avertissement rouge de l’API sont écartés.
          </p>
        </Fold>
      </Card>
    </>
  )
}
