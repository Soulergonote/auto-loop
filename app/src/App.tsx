import { useMemo, useState, type ReactNode } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import type { Address } from 'viem'
import {
  AGGREGATORS,
  DEFAULT_COLLATERAL_SYMBOLS,
  DEFAULT_DEBT_SYMBOLS,
  DEFAULT_MARKET_ID,
  DEMO,
  MARKETS,
  PLATFORMS,
  QUOTE_MODE,
  getMarket,
  type AggregatorId,
  type Market,
  type Token,
} from './config'
import { useMarket, useReserveTokens } from './lib/useMarket'
import { fmtPct, fmtPrice } from './lib/format'
import { Card, Notice, Segmented } from './components/ui'
import { OpenPanel } from './components/OpenPanel'
import { ClosePanel } from './components/ClosePanel'

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
      <button className="btn warn" onClick={() => switchChain({ chainId: market.chain.id })}>
        Passer sur {market.chain.name}
      </button>
    )
  }
  return (
    <button className="btn ghost" onClick={() => disconnect()} title="Déconnecter">
      {address!.slice(0, 6)}…{address!.slice(-4)}
    </button>
  )
}

type TokenSelectProps = { tokens: Token[]; value: Token; onChange: (t: Token) => void; exclude: Token; label: string }

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
  const bySymbol = (symbols: string[], not?: Token) =>
    symbols.map((s) => tokens.find((t) => t.symbol === s)).find((t): t is Token => !!t && t !== not)
  const collateral = bySymbol(DEFAULT_COLLATERAL_SYMBOLS) ?? tokens[0]
  const debt = bySymbol(DEFAULT_DEBT_SYMBOLS, collateral) ?? tokens.find((t) => t !== collateral)!
  return { collateral, debt }
}

export function App() {
  const { address } = useAccount()
  const [marketId, setMarketId] = useState(savedMarketId)
  const market = useMemo(() => getMarket(marketId), [marketId])
  const reserveTokens = useReserveTokens(market)
  const tokens = reserveTokens.tokens
  const [platform, setPlatform] = useState<string>('aave-v3')
  const [aggregator, setAggregator] = useState<AggregatorId>('velora')
  const [picked, setPicked] = useState<{ market: string; collateral: Address; debt: Address }>()

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
  const setPair = (collateral: Token, debt: Token) => setPicked({ market: market.id, collateral: collateral.address, debt: debt.address })

  const selectors = (
    <>
      <div className="grid2">
        <label className="field">
          <span>Réseau</span>
          <select value={market.id} onChange={(e) => chooseMarket(e.target.value)}>
            {MARKETS.map((m) => (
              <option key={m.id} value={m.id} disabled={!!m.soon}>
                {m.label}
                {m.soon ? ` (bientôt : ${m.soon})` : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>Plateforme de prêt</span>
          <Segmented
            value={platform}
            onChange={setPlatform}
            options={PLATFORMS.map((p) => ({ value: p.id, label: p.label, disabled: !p.available, hint: p.available ? undefined : 'bientôt' }))}
          />
        </div>
      </div>
      <div className="field">
        <span>Agrégateur</span>
        <Segmented
          value={aggregator}
          onChange={setAggregator}
          options={(Object.keys(AGGREGATORS) as AggregatorId[]).map((id) => ({
            value: id,
            label: AGGREGATORS[id].label,
            disabled: !AGGREGATORS[id].available,
            hint: AGGREGATORS[id].available ? undefined : 'bientôt',
          }))}
        />
      </div>
      {tokens && pair && (
        <div className="pair">
          <TokenSelect tokens={tokens} label="Collatéral (on prend le risque sur)" value={pair.collateral} onChange={(t) => setPair(t, pair.debt)} exclude={pair.debt} />
          <button className="btn ghost swap" title="Inverser" onClick={() => setPair(pair.debt, pair.collateral)}>
            ⇄
          </button>
          <TokenSelect tokens={tokens} label="Dette (on emprunte)" value={pair.debt} onChange={(t) => setPair(pair.collateral, t)} exclude={pair.collateral} />
        </div>
      )}
    </>
  )

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Auto-loop</h1>
          <p className="tagline">Position à levier en une transaction : flash loan, swap, dépôt.</p>
        </div>
        <WalletButton market={market} />
      </header>

      {DEMO && <Notice tone="info">Mode démo : prix et paramètres de marché fictifs, rien n’est lu sur la chaîne.</Notice>}
      {!market.executor && (
        <Notice tone="info">
          Le contrat n’est pas encore déployé sur {market.label} : tout est calculé et la transaction est affichée, mais pas
          proposée à la signature.
        </Notice>
      )}
      {QUOTE_MODE === 'mock' && <Notice tone="info">Cotations simulées au prix de l’oracle (VITE_QUOTE_MODE=mock).</Notice>}

      {pair ? (
        <PairView key={market.id} market={market} collateral={pair.collateral} debt={pair.debt} account={address} aggregator={aggregator} selectors={selectors} />
      ) : (
        <Card title="Marché">
          {selectors}
          {reserveTokens.error ? (
            <Notice tone="bad">Lecture d’Aave sur {market.label} impossible : {reserveTokens.error.message.split('\n')[0]}</Notice>
          ) : (
            <p className="muted">Lecture des actifs Aave v3 sur {market.label}…</p>
          )}
        </Card>
      )}

      <footer className="muted small">
        Non audité. Vérifie toujours la transaction dans ton portefeuille. Le contrat n’agit que pour l’adresse qui signe.
      </footer>
    </div>
  )
}

type PairViewProps = {
  market: Market
  collateral: Token
  debt: Token
  account?: Address
  aggregator: AggregatorId
  selectors: ReactNode
}

function PairView({ market: m, collateral, debt, account, aggregator, selectors }: PairViewProps) {
  const [tab, setTab] = useState<'open' | 'close'>('open')
  const market = useMarket(m, collateral, debt, account)
  const r = market.reserves

  return (
    <>
      <Card title="Marché">
        {selectors}
        {market.error && <Notice tone="bad">Lecture d’Aave impossible : {market.error.message.split('\n')[0]}</Notice>}
        {market.loading && <p className="muted">Lecture du marché Aave v3…</p>}
        {r === null && <Notice tone="bad">Cette paire n’est pas listée sur Aave v3 {m.label}.</Notice>}
        {r && (
          <table className="reserves">
            <thead>
              <tr>
                <th></th>
                <th>Prix oracle</th>
                <th>LTV / seuil liq.</th>
                <th>APY dépôt</th>
                <th>APY emprunt</th>
              </tr>
            </thead>
            <tbody>
              {[r.collateral, r.debt].map((x) => (
                <tr key={x.token.address}>
                  <td>{x.token.symbol}</td>
                  <td>{fmtPrice(x.price)}</td>
                  <td>
                    {fmtPct(x.config.ltvBps / 10_000, 0)} / {fmtPct(x.config.liquidationThresholdBps / 10_000, 0)}
                  </td>
                  <td>{fmtPct(x.supplyApy)}</td>
                  <td>{fmtPct(x.borrowApy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

      {r &&
        (tab === 'open' ? (
          <OpenPanel reserves={r} user={market.user} account={account} aggregator={aggregator} onDone={market.refetchUser} />
        ) : (
          <ClosePanel reserves={r} user={market.user} account={account} aggregator={aggregator} onDone={market.refetchUser} />
        ))}
    </>
  )
}
