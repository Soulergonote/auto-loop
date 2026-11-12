import { useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { getAddress, isAddress, type Address } from 'viem'
import { executorRouters, MORPHO_BLUE, type Market } from '../config'
import { deployExecutor, verifyExecutor } from '../lib/deploy'
import { fmtAddress } from '../lib/format'
import { Fold, Notice } from './ui'

function errText(e: unknown) {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  return m.split('\n')[0]
}

/**
 * Banner shown while the market has no executor: deploy one from the connected wallet, or reuse one already deployed.
 * With `upgrade`, the market runs a v1 executor: it keeps working, the banner offers the v2 (closes without premium).
 * With `upgrade="pendle"`, a v2 executor deployed before PT loops: the banner offers one with Pendle's router.
 */
export function DeployPanel({
  market,
  onReady,
  upgrade,
  shared,
}: {
  market: Market
  onReady: (a: Address) => void
  upgrade?: boolean | 'pendle'
  /** the network's shared v2 executor, already deployed and checked: offered instead of a deployment */
  shared?: Address
}) {
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
      const v = await verifyExecutor(market, a)
      if (upgrade && v.version !== 2) throw new Error('ce contrat est une v1')
      if (upgrade === 'pendle' && !v.pendle) throw new Error('ce contrat n’autorise pas le routeur Pendle')
      return a
    })

  // without a contract, the summary's button deploys it (charte v2, rule 2): only the paste option stays here
  if (routers.length === 0) return null

  return (
    <>
      {upgrade && (
        <Notice>
          <span>
            {upgrade === 'pendle'
              ? `Le contrat Auto-loop de ${market.label} n’autorise pas le routeur Pendle : il reste utilisable pour les autres paires. Une transaction déploie un contrat qui gère aussi les PT.`
              : `Contrat Auto-loop v1 sur ${market.label} : il reste utilisable. La v2 ferme les positions sans prime de flash loan quand Morpho a la liquidité et corrige un défaut de la v1 (des aTokens envoyés au contrat peuvent bloquer les fermetures)${shared ? ' ; le contrat v2 commun de ce réseau est déjà déployé, la position reste sur le compte Aave' : ' ; une transaction la déploie, une fois pour tous les utilisateurs'}.`}
          </span>
          {shared ? (
            <button className="btn" onClick={() => onReady(shared)}>
              Utiliser le contrat commun {fmtAddress(shared)}
            </button>
          ) : !isConnected ? null : chainId !== market.chain.id ? (
            <button className="btn" onClick={() => switchChain({ chainId: market.chain.id })}>
              Passer sur {market.chain.name}
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={deploy}>
              {step ?? `Déployer le contrat${upgrade === 'pendle' ? ' avec Pendle' : ' v2'} sur ${market.label}`}
            </button>
          )}
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      <Fold title="Contrat" value="sans propriétaire, routeurs figés" plain>
        <p className="muted small">
          Seul le gas est payé, une seule fois pour tous : le contrat est déployé à une adresse commune, la même pour tout utilisateur de l’app sur ce réseau
          (CREATE2 par le déployeur déterministe 0x4e59…956C), et l’app l’utilise dès qu’il existe. Le contrat n’a ni propriétaire ni fonction d’administration
          et ne garde aucun fonds : dépôts et dette restent sur le compte Aave de l’adresse qui signe. Prêteur flash gratuit :{' '}
          {market.chain.id in MORPHO_BLUE ? `Morpho Blue (${fmtAddress(MORPHO_BLUE[market.chain.id])})` : 'aucun sur ce réseau, prime Aave'}. Routeurs autorisés
          :{' '}
          {routers.map((r, i) => (
            <span key={r.router}>
              {i > 0 && ', '}
              {r.label} (<span className="addr">{fmtAddress(r.router)}</span>)
            </span>
          ))}
          . Pool Aave : <span className="addr">{fmtAddress(market.pool)}</span>.
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
