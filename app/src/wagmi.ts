import { createConfig, fallback, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import type { Chain } from 'viem'
import { MARKETS, rpcUrls } from './config'

const chains = [...new Map(MARKETS.map((m) => [m.chain.id, m.chain])).values()] as [Chain, ...Chain[]]

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  // a public RPC that hangs fails over to the next one after 10 s instead of blocking the page
  transports: Object.fromEntries(chains.map((c) => [c.id, fallback(rpcUrls(c).map((u) => http(u, { timeout: 10_000, retryCount: 1 })))])),
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
