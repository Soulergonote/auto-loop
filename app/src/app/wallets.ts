import { useConnect } from 'wagmi'

/**
 * Wallets to offer at connection: every browser wallet that announces itself (EIP-6963: Rabby, Ambire, MetaMask…),
 * else the generic one behind window.ethereum. Taking the first connector connected whichever extension had taken
 * window.ethereum (Rabby over Ambire, for instance).
 */
export function useWallets() {
  const { connectors } = useConnect()
  const announced = connectors.filter((c) => c.type === 'injected' && c.id !== 'injected')
  return announced.length ? announced : connectors.filter((c) => c.id === 'injected')
}

/** Asks the header's wallet menu to open, so a summary button can hand the choice of wallet over to it. */
export const CHOOSE_WALLET = 'auto-loop:choose-wallet'
export const chooseWallet = () => {
  window.scrollTo({ top: 0 })
  window.dispatchEvent(new Event(CHOOSE_WALLET))
}
