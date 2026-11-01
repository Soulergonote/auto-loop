import { useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getAddress, isAddress, type Address } from 'viem'
import { executorRouters, type Market } from '../config'
import { deployExecutor, verifyExecutor } from '../lib/deploy'
import { Card, Notice } from './ui'

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function errText(e: unknown) {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  return m.split('\n')[0]
}

/** Shown while the market has no executor: deploy one from the user's own wallet, or reuse one already deployed. */
export function DeployPanel({ market, onReady }: { market: Market; onReady: (a: Address) => void }) {
  const { isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const routers = executorRouters(market.chain.id)
  const [step, setStep] = useState<string>()
  const [error, setError] = useState<string>()
  const [pasted, setPasted] = useState('')
  const busy = !!step

  async function run(task: () => Promise<Address>) {
    setError(undefined)
    try {
      onReady(await task())
    } catch (e) {
      setError(errText(e))
    } finally {
      setStep(undefined)
    }
  }

  const deploy = () => run(() => deployExecutor(market, setStep))
  const reuse = () =>
    run(async () => {
      if (!isAddress(pasted.trim())) throw new Error('adresse invalide')
      const a = getAddress(pasted.trim())
      setStep('Vérification du contrat…')
      await verifyExecutor(market, a)
      return a
    })

  if (routers.length === 0)
    return <Notice tone="info">Aucun agrégateur ne cote sur {market.label} : le contrat ne peut pas y être déployé.</Notice>

  return (
    <Card title={`Contrat Auto-loop sur ${market.label}`}>
      <p>
        Le contrat n’est pas encore déployé sur {market.label}. Tu peux le déployer toi-même depuis ton portefeuille : une
        seule transaction, tu ne paies que le gas. Il n’a ni propriétaire ni fonction d’administration, et ne garde jamais
        de fonds : tes dépôts et ta dette restent sur ton propre compte Aave.
      </p>
      <p className="muted small">
        Routeurs autorisés, figés pour toujours :{' '}
        {routers.map((r, i) => (
          <span key={r.router}>
            {i > 0 && ', '}
            {r.label} ({short(r.router)})
          </span>
        ))}
        . Pool Aave : {short(market.pool)}.
      </p>
      {!isConnected ? (
        <p className="muted">Connecte ton portefeuille pour déployer.</p>
      ) : chainId !== market.chain.id ? (
        <button className="btn warn" onClick={() => switchChain({ chainId: market.chain.id })}>
          Passer sur {market.chain.name}
        </button>
      ) : (
        <button className="btn" disabled={busy} onClick={deploy}>
          Déployer le contrat sur {market.label}
        </button>
      )}
      <div className="grid2" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Déjà déployé (autre navigateur) ? Adresse du contrat</span>
          <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="0x…" spellCheck={false} />
        </label>
        <button className="btn ghost" disabled={busy || !pasted.trim()} onClick={reuse} style={{ alignSelf: 'end' }}>
          Vérifier et utiliser
        </button>
      </div>
      {step && <p className="muted">{step}</p>}
      {error && <Notice tone="bad">{error}</Notice>}
    </Card>
  )
}
