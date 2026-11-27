import { describe, expect, it } from 'vitest'
import { AGGREGATORS, MARKETS, TYCHO_CHAIN_SLUGS, executorRouters, routerOf, type Market } from '.'
import { sharedExecutorAddresses } from '../chain/deploy'

describe('Tycho', () => {
  it('has an API slug and its own router on every chain it quotes on', () => {
    expect(Object.keys(TYCHO_CHAIN_SLUGS).map(Number).sort()).toEqual([...AGGREGATORS.tycho.chains!].sort())
    const routers = AGGREGATORS.tycho.chains!.map((c) => routerOf('tycho', c))
    expect(new Set(routers).size).toBe(routers.length)
    for (const c of AGGREGATORS.tycho.chains!) expect(executorRouters(c).some((r) => r.id === 'tycho')).toBe(true)
  })

  it('keeps finding the shared contracts deployed before it', () => {
    const at = (id: string) => sharedExecutorAddresses(MARKETS.find((m) => m.id === id)! as Market)
    // Arbitrum's shared V2 (deployed before Tycho): now the fallback address
    expect(at('arbitrum')).toHaveLength(2)
    expect(at('arbitrum')[1]).toBe('0x3b7dc135922a9669ac69a221Cd641954CeD66774')
    // no Tycho on Plasma: a single address, the deployed one
    expect(at('plasma')).toEqual(['0x55D8604538f3f8D5BFFA966b4c151ABDB54ec0a7'])
  })
})
