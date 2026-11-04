import { useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getAddress, isAddress, type Address } from 'viem'
import { executorRouters, type Market } from '../config'
import { deployExecutor, verifyExecutor } from '../lib/deploy'
import { fmtAddress } from '../lib/format'
import { Fold, Notice } from './ui'

function errText(e: unknown) {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  return m.split('\n')[0]
}

/** Banner shown while the market has no executor: deploy one from the connected wallet, or reuse one already deployed. */
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

  if (routers.length === 0) return <Notice>Aucun agrégateur ne cote sur {market.label} : le contrat ne peut pas y être déployé.</Notice>

  return (
    <>
      <Notice>
        <span>Contrat Auto-loop absent sur {market.label} : une transaction depuis le portefeuille le déploie.</span>
        {!isConnected ? null : chainId !== market.chain.id ? (
          <button className="btn" onClick={() => switchChain({ chainId: market.chain.id })}>
            Passer sur {market.chain.name}
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={deploy}>
            {step ?? `Déployer le contrat sur ${market.label}`}
          </button>
        )}
      </Notice>
      {error && <Notice tone="bad">{error}</Notice>}
      <Fold title="Contrat" value="sans propriétaire, routeurs figés" plain>
        <p className="muted small">
          Seul le gas est payé. Le contrat n’a ni propriétaire ni fonction d’administration et ne garde aucun fonds : dépôts et dette restent sur le compte Aave
          de l’adresse qui signe. Routeurs autorisés :{' '}
          {routers.map((r, i) => (
            <span key={r.router}>
              {i > 0 && ', '}
              {r.label} ({fmtAddress(r.router)})
            </span>
          ))}
          . Pool Aave : {fmtAddress(market.pool)}.
        </p>
        <div className="grid2">
          <label className="field">
            <span>Contrat déjà déployé</span>
            <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="0x…" spellCheck={false} />
          </label>
          <button className="btn" disabled={busy || !pasted.trim()} onClick={reuse} style={{ alignSelf: 'end' }}>
            Vérifier et utiliser
          </button>
        </div>
      </Fold>
    </>
  )
}
