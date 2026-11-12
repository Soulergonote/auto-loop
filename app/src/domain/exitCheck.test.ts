import { describe, expect, it } from 'vitest'
import { exitIssues, exitSellAmount, utilization } from './exitCheck'

const USD = 10n ** 8n
describe('exit check before opening', () => {
  it('sells what repays the whole debt plus 1 %, rounded', () => {
    // 10 000 USDC of debt (base units, $1 = 1e8), WETH at 3 000 $: 10 100 / 3 000 = 3.366 → 3.4 WETH
    const weth = { price: 3000n * USD, decimals: 18 }
    expect(exitSellAmount(10_000n * USD, weth)).toBe(34n * 10n ** 17n)
    expect(exitSellAmount(0n, weth)).toBe(0n)
  })

  it('blocks without a route, warns on a costly exit or a reserve lent out', () => {
    const none = exitIssues({ sell: 'wstUSR', buy: 'USDC', noRoute: true, reason: 'no route' })
    expect(none.problems[0]).toMatch(/^Sortie impossible : aucun agrégateur ne revend wstUSR contre USDC .*\(no route\)/)
    expect(none.warnings).toEqual([])
    const costly = exitIssues({ sell: 'sUSDe', buy: 'USDC', noRoute: false, loss: 0.012, utilization: 0.99 })
    expect(costly.problems).toEqual([])
    expect(costly.warnings).toHaveLength(2)
    expect(costly.warnings[0]).toContain('1,2')
    expect(costly.warnings[1]).toContain('retirer le collatéral')
    expect(exitIssues({ sell: 'a', buy: 'b', noRoute: false, loss: 0.001, utilization: 0.5 })).toEqual({ problems: [], warnings: [] })
  })

  it('measures utilization', () => {
    expect(utilization(100n, 98n)).toBeCloseTo(0.98)
    expect(utilization(0n, 0n)).toBe(0)
  })
})
