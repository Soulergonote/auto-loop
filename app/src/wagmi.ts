import { http, createConfig } from 'wagmi'
import { base } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { RPC_URL } from './config'

export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [injected()],
  transports: { [base.id]: http(RPC_URL) },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
