import { createContext, useContext, useState } from 'react'
import type { Address, Chain } from 'viem'
import { useAccount, useConnect, useSwitchChain } from 'wagmi'
import { explainError } from '../lib/execute'
import { chooseWallet, useWallets } from './wallets'

/**
 * What an action screen needs before its own button: a connected wallet, on the right network, with a verified
 * Auto-loop contract there. The summary's single button walks through these steps in order (charte v2, rule 2).
 */
export type Gate = {
  chain: Chain
  /** network name as the selector shows it */
  label: string
  executor: 'ok' | 'missing' | 'checking' | 'refused' | 'none'
  /** deploys the contract from the wallet; the address is then kept by `onDeployed` */
  deploy: (onStep: (s: string) => void) => Promise<Address>
  onDeployed: (a: Address) => void
}

const GateContext = createContext<Gate | undefined>(undefined)
export const GateProvider = GateContext.Provider

export type GateStep = { label: string; onClick?: () => void; reason?: string; bad?: boolean }

/** `needs`: 'contract' for a transaction through Auto-loop, 'wallet' for one sent straight from the wallet (a claim). */
export function useGateStep(needs: 'contract' | 'wallet' | 'none' = 'contract'): GateStep | undefined {
  const g = useContext(GateContext)
  const { isConnected, chainId } = useAccount()
  const { connect, isPending } = useConnect()
  const wallets = useWallets()
  const { switchChain, isPending: switching } = useSwitchChain()
  const [step, setStep] = useState<string>()
  const [error, setError] = useState<string>()
  if (!g || needs === 'none') return undefined

  if (!isConnected) {
    // one wallet: connect it; several: let the header menu ask which one
    const only = wallets.length === 1 ? wallets[0] : undefined
    return {
      label: isPending ? 'Connexion…' : 'Connecter le portefeuille',
      onClick: isPending || !wallets.length ? undefined : only ? () => connect({ connector: only }) : chooseWallet,
      reason: wallets.length ? undefined : 'Aucun portefeuille détecté dans ce navigateur',
    }
  }
  if (chainId !== g.chain.id)
    return {
      label: switching ? 'Changement de réseau…' : `Passer sur ${g.chain.name}`,
      onClick: switching ? undefined : () => switchChain({ chainId: g.chain.id }),
    }
  if (needs === 'wallet') return undefined
  switch (g.executor) {
    case 'checking':
      return { label: 'Vérification du contrat…' }
    case 'refused':
      return { label: 'Contrat refusé', reason: 'Voir le bandeau rouge', bad: true }
    case 'none':
      return { label: 'Indisponible', reason: `Aucun agrégateur ne cote sur ${g.label}` }
    case 'missing':
      return {
        label: step ?? 'Déployer le contrat',
        onClick: step
          ? undefined
          : async () => {
              setError(undefined)
              try {
                g.onDeployed(await g.deploy(setStep))
              } catch (e) {
                setError(explainError(e).split('\n')[0])
              } finally {
                setStep(undefined)
              }
            },
        reason: error ?? `Une fois sur ${g.label} : déploie le contrat Auto-loop depuis le portefeuille, seul le gas est payé.`,
        bad: !!error,
      }
  }
  return undefined
}
