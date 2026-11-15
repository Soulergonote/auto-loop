import { describe, expect, it } from 'vitest'
import { PROTECTED_RPCS, protectedChainParams } from './rpc'

describe('protectedChainParams', () => {
  it('adds the protected RPC to Ethereum itself', () => {
    for (const rpc of PROTECTED_RPCS) {
      const p = protectedChainParams(rpc)
      expect(p.chainId).toBe('0x1')
      expect(p.rpcUrls).toEqual([rpc.url])
      expect(rpc.url.startsWith('https://')).toBe(true)
      expect(p.nativeCurrency.symbol).toBe('ETH')
      expect(p.chainName).toContain(rpc.label)
    }
  })
})
