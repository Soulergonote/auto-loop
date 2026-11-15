import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { type Address } from 'viem'
import {
  DEFAULT_COLLATERAL_SYMBOLS,
  DEFAULT_DEBT_SYMBOLS,
  DEFAULT_MARKET_ID,
  DEMO,
  MARKETS,
  MORPHO_NETWORKS,
  V4_NETWORKS,
  getV4Net,
  v4NetOfSpoke,
  isV4Id,
  QUOTE_MODE,
  getMarket,
  getMorphoNet,
  isMorphoId,
  marketInstance,
  networkName,
  savedExecutors,
  storeExecutors,
  executorRouters,
  supportsChain,
  wrappedNative,
  type AggregatorChoice,
  type Market,
  type Token,
} from '../config'
import { useReserveTokens } from '../protocols/aave/useMarket'
import { merklQuery } from '../services/merkl'
import { fmtAddress } from '../ui/format'
import { useBalances } from '../chain/walletTokens'
import { Picker } from '../ui/Picker'
import { Logo } from '../ui/Logo'
import { PrivateRpc } from '../features/loop/shared/PrivateRpc'
import { AggregatorPicker, Card, LoopLayout, Notice, Segmented, Skel, Summary } from '../ui/primitives'
import { DeployPanel } from '../features/loop/shared/DeployPanel'
import {
  deployExecutor,
  deployMorphoExecutor,
  deployV4Executor,
  sharedV4ExecutorAddress,
  useSharedV4Executor,
  useV4ExecutorCheck,
  sharedExecutorAddress,
  sharedMorphoExecutorAddress,
  useExecutorCheck,
  useMorphoExecutorCheck,
  useSharedExecutor,
  useSharedMorphoExecutor,
} from '../chain/deploy'
import { GateProvider, type Gate } from '../ui/gate'
import { MorphoView, type MorphoSeed, type MorphoTab } from '../features/loop/morpho/MorphoView'
import { V4View, type V4Seed } from '../features/loop/aavev4/V4View'
import type { MorphoMarket } from '../protocols/morpho/markets'
import { Scanner, type Pick } from '../features/scanner/Scanner'
import { Positions } from '../features/positions/Positions'
import { useQuery } from '@tanstack/react-query'
import { snapshotQuery } from '../protocols/aave/snapshot'
import { scanMarket, type ScanRow } from '../features/scanner/aaveScan'
import { BEST_MIN_CAPACITY, bestPair, loadScanner, savePair, savedPair } from '../features/scanner/prefs'

import { WalletButton } from './WalletButton'
import { TokenSelect } from '../features/loop/shared/TokenSelect'
import { AaveView, type Seed } from '../features/loop/aave/AaveView'
type View = 'loop' | 'scan' | 'positions'
/** each screen has its own address, so a link or a reload lands on it */
const HASHES: Record<View, string> = { loop: 'boucle', scan: 'scanner', positions: 'positions' }
function viewFromHash(): View | undefined {
  const h = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]
  return (Object.keys(HASHES) as View[]).find((v) => HASHES[v] === h)
}

type Protocol = 'aave' | 'v4' | 'morpho'
const AAVE_MARKETS = MARKETS.filter((m) => !m.soon)
/** Networks of each protocol, one entry per chain; an Aave network leads to its first market. */
const PLACES: Record<Protocol, { id: string; chainId: number; label: string }[]> = {
  aave: AAVE_MARKETS.filter((m, i) => AAVE_MARKETS.findIndex((x) => x.chain.id === m.chain.id) === i).map((m) => ({
    id: m.id,
    chainId: m.chain.id,
    label: networkName(m.label),
  })),
  // Aave v4: one entry per chain; Ethereum has two sets of position managers (the « Marché » choice)
  v4: V4_NETWORKS.filter((n, i) => V4_NETWORKS.findIndex((x) => x.chain.id === n.chain.id) === i).map((n) => ({
    id: n.id,
    chainId: n.chain.id,
    label: networkName(n.label),
  })),
  morpho: MORPHO_NETWORKS.map((n) => ({ id: n.id, chainId: n.chain.id, label: n.label })),
}

const MARKET_KEY = 'auto-loop.market'

/** The page address: #boucle/<network>/<collateral>/<debt>, #scanner, #positions. */
function hashParts(): string[] {
  try {
    return window.location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  } catch {
    return []
  }
}
const isNetworkId = (id?: string) =>
  !!id && (MARKETS.some((m) => m.id === id && !m.soon) || MORPHO_NETWORKS.some((n) => n.id === id) || V4_NETWORKS.some((n) => n.id === id))

function savedMarketId(): string {
  // a link to a pair opens its network, whatever was chosen last in this browser
  const [view, id] = hashParts()
  if (view === HASHES.loop && isNetworkId(id)) return id
  try {
    return localStorage.getItem(MARKET_KEY) ?? DEFAULT_MARKET_ID
  } catch {
    return DEFAULT_MARKET_ID
  }
}

/** Default pair of a market: WETH-like against USDC-like when listed. */
function defaultPair(tokens: Token[]) {
  const bySymbol = (symbols: string[], not?: Token) => symbols.map((s) => tokens.find((t) => t.symbol === s)).find((t): t is Token => !!t && t !== not)
  const collateral = bySymbol(DEFAULT_COLLATERAL_SYMBOLS) ?? tokens[0]
  const debt = bySymbol(DEFAULT_DEBT_SYMBOLS, collateral) ?? tokens.find((t) => t !== collateral)!
  return { collateral, debt }
}

export function App() {
  const { address, status } = useAccount()
  const [marketId, setMarketId] = useState(savedMarketId)
  const [localExecutors, setLocalExecutors] = useState(savedExecutors)
  const declared = useMemo(() => getMarket(marketId, localExecutors), [marketId, localExecutors])
  // an executor is only offered for signing once its on-chain code is checked to be exactly this contract
  const check = useExecutorCheck(declared)
  const market = useMemo(
    () =>
      !declared.executor
        ? declared
        : check.data
          ? { ...declared, executorVersion: check.data.version, executorPendle: check.data.pendle, executorDebtSwap: check.data.debtSwap }
          : { ...declared, executor: undefined },
    [declared, check.data],
  )
  const setLocalExecutor = useCallback((id: string, a?: Address) => {
    setLocalExecutors((prev) => {
      const next = { ...prev }
      if (a) next[id] = a
      else delete next[id]
      storeExecutors(next)
      return next
    })
  }, [])
  // Morpho Blue: a network of the selector whose id starts with morpho-; the executor is checked the same way
  const morpho = isMorphoId(marketId)
  const v4 = isV4Id(marketId)
  const declaredMorpho = useMemo(() => getMorphoNet(marketId, localExecutors), [marketId, localExecutors])
  const morphoCheck = useMorphoExecutorCheck(morpho ? declaredMorpho : { ...declaredMorpho, executor: undefined })
  const morphoNet = useMemo(
    () => (morphoCheck.data ? { ...declaredMorpho, executorRefinance: morphoCheck.data.refinance } : { ...declaredMorpho, executor: undefined }),
    [declaredMorpho, morphoCheck.data],
  )
  // the shared executor of the network (CREATE2, same address for everyone): used as soon as someone deployed it
  const sharedAave = useSharedExecutor(
    declared,
    !DEMO && !morpho && !v4 && (!declared.executor || check.data?.version === 1 || (check.data !== undefined && (!check.data.pendle || !check.data.debtSwap))),
  )
  const sharedMorpho = useSharedMorphoExecutor(declaredMorpho, !DEMO && morpho && !declaredMorpho.executor)
  // Aave v4: a network whose id starts with v4-; one executor per set of Aave position managers, checked the same way
  const declaredV4 = useMemo(() => getV4Net(marketId, localExecutors), [marketId, localExecutors])
  const v4Check = useV4ExecutorCheck(v4 ? declaredV4 : { ...declaredV4, executor: undefined })
  const v4Net = useMemo(() => (v4Check.data ? declaredV4 : { ...declaredV4, executor: undefined }), [declaredV4, v4Check.data])
  const sharedV4 = useSharedV4Executor(declaredV4, !DEMO && v4 && !declaredV4.executor)
  const isSharedV4 = !!v4Net.executor && v4Net.executor === sharedV4ExecutorAddress(v4Net)
  /** neither Aave v3 nor its token list: Morpho and Aave v4 bring their own screen */
  const other = morpho || v4
  useEffect(() => {
    if (!morpho && !v4 && !declared.executor && sharedAave.data) setLocalExecutor(declared.id, sharedAave.data)
    if (morpho && !declaredMorpho.executor && sharedMorpho.data) setLocalExecutor(declaredMorpho.id, sharedMorpho.data)
    if (v4 && !declaredV4.executor && sharedV4.data) setLocalExecutor(declaredV4.id, sharedV4.data)
  }, [
    morpho,
    v4,
    declared.id,
    declared.executor,
    declaredMorpho.id,
    declaredMorpho.executor,
    declaredV4.id,
    declaredV4.executor,
    sharedAave.data,
    sharedMorpho.data,
    sharedV4.data,
    setLocalExecutor,
  ])
  const isShared = (m: Market) => !!m.executor && m.executor === sharedExecutorAddress(m)
  const isSharedMorpho = !!morphoNet.executor && morphoNet.executor === sharedMorphoExecutorAddress(morphoNet)

  // what the summary's single button walks through before the screen's own action (charte v2, rule 2)
  const { isPending: checkPending, isError: checkError } = check
  const { isPending: morphoCheckPending, isError: morphoCheckError } = morphoCheck
  const { isPending: v4CheckPending, isError: v4CheckError } = v4Check
  const gate = useMemo<Gate | undefined>(() => {
    if (DEMO) return undefined
    const statusOf = (executor: Address | undefined, c: { isPending: boolean; isError: boolean }): Gate['executor'] =>
      !executor ? 'missing' : c.isError ? 'refused' : c.isPending ? 'checking' : 'ok'
    if (morpho)
      return {
        chain: declaredMorpho.chain,
        label: declaredMorpho.label,
        executor:
          executorRouters(declaredMorpho.chain.id).length === 0
            ? 'none'
            : statusOf(declaredMorpho.executor, { isPending: morphoCheckPending, isError: morphoCheckError }),
        deploy: (onStep) => deployMorphoExecutor(declaredMorpho, onStep),
        onDeployed: (a) => setLocalExecutor(declaredMorpho.id, a),
      }
    if (v4)
      return {
        chain: declaredV4.chain,
        label: declaredV4.label,
        executor:
          executorRouters(declaredV4.chain.id).length === 0 ? 'none' : statusOf(declaredV4.executor, { isPending: v4CheckPending, isError: v4CheckError }),
        deploy: (onStep) => deployV4Executor(declaredV4, onStep),
        onDeployed: (a) => setLocalExecutor(declaredV4.id, a),
      }
    return {
      chain: declared.chain,
      label: declared.label,
      executor: executorRouters(declared.chain.id).length === 0 ? 'none' : statusOf(declared.executor, { isPending: checkPending, isError: checkError }),
      deploy: (onStep) => deployExecutor(declared, onStep),
      onDeployed: (a) => setLocalExecutor(declared.id, a),
    }
  }, [
    morpho,
    v4,
    declared,
    declaredMorpho,
    declaredV4,
    checkPending,
    checkError,
    morphoCheckPending,
    morphoCheckError,
    v4CheckPending,
    v4CheckError,
    setLocalExecutor,
  ])
  const [morphoSeed, setMorphoSeed] = useState<MorphoSeed>()
  function openMorpho(m: MorphoMarket, tab?: MorphoTab, leverage?: number, opts?: { amount?: string; target?: number }) {
    const net = MORPHO_NETWORKS.find((n) => n.chain.id === m.chainId)
    if (!net) return
    chooseMarket(net.id)
    setMorphoSeed({ market: m, tab, leverage, amount: opts?.amount, target: opts?.target, nonce: Date.now() })
    setView('loop')
    window.scrollTo({ top: 0 })
  }
  const [v4Seed, setV4Seed] = useState<V4Seed>()
  function openV4(p: Omit<V4Seed, 'nonce'>) {
    const net = v4NetOfSpoke(p.chainId, p.spoke)
    if (!net) return
    chooseMarket(net.id)
    setV4Seed({ ...p, nonce: Date.now() })
    setView('loop')
    window.scrollTo({ top: 0 })
  }
  const reserveTokens = useReserveTokens(market)
  // after 15 s without the asset list, say so instead of an endless "loading"
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    const t = setTimeout(() => setSlow(true), 15_000)
    return () => clearTimeout(t)
  }, [market.id])
  const tokens = reserveTokens.tokens
  const balances = useBalances(market.chain.id, other ? undefined : tokens, address)
  const [preferredAggregator, setAggregator] = useState<AggregatorChoice>('best')
  // keep the choice when it quotes on this chain, otherwise compare all those that do
  const aggregator: AggregatorChoice =
    preferredAggregator === 'best' || supportsChain(preferredAggregator, (morpho ? morphoNet : v4 ? v4Net : market).chain.id) ? preferredAggregator : 'best'
  // arrival without an address in the link: Positions when a wallet reconnects, the Scanner otherwise
  const [view, setViewState] = useState<View | undefined>(() => (DEMO ? 'loop' : viewFromHash()))
  // set while Positions was chosen for the visitor: an empty list then moves on to the Scanner
  const [arrival, setArrival] = useState(false)
  const reconnecting = useRef(false)
  useEffect(() => {
    if (view) return
    // the wallet reconnects after the first render: wait for its outcome (or 1.5 s) before choosing
    if (status === 'reconnecting' || status === 'connecting') {
      reconnecting.current = true
      return
    }
    const choose = () => {
      const v: View = status === 'connected' ? 'positions' : 'scan'
      setViewState(v)
      setArrival(v === 'positions')
      window.history.replaceState(null, '', `#${HASHES[v]}`)
    }
    if (reconnecting.current || status === 'connected') return choose()
    const t = setTimeout(choose, 1_500)
    return () => clearTimeout(t)
  }, [view, status])
  function setView(v: View) {
    setArrival(false)
    setViewState(v)
    if (viewFromHash() !== v) window.location.hash = HASHES[v]
  }
  useEffect(() => {
    const onHash = () => {
      const v = viewFromHash()
      if (v && !DEMO) {
        setArrival(false)
        setViewState(v)
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [picked, setPicked] = useState<{
    market: string
    collateral: Address
    debt: Address
    /** set when the pair comes from the scanner: eMode and leverage to start the open panel with */
    seed?: Seed & { nonce: number }
  }>()

  // a pair named in the link is picked once its network's tokens are read
  const linked = useRef<{ market: string; collateral: string; debt: string } | undefined>(
    (() => {
      const [view, id, c, d] = hashParts()
      return view === HASHES.loop && isNetworkId(id) && c && d ? { market: id, collateral: c.toLowerCase(), debt: d.toLowerCase() } : undefined
    })(),
  )
  useEffect(() => {
    const l = linked.current
    if (!l || !tokens) return
    if (l.market === market.id) {
      const bySymbol = (sym: string) => tokens.find((t) => t.symbol.toLowerCase() === sym)
      const collateral = bySymbol(l.collateral)
      const debt = bySymbol(l.debt)
      if (collateral && debt && collateral !== debt) setPicked({ market: market.id, collateral: collateral.address, debt: debt.address })
    }
    linked.current = undefined
  }, [tokens, market.id])

  // nothing picked on this network yet: the last pair opened there in this browser, else the scanner's best
  // correlated pair (positive yield, room to loop) at the scanner's target health factor, else WETH / USDC
  // read at every render: a pair just picked is saved, and must count at once
  const remembered = other ? undefined : savedPair(market.id)
  const wantBest = !other && !DEMO && view === 'loop' && !remembered && picked?.market !== market.id && !linked.current
  const bestSnapshot = useQuery({ ...snapshotQuery(market), enabled: wantBest })
  const bestCampaigns = useQuery({ ...merklQuery(market.chain.id), enabled: wantBest })
  const bests = useRef(new Map<string, ScanRow | null>())
  if (wantBest && !bests.current.has(market.id) && bestSnapshot.data?.market.id === market.id && (bestCampaigns.isFetched || bestCampaigns.isError)) {
    const rows = scanMarket(bestSnapshot.data, bestCampaigns.data, { targetHf: Number(loadScanner('').hf), minCapacityBase: BEST_MIN_CAPACITY })
    bests.current.set(market.id, bestPair(rows) ?? null)
  }
  const best = bests.current.get(market.id) ?? undefined

  const pair = useMemo(() => {
    if (!tokens || tokens.length < 2) return undefined
    const of = (c?: Token, d?: Token) => (c && d && c !== d ? { collateral: c, debt: d } : undefined)
    if (picked?.market === market.id) {
      const p = of(
        tokens.find((t) => t.address === picked.collateral),
        tokens.find((t) => t.address === picked.debt),
      )
      if (p) return p
    }
    const bySymbol = (sym: string) => tokens.find((t) => t.symbol.toLowerCase() === sym.toLowerCase())
    const saved = remembered && of(bySymbol(remembered.collateral), bySymbol(remembered.debt))
    if (saved) return saved
    const top =
      best &&
      of(
        tokens.find((t) => t.address === best.collateral.token.address),
        tokens.find((t) => t.address === best.debt.token.address),
      )
    return top ?? defaultPair(tokens)
  }, [tokens, picked, market.id, remembered, best])
  useEffect(() => {
    if (pair && picked?.market === market.id && !other) savePair(market.id, pair.collateral.symbol, pair.debt.symbol)
  }, [pair, picked, market.id, other])

  // the address follows the screen: network and pair of the Boucle, so a reload or a shared link reopens them
  useEffect(() => {
    if (view !== 'loop' || DEMO || (linked.current && !other)) return
    const parts = [HASHES.loop, marketId, ...(!other && pair ? [pair.collateral.symbol, pair.debt.symbol] : [])]
    const target = `#${parts.map(encodeURIComponent).join('/')}`
    if (window.location.hash !== target) window.history.replaceState(null, '', target)
  }, [view, marketId, other, pair])

  function chooseMarket(id: string) {
    setMarketId(id)
    try {
      localStorage.setItem(MARKET_KEY, id)
    } catch {
      // private window: the choice just isn't remembered
    }
  }
  function openPick(p: Pick) {
    chooseMarket(p.marketId)
    setPicked({
      market: p.marketId,
      collateral: p.collateral,
      debt: p.debt,
      seed: { emode: p.emode, leverage: p.leverage, tab: p.tab, amount: p.amount, nonce: Date.now() },
    })
    setView('loop')
    window.scrollTo({ top: 0 })
  }
  const seed =
    pair && picked?.market === market.id && picked.collateral === pair.collateral.address && picked.debt === pair.debt.address
      ? picked.seed
      : pair &&
          best &&
          !remembered &&
          picked?.market !== market.id &&
          best.collateral.token.address === pair.collateral.address &&
          best.debt.token.address === pair.debt.address
        ? { emode: best.emode?.id ?? 0, leverage: best.leverage, nonce: 0 }
        : undefined
  const setPair = (collateral: Token, debt: Token, seed?: Seed) =>
    setPicked({
      market: market.id,
      collateral: collateral.address,
      debt: debt.address,
      seed: seed && { ...seed, nonce: Date.now() },
    })

  // protocol and network are chosen apart; a network with several Aave markets (Ethereum Core / Prime) adds a third choice
  const protocol: Protocol = morpho ? 'morpho' : v4 ? 'v4' : 'aave'
  const placeChain = (morpho ? morphoNet : v4 ? v4Net : market).chain.id
  const places = PLACES[protocol]
  const instances = morpho ? [] : v4 ? V4_NETWORKS.filter((n) => n.chain.id === placeChain) : AAVE_MARKETS.filter((m) => m.chain.id === placeChain)
  const choosePlace = (p: Protocol, chainId: number) => chooseMarket((PLACES[p].find((x) => x.chainId === chainId) ?? PLACES[p][0]).id)
  const placeSelect = (
    <div className="place-row">
      <div className="field">
        <span>Protocole</span>
        <Segmented
          value={protocol}
          onChange={(p) => choosePlace(p, placeChain)}
          options={[
            { value: 'aave' as Protocol, label: 'Aave v3' },
            { value: 'v4' as Protocol, label: 'Aave v4' },
            { value: 'morpho' as Protocol, label: 'Morpho Blue' },
          ]}
        />
      </div>
      <Picker
        label="Réseau"
        value={String(placeChain)}
        onChange={(v) => choosePlace(protocol, Number(v))}
        options={places.map((x) => ({ value: String(x.chainId), label: x.label, icon: <Logo name={x.label} /> }))}
      />
      {instances.length > 1 && (
        <div className="field">
          <span>Marché</span>
          <Segmented value={marketId} onChange={chooseMarket} options={instances.map((m) => ({ value: m.id, label: marketInstance(m.label) ?? m.label }))} />
        </div>
      )}
    </div>
  )
  const selectors = (
    <>
      {placeSelect}
      <div className="market-row">
        {tokens && pair ? (
          <div className="pair">
            <TokenSelect
              tokens={tokens}
              label="Collatéral"
              value={pair.collateral}
              onChange={(t) => setPair(t, pair.debt)}
              exclude={pair.debt}
              balances={balances}
            />
            <button
              className="btn swap"
              title="Inverser collatéral et dette"
              aria-label="Inverser collatéral et dette"
              onClick={() => setPair(pair.debt, pair.collateral)}
            >
              ⇄
            </button>
            <TokenSelect
              tokens={tokens}
              label="Dette"
              value={pair.debt}
              onChange={(t) => setPair(pair.collateral, t)}
              exclude={pair.collateral}
              balances={balances}
            />
          </div>
        ) : (
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <span>Paire</span>
            <Skel w={12} />
          </div>
        )}
      </div>
    </>
  )

  // settings shared by both panels, shown in their collapsed "Réglages" block
  const common = (
    <>
      <AggregatorPicker chainId={market.chain.id} value={aggregator} onChange={setAggregator} />
      <PrivateRpc chainId={market.chain.id} />
      <p className="muted small">
        Plateforme : {market.fork ? `${market.fork}Lend, fork d’Aave v3` : 'Aave v3'}.{' '}
        {market.executor && (
          <>
            Contrat Auto-loop vérifié :{' '}
            <a href={`${market.chain.blockExplorers?.default.url}/address/${market.executor}`} target="_blank" rel="noreferrer" title={market.executor}>
              <span className="addr">{fmtAddress(market.executor)}</span>
            </a>
            {market.executorVersion === 1 && ' (v1)'}
            {isShared(market) ? ' (contrat commun, même adresse pour tous)' : market.executorSource === 'wallet' && ' (ajouté depuis ce navigateur)'}.
          </>
        )}
      </p>
    </>
  )

  const notes = (
    <>
      {DEMO && <p className="muted small">Mode démo : prix et paramètres de marché fictifs, rien n’est lu on-chain.</p>}
      {QUOTE_MODE === 'mock' && <p className="muted small">Cotations simulées au prix de l’oracle (VITE_QUOTE_MODE=mock).</p>}
      {!DEMO && declared.executor && check.isPending && <p className="muted small">Vérification du contrat Auto-loop sur {market.label}…</p>}
      {!DEMO && declared.executor && check.isError && (
        <Notice tone="bad">
          <span>
            Contrat <span className="addr">{fmtAddress(declared.executor)}</span> refusé : {check.error.message}. Aucune transaction ne sera proposée avec lui.
          </span>
          {declared.executorSource === 'wallet' && (
            <button className="btn" onClick={() => setLocalExecutor(market.id)}>
              Oublier cette adresse
            </button>
          )}
        </Notice>
      )}
      {!DEMO && !declared.executor && <DeployPanel market={market} onReady={(a) => setLocalExecutor(market.id, a)} />}
      {!DEMO && market.executorVersion === 1 && market.executorSource === 'wallet' && (
        <DeployPanel market={market} upgrade shared={sharedAave.data ?? undefined} onReady={(a) => setLocalExecutor(market.id, a)} />
      )}
    </>
  )

  const morphoCommon = (
    <>
      <AggregatorPicker chainId={morphoNet.chain.id} value={aggregator} onChange={setAggregator} />
      <PrivateRpc chainId={morphoNet.chain.id} />
      <p className="muted small">
        Plateforme : Morpho Blue.{' '}
        {morphoNet.executor && (
          <>
            Contrat Auto-loop vérifié :{' '}
            <a
              href={`${morphoNet.chain.blockExplorers?.default.url}/address/${morphoNet.executor}`}
              target="_blank"
              rel="noreferrer"
              title={morphoNet.executor}
            >
              <span className="addr">{fmtAddress(morphoNet.executor)}</span>
            </a>
            {isSharedMorpho ? ' (contrat commun, même adresse pour tous)' : morphoNet.executorSource === 'wallet' && ' (ajouté depuis ce navigateur)'}.
          </>
        )}
      </p>
    </>
  )
  const v4Common = (
    <>
      <AggregatorPicker chainId={v4Net.chain.id} value={aggregator} onChange={setAggregator} />
      <PrivateRpc chainId={v4Net.chain.id} />
      <p className="muted small">
        Plateforme : Aave v4.{' '}
        {v4Net.executor && (
          <>
            Contrat Auto-loop vérifié :{' '}
            <a href={`${v4Net.chain.blockExplorers?.default.url}/address/${v4Net.executor}`} target="_blank" rel="noreferrer" title={v4Net.executor}>
              <span className="addr">{fmtAddress(v4Net.executor)}</span>
            </a>
            {isSharedV4 ? ' (contrat commun, même adresse pour tous)' : v4Net.executorSource === 'wallet' && ' (ajouté depuis ce navigateur)'}.
          </>
        )}
      </p>
    </>
  )
  const v4Notes = (
    <>
      {QUOTE_MODE === 'mock' && <p className="muted small">Cotations simulées au prix de l’oracle (VITE_QUOTE_MODE=mock).</p>}
      {declaredV4.executor && v4Check.isPending && <p className="muted small">Vérification du contrat Auto-loop sur {declaredV4.label}…</p>}
      {declaredV4.executor && v4Check.isError && (
        <Notice tone="bad">
          <span>
            Contrat <span className="addr">{fmtAddress(declaredV4.executor)}</span> refusé : {v4Check.error.message}. Aucune transaction ne sera proposée avec
            lui.
          </span>
          {declaredV4.executorSource === 'wallet' && (
            <button className="btn" onClick={() => setLocalExecutor(declaredV4.id)}>
              Oublier cette adresse
            </button>
          )}
        </Notice>
      )}
    </>
  )
  const morphoNotes = (
    <>
      {QUOTE_MODE === 'mock' && <p className="muted small">Cotations simulées au prix de l’oracle (VITE_QUOTE_MODE=mock).</p>}
      {declaredMorpho.executor && morphoCheck.isPending && <p className="muted small">Vérification du contrat Auto-loop sur {declaredMorpho.label}…</p>}
      {declaredMorpho.executor && morphoCheck.isError && (
        <Notice tone="bad">
          <span>
            Contrat <span className="addr">{fmtAddress(declaredMorpho.executor)}</span> refusé : {morphoCheck.error.message}. Aucune transaction ne sera
            proposée avec lui.
          </span>
          {declaredMorpho.executorSource === 'wallet' && (
            <button className="btn" onClick={() => setLocalExecutor(declaredMorpho.id)}>
              Oublier cette adresse
            </button>
          )}
        </Notice>
      )}
    </>
  )

  return (
    <div className="page">
      <header className="top">
        <h1>
          <img className="app-icon" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          Auto-loop
        </h1>
        <WalletButton market={morpho ? morphoNet : v4 ? v4Net : market} />
      </header>
      <nav className="nav">
        {(
          [
            ['loop', 'Boucle'],
            ['scan', 'Scanner'],
            ['positions', 'Positions'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </nav>

      {view === 'scan' && !DEMO && <Scanner onPick={openPick} onPickMorpho={openMorpho} onPickV4={openV4} />}
      {view === 'positions' && !DEMO && (
        <Positions
          account={address}
          onManage={openPick}
          onManageMorpho={openMorpho}
          onManageV4={openV4}
          onScan={() => setView('scan')}
          onEmpty={
            arrival
              ? () => {
                  setArrival(false)
                  setViewState('scan')
                  window.history.replaceState(null, '', `#${HASHES.scan}`)
                }
              : undefined
          }
        />
      )}
      <GateProvider value={gate}>
        {view === 'loop' && morpho && !DEMO && (
          <MorphoView
            key={morphoNet.id}
            net={morphoNet}
            networkSelect={placeSelect}
            account={address}
            aggregator={aggregator}
            common={morphoCommon}
            notes={morphoNotes}
            seed={morphoSeed?.market.chainId === morphoNet.chain.id ? morphoSeed : undefined}
            onExecutor={(a) => setLocalExecutor(morphoNet.id, a)}
          />
        )}
        {view === 'loop' && v4 && !DEMO && (
          <V4View
            key={v4Net.id}
            net={v4Net}
            networkSelect={placeSelect}
            account={address}
            aggregator={aggregator}
            common={v4Common}
            notes={v4Notes}
            seed={v4Seed && v4NetOfSpoke(v4Seed.chainId, v4Seed.spoke)?.id === v4Net.id ? v4Seed : undefined}
            onExecutor={(a) => setLocalExecutor(v4Net.id, a)}
          />
        )}
        {view === 'loop' &&
          !other &&
          (pair ? (
            <AaveView
              key={`${market.id}-${seed?.nonce ?? ''}`}
              market={market}
              collateral={pair.collateral}
              debt={pair.debt}
              nativeToken={wrappedNative(tokens, market.chain)?.address}
              tokens={tokens}
              onPair={setPair}
              account={address}
              aggregator={aggregator}
              selectors={selectors}
              common={common}
              notes={notes}
              seed={seed}
              onExecutor={(a) => setLocalExecutor(market.id, a)}
            />
          ) : (
            <LoopLayout
              summary={
                <Summary
                  items={[
                    { label: 'Health factor', key: true },
                    { label: 'APY net', key: true },
                  ]}
                  action={
                    <button className="btn primary" disabled>
                      Ouvrir la position
                    </button>
                  }
                />
              }
            >
              {notes}
              <Card title="Marché">
                {selectors}
                {reserveTokens.error ? (
                  <Notice>
                    <span>
                      Lecture d’Aave sur {market.label} impossible : {reserveTokens.error.message.split('\n')[0]} Le RPC public du réseau ne répond pas ou est
                      bloqué.
                    </span>
                    <button className="btn" onClick={reserveTokens.refetch}>
                      Réessayer
                    </button>
                  </Notice>
                ) : (
                  slow && (
                    <Notice>
                      <span>Le RPC public de {market.label} répond lentement.</span>
                      <button className="btn" onClick={reserveTokens.refetch}>
                        Réessayer
                      </button>
                    </Notice>
                  )
                )}
              </Card>
            </LoopLayout>
          ))}
      </GateProvider>

      <footer className="muted small">
        Contrat non audité. Vérifier chaque transaction dans le portefeuille ; le contrat n’agit que pour l’adresse qui signe.
      </footer>
    </div>
  )
}
