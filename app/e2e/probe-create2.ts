// Is the deterministic deployment proxy (0x4e59…956C) on each chain of the app? `npx vite-node e2e/probe-create2.ts`
import { createPublicClient, http, type Chain } from 'viem'
import { MARKETS, MORPHO_NETWORKS, rpcUrls } from '../src/config'
const PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const chains = [...new Map([...MARKETS, ...MORPHO_NETWORKS].map((m) => [m.chain.id, m.chain])).values()] as Chain[]
for (const chain of chains) {
  let out = 'injoignable'
  for (const url of rpcUrls(chain)) {
    try {
      const code = await createPublicClient({ chain, transport: http(url, { timeout: 10_000 }) }).getCode({ address: PROXY })
      out = code && code !== '0x' ? `présent (${(code.length - 2) / 2} octets)` : 'absent'
      break
    } catch {
      // next RPC
    }
  }
  console.log(`${chain.id}\t${chain.name}\t${out}`)
}
