import { useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { AGGREGATORS, CHAIN_ID, DEMO, EXECUTOR, PLATFORMS, QUOTE_MODE, TOKENS, type AggregatorId, type Token } from './config'
import { useMarket } from './lib/useMarket'
import { fmtPct, fmtPrice } from './lib/format'
import { Card, Notice, Segmented } from './components/ui'
import { OpenPanel } from './components/OpenPanel'
import { ClosePanel } from './components/ClosePanel'

function WalletButton() {
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
  if (chainId !== CHAIN_ID) {
    return (
      <button className="btn warn" onClick={() => switchChain({ chainId: CHAIN_ID })}>
        Passer sur Base
      </button>
    )
  }
  return (
    <button className="btn ghost" onClick={() => disconnect()} title="Déconnecter">
      {address!.slice(0, 6)}…{address!.slice(-4)}
    </button>
  )
}

function TokenSelect({ value, onChange, exclude, label }: { value: Token; onChange: (t: Token) => void; exclude: Token; label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value.address} onChange={(e) => onChange(TOKENS.find((t) => t.address === e.target.value)!)}>
        {TOKENS.map((t) => (
          <option key={t.address} value={t.address} disabled={t.address === exclude.address}>
            {t.symbol}
          </option>
        ))}
      </select>
    </label>
  )
}

export function App() {
  const { address } = useAccount()
  const [platform, setPlatform] = useState<string>('aave-v3')
  const [collateral, setCollateral] = useState<Token>(TOKENS[0])
  const [debt, setDebt] = useState<Token>(TOKENS[1])
  const [aggregator, setAggregator] = useState<AggregatorId>('velora')
  const [tab, setTab] = useState<'open' | 'close'>('open')

  const market = useMarket(collateral, debt, address)
  const r = market.reserves

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Auto-loop</h1>
          <p className="tagline">Position à levier en une transaction : flash loan, swap, dépôt.</p>
        </div>
        <WalletButton />
      </header>

      {DEMO && <Notice tone="info">Mode démo : prix et paramètres de marché fictifs, rien n’est lu sur la chaîne.</Notice>}
      {!EXECUTOR && (
        <Notice tone="info">
          Le contrat n’est pas encore déployé : tout est calculé et la transaction est affichée, mais pas proposée à la
          signature.
        </Notice>
      )}
      {QUOTE_MODE === 'mock' && <Notice tone="info">Cotations simulées au prix de l’oracle (VITE_QUOTE_MODE=mock).</Notice>}

      <Card title="Marché">
        <div className="grid2">
          <div className="field">
            <span>Plateforme de prêt</span>
            <Segmented
              value={platform}
              onChange={setPlatform}
              options={PLATFORMS.map((p) => ({ value: p.id, label: p.label, disabled: !p.available, hint: p.available ? undefined : 'bientôt' }))}
            />
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
        </div>
        <div className="pair">
          <TokenSelect label="Collatéral (on prend le risque sur)" value={collateral} onChange={setCollateral} exclude={debt} />
          <button
            className="btn ghost swap"
            title="Inverser"
            onClick={() => {
              setCollateral(debt)
              setDebt(collateral)
            }}
          >
            ⇄
          </button>
          <TokenSelect label="Dette (on emprunte)" value={debt} onChange={setDebt} exclude={collateral} />
        </div>

        {market.error && <Notice tone="bad">Lecture d’Aave impossible : {market.error.message.split('\n')[0]}</Notice>}
        {market.loading && <p className="muted">Lecture du marché Aave v3…</p>}
        {r === null && <Notice tone="bad">Cette paire n’est pas listée sur Aave v3 Base.</Notice>}
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
          <OpenPanel reserves={r} user={market.user} account={address} aggregator={aggregator} onDone={market.refetchUser} />
        ) : (
          <ClosePanel reserves={r} user={market.user} account={address} aggregator={aggregator} onDone={market.refetchUser} />
        ))}

      <footer className="muted small">
        Non audité. Vérifie toujours la transaction dans ton portefeuille. Le contrat n’agit que pour l’adresse qui signe.
      </footer>
    </div>
  )
}
