import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { formatUnits, type Address } from 'viem'
import {
  DEFAULT_COLLATERAL_SYMBOLS,
  DEFAULT_DEBT_SYMBOLS,
  DEFAULT_MARKET_ID,
  DEMO,
  MARKETS,
  MORPHO_NETWORKS,
  QUOTE_MODE,
  getMarket,
  getMorphoNet,
  isMorphoId,
  savedExecutors,
  storeExecutors,
  executorRouters,
  supportsChain,
  wrappedNative,
  type AggregatorChoice,
  type Market,
  type Token,
} from './config'
import { eligibleEModes, useEModeCategories, useMarket, useReserveTokens, withEMode, withIncentives } from './lib/useMarket'
import { useCampaigns } from './lib/merkl'
import { fmtAddress, fmtDate, fmtPct, fmtPrice } from './lib/format'
import { WINDOWS, useRateAverages, type Window } from './lib/rateHistory'
import { useClaimables } from './lib/reinvest'
import { ReinvestPanel } from './components/ReinvestPanel'
import { AggregatorPicker, Card, Fold, LoopLayout, Notice, Segmented, Skel, Summary } from './components/ui'
import { OpenPanel } from './components/OpenPanel'
import { ClosePanel } from './components/ClosePanel'
import { SwapCollateralPanel } from './components/SwapCollateralPanel'
import { DeployPanel } from './components/DeployPanel'
import { deployExecutor, deployMorphoExecutor, useExecutorCheck, useMorphoExecutorCheck } from './lib/deploy'
import { GateProvider, type Gate } from './components/gate'
import { MorphoView, type MorphoSeed, type MorphoTab } from './components/MorphoView'
import type { MorphoMarket } from './lib/morpho'
import { Scanner, type Pick } from './components/Scanner'
import { needsRenewal } from './lib/pendle'
import { toBase } from './lib/math'
import { Positions } from './components/Positions'

type View = 'loop' | 'scan' | 'positions'
/** each screen has its own address, so a link or a reload lands on it */
const HASHES: Record<View, string> = { loop: 'boucle', scan: 'scanner', positions: 'positions' }
function viewFromHash(): View | undefined {
  const h = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]
  return (Object.keys(HASHES) as View[]).find((v) => HASHES[v] === h)
}
/** How the Boucle screen opens a pair: eMode and leverage, the tab, and for « Ouvrir » a capital amount and token. */
type Seed = { emode: number; leverage: number; tab?: Pick['tab']; amount?: string; capital?: Address }

function WalletButton({ market }: { market: { chain: Market['chain'] } }) {
  const { address, chainId, chain, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const menu = useRef<HTMLDetailsElement>(null)
  const [copied, setCopied] = useState(false)
  // the menu closes on a click elsewhere or Escape, like any dropdown
  useEffect(() => {
    const close = (e: Event) => {
      const d = menu.current
      if (d?.open && (e.type === 'keydown' ? (e as KeyboardEvent).key === 'Escape' : !d.contains(e.target as Node))) d.open = false
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [])

  if (!isConnected) {
    const injected = connectors[0]
    return (
      <button className="btn" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
        {isPending ? 'Connexion…' : 'Connecter le portefeuille'}
      </button>
    )
  }
  const wrong = chainId !== market.chain.id
  const explorer = (chain ?? market.chain).blockExplorers?.default.url
  const pick = (run: () => void) => () => {
    run()
    if (menu.current) menu.current.open = false
  }
  return (
    <details className="wallet-menu" ref={menu}>
      <summary className="btn">
        <span className={wrong ? 'warn-text' : 'muted'}>{chain?.name ?? 'Réseau inconnu'}</span>
        <span className="addr">{fmtAddress(address!)}</span>
      </summary>
      <div className="menu" role="menu">
        {wrong && (
          <button role="menuitem" onClick={pick(() => switchChain({ chainId: market.chain.id }))}>
            Passer sur {market.chain.name}
          </button>
        )}
        <button
          role="menuitem"
          onClick={() => {
            void navigator.clipboard?.writeText(address!).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1_500)
            })
          }}
        >
          {copied ? 'Adresse copiée' : 'Copier l’adresse'}
        </button>
        {explorer && (
          <a role="menuitem" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" onClick={pick(() => {})}>
            Voir sur l’explorateur
          </a>
        )}
        <button role="menuitem" onClick={pick(() => disconnect())}>
          Déconnecter
        </button>
      </div>
    </details>
  )
}

type TokenSelectProps = {
  tokens: Token[]
  value: Token
  onChange: (t: Token) => void
  exclude: Token
  label: string
}

function TokenSelect({ tokens, value, onChange, exclude, label }: TokenSelectProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value.address} onChange={(e) => onChange(tokens.find((t) => t.address === e.target.value)!)}>
        {tokens.map((t) => (
          <option key={t.address} value={t.address} disabled={t.address === exclude.address}>
            {t.symbol}
          </option>
        ))}
      </select>
    </label>
  )
}

const MARKET_KEY = 'auto-loop.market'

function savedMarketId(): string {
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
          ? { ...declared, executorVersion: check.data.version, executorPendle: check.data.pendle }
          : { ...declared, executor: undefined },
    [declared, check.data],
  )
  function setLocalExecutor(id: string, a?: Address) {
    const next = { ...localExecutors }
    if (a) next[id] = a
    else delete next[id]
    setLocalExecutors(next)
    storeExecutors(next)
  }
  // Morpho Blue: a network of the selector whose id starts with morpho-; the executor is checked the same way
  const morpho = isMorphoId(marketId)
  const declaredMorpho = useMemo(() => getMorphoNet(marketId, localExecutors), [marketId, localExecutors])
  const morphoCheck = useMorphoExecutorCheck(morpho ? declaredMorpho : { ...declaredMorpho, executor: undefined })
  const morphoNet = useMemo(() => (morphoCheck.data ? declaredMorpho : { ...declaredMorpho, executor: undefined }), [declaredMorpho, morphoCheck.data])
  // what the summary's single button walks through before the screen's own action (charte v2, rule 2)
  const gate = useMemo<Gate | undefined>(() => {
    if (DEMO) return undefined
    const statusOf = (executor: Address | undefined, c: { isPending: boolean; isError: boolean }): Gate['executor'] =>
      !executor ? 'missing' : c.isError ? 'refused' : c.isPending ? 'checking' : 'ok'
    if (morpho)
      return {
        chain: declaredMorpho.chain,
        label: declaredMorpho.label,
        executor: executorRouters(declaredMorpho.chain.id).length === 0 ? 'none' : statusOf(declaredMorpho.executor, morphoCheck),
        deploy: (onStep) => deployMorphoExecutor(declaredMorpho, onStep),
        onDeployed: (a) => setLocalExecutor(declaredMorpho.id, a),
      }
    return {
      chain: declared.chain,
      label: declared.label,
      executor: executorRouters(declared.chain.id).length === 0 ? 'none' : statusOf(declared.executor, check),
      deploy: (onStep) => deployExecutor(declared, onStep),
      onDeployed: (a) => setLocalExecutor(declared.id, a),
    }
  }, [morpho, declared, declaredMorpho, check.isPending, check.isError, morphoCheck.isPending, morphoCheck.isError, localExecutors])
  const [morphoSeed, setMorphoSeed] = useState<MorphoSeed>()
  function openMorpho(m: MorphoMarket, tab?: MorphoTab, leverage?: number) {
    const net = MORPHO_NETWORKS.find((n) => n.chain.id === m.chainId)
    if (!net) return
    chooseMarket(net.id)
    setMorphoSeed({ market: m, tab, leverage, nonce: Date.now() })
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
  const [preferredAggregator, setAggregator] = useState<AggregatorChoice>('best')
  // keep the choice when it quotes on this chain, otherwise compare all those that do
  const aggregator: AggregatorChoice =
    preferredAggregator === 'best' || supportsChain(preferredAggregator, (morpho ? morphoNet : market).chain.id) ? preferredAggregator : 'best'
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

  const pair = useMemo(() => {
    if (!tokens || tokens.length < 2) return undefined
    if (picked?.market === market.id) {
      const collateral = tokens.find((t) => t.address === picked.collateral)
      const debt = tokens.find((t) => t.address === picked.debt)
      if (collateral && debt) return { collateral, debt }
    }
    return defaultPair(tokens)
  }, [tokens, picked, market.id])

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
    setPicked({ market: p.marketId, collateral: p.collateral, debt: p.debt, seed: { emode: p.emode, leverage: p.leverage, tab: p.tab, nonce: Date.now() } })
    setView('loop')
    window.scrollTo({ top: 0 })
  }
  const seed =
    pair && picked?.market === market.id && picked.collateral === pair.collateral.address && picked.debt === pair.debt.address ? picked.seed : undefined
  const setPair = (collateral: Token, debt: Token, seed?: Seed) =>
    setPicked({
      market: market.id,
      collateral: collateral.address,
      debt: debt.address,
      seed: seed && { ...seed, nonce: Date.now() },
    })

  const networkSelect = (
    <label className="field">
      <span>Réseau</span>
      <select value={morpho ? morphoNet.id : market.id} onChange={(e) => chooseMarket(e.target.value)}>
        <optgroup label="Aave v3">
          {MARKETS.filter((m) => !m.soon).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Morpho Blue">
          {MORPHO_NETWORKS.map((n) => (
            <option key={n.id} value={n.id}>
              Morpho · {n.label}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  )
  const selectors = (
    <div className="market-row">
      {networkSelect}
      {tokens && pair ? (
        <div className="pair">
          <TokenSelect tokens={tokens} label="Collatéral" value={pair.collateral} onChange={(t) => setPair(t, pair.debt)} exclude={pair.debt} />
          <button
            className="btn swap"
            title="Inverser collatéral et dette"
            aria-label="Inverser collatéral et dette"
            onClick={() => setPair(pair.debt, pair.collateral)}
          >
            ⇄
          </button>
          <TokenSelect tokens={tokens} label="Dette" value={pair.debt} onChange={(t) => setPair(pair.collateral, t)} exclude={pair.collateral} />
        </div>
      ) : (
        <div className="field" style={{ gridColumn: 'span 3' }}>
          <span>Paire</span>
          <Skel w={12} />
        </div>
      )}
    </div>
  )

  // settings shared by both panels, shown in their collapsed "Réglages" block
  const common = (
    <>
      <AggregatorPicker chainId={market.chain.id} value={aggregator} onChange={setAggregator} />
      <p className="muted small">
        Plateforme : Aave v3.{' '}
        {market.executor && (
          <>
            Contrat Auto-loop vérifié :{' '}
            <a href={`${market.chain.blockExplorers?.default.url}/address/${market.executor}`} target="_blank" rel="noreferrer" title={market.executor}>
              {fmtAddress(market.executor)}
            </a>
            {market.executorVersion === 1 && ' (v1)'}
            {market.executorSource === 'wallet' && ' (ajouté depuis ce navigateur)'}.
          </>
        )}
      </p>
    </>
  )

  const notes = (
    <>
      {DEMO && <p className="muted small">Mode démo : prix et paramètres de marché fictifs, rien n’est lu sur la chaîne.</p>}
      {QUOTE_MODE === 'mock' && <p className="muted small">Cotations simulées au prix de l’oracle (VITE_QUOTE_MODE=mock).</p>}
      {!DEMO && declared.executor && check.isPending && <p className="muted small">Vérification du contrat Auto-loop sur {market.label}…</p>}
      {!DEMO && declared.executor && check.isError && (
        <Notice tone="bad">
          <span>
            Contrat {fmtAddress(declared.executor)} refusé : {check.error.message}. Aucune transaction ne sera proposée avec lui.
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
        <DeployPanel market={market} upgrade onReady={(a) => setLocalExecutor(market.id, a)} />
      )}
    </>
  )

  const morphoCommon = (
    <>
      <AggregatorPicker chainId={morphoNet.chain.id} value={aggregator} onChange={setAggregator} />
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
              {fmtAddress(morphoNet.executor)}
            </a>
            {morphoNet.executorSource === 'wallet' && ' (ajouté depuis ce navigateur)'}.
          </>
        )}
      </p>
    </>
  )
  const morphoNotes = (
    <>
      {QUOTE_MODE === 'mock' && <p className="muted small">Cotations simulées au prix de l’oracle (VITE_QUOTE_MODE=mock).</p>}
      {declaredMorpho.executor && morphoCheck.isPending && <p className="muted small">Vérification du contrat Auto-loop sur {declaredMorpho.label}…</p>}
      {declaredMorpho.executor && morphoCheck.isError && (
        <Notice tone="bad">
          <span>
            Contrat {fmtAddress(declaredMorpho.executor)} refusé : {morphoCheck.error.message}. Aucune transaction ne sera proposée avec lui.
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
        <h1>Auto-loop</h1>
        <WalletButton market={morpho ? morphoNet : market} />
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

      {view === 'scan' && !DEMO && <Scanner onPick={openPick} onPickMorpho={openMorpho} />}
      {view === 'positions' && !DEMO && (
        <Positions
          account={address}
          onManage={openPick}
          onManageMorpho={openMorpho}
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
            networkSelect={networkSelect}
            account={address}
            aggregator={aggregator}
            common={morphoCommon}
            notes={morphoNotes}
            seed={morphoSeed?.market.chainId === morphoNet.chain.id ? morphoSeed : undefined}
            onExecutor={(a) => setLocalExecutor(morphoNet.id, a)}
          />
        )}
        {view === 'loop' &&
          !morpho &&
          (pair ? (
            <PairView
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

type PairViewProps = {
  market: Market
  collateral: Token
  debt: Token
  nativeToken?: Address
  /** the market's tokens */
  tokens?: Token[]
  /** shows another pair of the market */
  onPair: (collateral: Token, debt: Token, seed?: Seed) => void
  account?: Address
  aggregator: AggregatorChoice
  selectors: ReactNode
  common: ReactNode
  notes: ReactNode
  seed?: Seed
  /** keeps a newly deployed executor for this market */
  onExecutor: (a: Address) => void
}

function PairView({
  market: m,
  collateral,
  debt,
  nativeToken,
  tokens,
  onPair,
  account,
  aggregator,
  selectors,
  common,
  notes,
  seed,
  onExecutor,
}: PairViewProps) {
  const [tab, setTab] = useState<'open' | 'close' | 'swap' | 'reinvest' | 'renew'>(seed?.tab ?? 'open')
  // filled by the reinvest flow's last step: "Augmenter" with the capital it gained
  const [augment, setAugment] = useState<{ emode: number; leverage: number; amount: string; capital?: Address }>()
  // a PT roll in two steps: after the close, open this PT with the collateral given back
  const [roll, setRoll] = useState<{ to: Token; leverage: number; emode: number }>()
  const market = useMarket(m, collateral, debt, account, nativeToken)
  const emodes = useEModeCategories(m)
  const incentives = useCampaigns(m)
  const r = market.reserves && withIncentives(market.reserves, incentives.data)
  // closing works inside the account's current eMode, if it applies to the pair
  const currentEMode = r && market.user ? eligibleEModes(emodes, r.collateral, r.debt).find((c) => c.id === market.user!.eModeCategory) : undefined

  const { claimables } = useClaimables(m.chain.id, account)
  const canReinvest = !!account && (claimables.length > 0 || tab === 'reinvest')
  // contract v2: the collateral of an existing position can be changed without closing it
  const canSwap = !!account && m.executorVersion === 2 && !!market.user && market.user.aTokenBalance > 0n
  // a PT in its last month (or matured) can be rolled into a later one, without closing
  const pt = r?.collateral.pt
  const canRenew = canSwap && !!pt && needsRenewal(pt)
  const averages = useRateAverages(m.chain.id, m.pool, [collateral.address, debt.address])
  const natives = r ? [r.collateral.native, r.debt.native].filter((n): n is NonNullable<typeof n> => n !== undefined && !n.fixedUntil) : []
  const nativeSince = natives.length ? Math.min(...natives.map((n) => n.since)) : undefined

  const head = (
    <>
      {notes}
      {!DEMO && (pt || r?.debt.pt) && m.executorVersion === 2 && !m.executorPendle && m.executorSource === 'wallet' && (
        <DeployPanel market={m} upgrade="pendle" onReady={onExecutor} />
      )}
      <Card title="Marché">
        {selectors}
        {market.error && <Notice>Lecture d’Aave impossible : {market.error.message.split('\n')[0]}</Notice>}
        {r === null && <Notice tone="bad">Cette paire n’est pas listée sur Aave v3 {m.label}.</Notice>}
        {r && (
          <Fold
            title="Taux Aave"
            value={`${r.collateral.token.symbol} dépôt ${fmtPct(r.collateral.supplyApy)} · ${r.debt.token.symbol} emprunt ${fmtPct(r.debt.borrowApy)}`}
          >
            <table className="reserves cards">
              <thead>
                <tr>
                  <th>Actif</th>
                  <th>Prix oracle</th>
                  <th>LTV / seuil liq.</th>
                  <th>APY dépôt</th>
                  <th>APY emprunt</th>
                </tr>
              </thead>
              <tbody>
                {[r.collateral, r.debt].map((x) => (
                  <tr key={x.token.address}>
                    <td className="lead">{x.token.symbol}</td>
                    <td data-label="Prix oracle">{fmtPrice(x.price)}</td>
                    <td data-label="LTV / seuil liq.">
                      {fmtPct(x.config.ltvBps / 10_000, 0)} / {fmtPct(x.config.liquidationThresholdBps / 10_000, 0)}
                    </td>
                    <td data-label="APY dépôt">
                      <div>
                        {fmtPct(x.supplyApy)}
                        {x.native && (
                          <span className="muted">
                            {' '}
                            + {fmtPct(x.native.apy)} {x.native.fixedUntil ? 'fixe' : 'token'}
                          </span>
                        )}
                        {x.supplyRewardApr > 0 && <span className="reward"> + {fmtPct(x.supplyRewardApr)} Merkl</span>}
                        <Averages values={averages.data?.get(x.token.address.toLowerCase())?.supply} pending={averages.isPending} />
                      </div>
                    </td>
                    <td data-label="APY emprunt">
                      <div>
                        {fmtPct(x.borrowApy)}
                        {x.native && (
                          <span className="muted">
                            {' '}
                            + {fmtPct(x.native.apy)} {x.native.fixedUntil ? 'fixe' : 'token'}
                          </span>
                        )}
                        {x.borrowRewardApr > 0 && <span className="reward"> − {fmtPct(x.borrowRewardApr)} Merkl</span>}
                        <Averages values={averages.data?.get(x.token.address.toLowerCase())?.borrow} pending={averages.isPending} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">Moyennes 7 j et 30 j : hausse des index Aave sur la période, annualisée.</p>
            {pt?.market && (
              <p className="muted small">
                « fixe » : APY implicite du marché Pendle de {r.collateral.token.symbol}, acquis jusqu’à l’échéance du {fmtDate(pt.expiry)}.
              </p>
            )}
            {nativeSince !== undefined && (
              <p className="muted small">« token » : rendement propre du token, hausse de son taux de change depuis le {fmtDate(nativeSince)}, annualisée.</p>
            )}
            {incentives.isError && <p className="muted small">Merkl indisponible : APY sans bonus.</p>}
          </Fold>
        )}
      </Card>
      <div className="tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'open', label: 'Ouvrir / augmenter' },
            { value: 'close', label: 'Fermer / réduire' },
            ...(canSwap || tab === 'swap' ? [{ value: 'swap' as const, label: 'Changer de collatéral' }] : []),
            ...(canRenew || tab === 'renew' ? [{ value: 'renew' as const, label: 'Renouveler' }] : []),
            ...(canReinvest ? [{ value: 'reinvest' as const, label: 'Réinvestir' }] : []),
          ]}
        />
      </div>
    </>
  )

  if (!r)
    return (
      <LoopLayout
        summary={
          <Summary
            items={[{ label: 'Health factor', key: true }, { label: 'Prix de liquidation' }, { label: 'APY net', key: true }, { label: 'Coût total' }]}
            action={
              <button className="btn primary" disabled>
                Ouvrir la position
              </button>
            }
          />
        }
      >
        {head}
      </LoopLayout>
    )
  if (tab === 'reinvest')
    return (
      <ReinvestPanel
        reserves={r}
        emode={currentEMode}
        onDone={market.refetchUser}
        user={market.user}
        account={account}
        aggregator={aggregator}
        common={common}
        head={head}
        onAugment={(capital, leverage) => {
          setAugment({
            emode: market.user?.eModeCategory ?? 0,
            leverage: leverage ?? 2,
            amount: formatUnits(capital, r.collateral.token.decimals),
          })
          // the wallet now holds the collateral the flow brought: read its balance again before the "Augmenter" checks
          void market.refetchUser()
          setTab('open')
          window.scrollTo({ top: 0 })
        }}
      />
    )
  if ((tab === 'swap' || tab === 'renew') && account && market.user)
    return (
      <SwapCollateralPanel
        key={tab}
        renew={tab === 'renew'}
        onClose={() => setTab('close')}
        onTwoStep={(to, leverage) => {
          setRoll({ to, leverage, emode: market.user?.eModeCategory ?? 0 })
          setTab('close')
          window.scrollTo({ top: 0 })
        }}
        reserves={withEMode(r, currentEMode)}
        emode={market.user.eModeCategory ? emodes.find((c) => c.id === market.user!.eModeCategory) : undefined}
        tokens={tokens}
        campaigns={incentives.data}
        user={market.user}
        account={account}
        aggregator={aggregator}
        common={common}
        head={head}
        onDone={market.refetchUser}
        onShowPair={(c) => {
          setTab('close')
          onPair(c, debt)
        }}
      />
    )
  return tab === 'open' || tab === 'swap' || tab === 'renew' ? (
    <OpenPanel
      reserves={r}
      tokens={tokens}
      emodes={emodes}
      seed={augment ?? seed}
      user={market.user}
      account={account}
      aggregator={aggregator}
      common={common}
      head={head}
      onDone={market.refetchUser}
    />
  ) : (
    <ClosePanel
      reserves={withEMode(r, currentEMode)}
      then={
        roll && {
          label: `Ouvrir ${roll.to.symbol} au même levier`,
          // a new pair: the view starts again on « Ouvrir », with the old PT given back as capital
          run: (back) => {
            // the old PT given back is the capital, or the debt asset when the close redeemed it all (matured PT)
            const inPt = toBase(back.collateral, r.collateral.side) >= toBase(back.debt, r.debt.side)
            onPair(roll.to, debt, {
              emode: roll.emode,
              leverage: roll.leverage,
              amount: inPt ? formatUnits(back.collateral, collateral.decimals) : formatUnits(back.debt, debt.decimals),
              capital: inPt ? collateral.address : debt.address,
            })
            window.scrollTo({ top: 0 })
          },
        }
      }
      user={market.user}
      account={account}
      aggregator={aggregator}
      common={common}
      head={head}
      onDone={market.refetchUser}
    />
  )
}

/** Second line of a rate cell: its 7- and 30-day averages, a skeleton while they are read, nothing if unreadable. */
function Averages({ values, pending }: { values?: Partial<Record<Window, number>>; pending: boolean }) {
  if (pending)
    return (
      <div>
        <Skel w={8} />
      </div>
    )
  if (!values || WINDOWS.every((w) => values[w] === undefined)) return null
  return <div className="muted small">{WINDOWS.map((w) => `${w} j ${values[w] !== undefined ? fmtPct(values[w]!) : '—'}`).join(' · ')}</div>
}
