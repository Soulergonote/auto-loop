import { createConfig, fallback, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import type { Chain } from 'viem'
import { MARKETS, rpcUrls } from './config'

const chains = [...new Map(MARKETS.map((m) => [m.chain.id, m.chain])).values()] as [Chain, ...Chain[]]

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(chains.map((c) => [c.id, fallback(rpcUrls(c).map((u) => http(u)))])),
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
