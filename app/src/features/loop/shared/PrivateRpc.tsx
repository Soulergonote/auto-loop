import { useState } from 'react'
import { useAccount } from 'wagmi'
import { mainnet } from 'viem/chains'
import { PROTECTED_RPCS, protectedChainParams, type ProtectedRpc } from '../../../config'

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

/**
 * « Envoi privé » line of the Réglages block, on Ethereum only (F7): asks the wallet to add a protected RPC
 * (wallet_addEthereumChain). The wallet decides: some refuse to change Ethereum's RPC, the address is then given to
 * paste by hand. Nothing is sent or signed here.
 */
export function PrivateRpc({ chainId }: { chainId: number }) {
  const { connector, isConnected } = useAccount()
  const [state, setState] = useState<{ rpc: ProtectedRpc; result: 'asked' | 'done' | 'refused' }>()
  if (chainId !== mainnet.id) return null
  const add = async (rpc: ProtectedRpc) => {
    setState({ rpc, result: 'asked' })
    try {
      const provider = (await connector?.getProvider()) as Provider | undefined
      if (!provider) throw new Error('no provider')
      await provider.request({ method: 'wallet_addEthereumChain', params: [protectedChainParams(rpc)] })
      setState({ rpc, result: 'done' })
    } catch {
      setState({ rpc, result: 'refused' })
    }
  }
  return (
    <div className="field">
      <span>Envoi privé</span>
      <div className="actions">
        {PROTECTED_RPCS.map((rpc) => (
          <button key={rpc.id} className="btn small" disabled={!isConnected || state?.result === 'asked'} onClick={() => void add(rpc)}>
            Ajouter {rpc.label}
          </button>
        ))}
      </div>
      <p className="muted small">
        {state?.result === 'done' ? (
          <>Demande acceptée par le portefeuille : vérifier que le réseau Ethereum y utilise bien {state.rpc.label}.</>
        ) : state?.result === 'refused' ? (
          <>
            Le portefeuille n’a pas ajouté le RPC. À coller à la main dans ses réglages de réseau : <span className="addr">{state.rpc.url}</span>
          </>
        ) : (
          <>Un RPC protégé envoie la transaction sans passer par la mempool publique : le swap ne peut pas être pris en sandwich.</>
        )}
        {!isConnected && ' Connecter le portefeuille pour l’ajouter.'}
      </p>
    </div>
  )
}
