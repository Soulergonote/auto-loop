import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { CHOOSE_WALLET, useWallets } from './wallets'
import { type Market } from '../config'
import { fmtAddress } from '../ui/format'

export function WalletButton({ market }: { market: { chain: Market['chain'] } }) {
  const { address, chainId, chain, isConnected } = useAccount()
  const { connect, isPending } = useConnect()
  const wallets = useWallets()
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
    const open = () => {
      if (!menu.current) return
      menu.current.open = true
      menu.current.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    window.addEventListener(CHOOSE_WALLET, open)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
      window.removeEventListener(CHOOSE_WALLET, open)
    }
  }, [])

  if (!isConnected) {
    const label = isPending ? 'Connexion…' : 'Connecter le portefeuille'
    if (wallets.length < 2)
      return (
        <button className="btn" disabled={!wallets.length || isPending} onClick={() => wallets[0] && connect({ connector: wallets[0] })}>
          {label}
        </button>
      )
    // several browser wallets: the user picks which one
    return (
      <details className="wallet-menu" ref={menu}>
        <summary className="btn">{label}</summary>
        <div className="menu" role="menu">
          {wallets.map((w) => (
            <button
              key={w.uid}
              role="menuitem"
              className="wallet-choice"
              disabled={isPending}
              onClick={() => {
                if (menu.current) menu.current.open = false
                connect({ connector: w })
              }}
            >
              {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
              {w.name}
            </button>
          ))}
        </div>
      </details>
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
