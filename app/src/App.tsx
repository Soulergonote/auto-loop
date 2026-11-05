import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import type { Address } from 'viem'
import {
  DEFAULT_COLLATERAL_SYMBOLS,
  DEFAULT_DEBT_SYMBOLS,
  DEFAULT_MARKET_ID,
  DEMO,
  MARKETS,
  QUOTE_MODE,
  getMarket,
  savedExecutors,
  storeExecutors,
  supportsChain,
  wrappedNative,
  type AggregatorChoice,
  type Market,
  type Token,
} from './config'
import { eligibleEModes, useEModeCategories, useMarket, useReserveTokens, withEMode, withIncentives } from './lib/useMarket'
import { useCampaigns } from './lib/merkl'
import { fmtAddress, fmtDate, fmtPct, fmtPrice } from './lib/format'
import { AggregatorPicker, Card, Fold, LoopLayout, Notice, Segmented, Skel, Summary } from './components/ui'
import { OpenPanel } from './components/OpenPanel'
import { ClosePanel } from './components/ClosePanel'
import { DeployPanel } from './components/DeployPanel'
import { useExecutorCheck } from './lib/deploy'
import { Scanner, type Pick } from './components/Scanner'
import { Positions } from './components/Positions'

type View = 'loop' | 'scan' | 'positions'

function WalletButton({ market }: { market: Market }) {
  const { address, chainId, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()

  if (!isConnected) {
    const injected = connectors[0]
    return (
      <button className="btn" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
        {isPending ? 'Connexion…' : 'Connecter le portefeuille'}
      </button>
    )
  }
  if (chainId !== market.chain.id) {
    return (
      <button className="btn" onClick={() => switchChain({ chainId: market.chain.id })}>
        Passer sur {market.chain.name}
      </button>
    )
  }
  return (
    <button className="btn" onClick={() => disconnect()} title="Déconnecter">
      {fmtAddress(address!)}
    </button>
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
  const { address } = useAccount()
  const [marketId, setMarketId] = useState(savedMarketId)
  const [localExecutors, setLocalExecutors] = useState(savedExecutors)
  const declared = useMemo(() => getMarket(marketId, localExecutors), [marketId, localExecutors])
  // an executor is only offered for signing once its on-chain code is checked to be exactly this contract
  const check = useExecutorCheck(declared)
  const market = useMemo(() => (declared.executor && check.data !== true ? { ...declared, executor: undefined } : declared), [declared, check.data])
  function setLocalExecutor(id: string, a?: Address) {
    const next = { ...localExecutors }
    if (a) next[id] = a
    else delete next[id]
    setLocalExecutors(next)
    storeExecutors(next)
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
  const aggregator: AggregatorChoice = preferredAggregator === 'best' || supportsChain(preferredAggregator, market.chain.id) ? preferredAggregator : 'best'
  const [view, setView] = useState<View>('loop')
  const [picked, setPicked] = useState<{
    market: string
    collateral: Address
    debt: Address
    /** set when the pair comes from the scanner: eMode and leverage to start the open panel with */
    seed?: { emode: number; leverage: number; nonce: number }
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
    setPicked({ market: p.marketId, collateral: p.collateral, debt: p.debt, seed: { emode: p.emode, leverage: p.leverage, nonce: Date.now() } })
    setView('loop')
    window.scrollTo({ top: 0 })
  }
  const seed =
    pair && picked?.market === market.id && picked.collateral === pair.collateral.address && picked.debt === pair.debt.address ? picked.seed : undefined
  const setPair = (collateral: Token, debt: Token) =>
    setPicked({
      market: market.id,
      collateral: collateral.address,
      debt: debt.address,
    })

  const selectors = (
    <div className="market-row">
      <label className="field">
        <span>Réseau</span>
        <select value={market.id} onChange={(e) => chooseMarket(e.target.value)}>
          {MARKETS.filter((m) => !m.soon).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
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
    </>
  )

  return (
    <div className={`page ${view === 'positions' ? 'narrow' : ''}`}>
      <header className="top">
        <h1>Auto-loop</h1>
        <WalletButton market={market} />
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

      {view === 'scan' && !DEMO && <Scanner onPick={openPick} />}
      {view === 'positions' && !DEMO && <Positions account={address} onManage={openPick} onScan={() => setView('scan')} />}
      {view === 'loop' &&
        (pair ? (
          <PairView
            key={`${market.id}-${seed?.nonce ?? ''}`}
            market={market}
            collateral={pair.collateral}
            debt={pair.debt}
            nativeToken={wrappedNative(tokens, market.chain)?.address}
            account={address}
            aggregator={aggregator}
            selectors={selectors}
            common={common}
            notes={notes}
            seed={seed}
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
  account?: Address
  aggregator: AggregatorChoice
  selectors: ReactNode
  common: ReactNode
  notes: ReactNode
  seed?: { emode: number; leverage: number }
}

function PairView({ market: m, collateral, debt, nativeToken, account, aggregator, selectors, common, notes, seed }: PairViewProps) {
  const [tab, setTab] = useState<'open' | 'close'>('open')
  const market = useMarket(m, collateral, debt, account, nativeToken)
  const emodes = useEModeCategories(m)
  const incentives = useCampaigns(m)
  const r = market.reserves && withIncentives(market.reserves, incentives.data)
  // closing works inside the account's current eMode, if it applies to the pair
  const currentEMode = r && market.user ? eligibleEModes(emodes, r.collateral, r.debt).find((c) => c.id === market.user!.eModeCategory) : undefined

  const natives = r ? [r.collateral.native, r.debt.native].filter((n) => n !== undefined) : []
  const nativeSince = natives.length ? Math.min(...natives.map((n) => n.since)) : undefined

  const head = (
    <>
      {notes}
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
                      {fmtPct(x.supplyApy)}
                      {x.native && <span className="muted"> + {fmtPct(x.native.apy)} token</span>}
                      {x.supplyRewardApr > 0 && <span className="reward"> + {fmtPct(x.supplyRewardApr)} Merkl</span>}
                    </td>
                    <td data-label="APY emprunt">
                      {fmtPct(x.borrowApy)}
                      {x.native && <span className="muted"> + {fmtPct(x.native.apy)} token</span>}
                      {x.borrowRewardApr > 0 && <span className="reward"> − {fmtPct(x.borrowRewardApr)} Merkl</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
  return tab === 'open' ? (
    <OpenPanel
      reserves={r}
      emodes={emodes}
      seed={seed}
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
      user={market.user}
      account={account}
      aggregator={aggregator}
      common={common}
      head={head}
      onDone={market.refetchUser}
    />
  )
}
