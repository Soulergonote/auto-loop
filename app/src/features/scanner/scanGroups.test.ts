import { describe, expect, it } from 'vitest'
import { groupLines, spreadOf } from './scanGroups'

describe('scanner groups', () => {
  it('folds the markets of one pair behind the best one', () => {
    const lines = [
      { key: 'a1', group: 'A', apy: 0.1 },
      { key: 'b', group: 'B', apy: 0.3 },
      { key: 'a2', group: 'A', apy: 0.4 },
      { key: 'a3', group: 'A', apy: 0.2 },
    ]
    const g = groupLines(lines)
    expect(g.map((x) => x.head.key)).toEqual(['a2', 'b'])
    expect(g[0].variants.map((x) => x.key)).toEqual(['a3', 'a1'])
    expect(g[1].variants).toEqual([])
  })

  it('measures the spread before leverage', () => {
    expect(spreadOf({ collateralYield: 0.11, borrowCost: 0.05 })).toBeCloseTo(0.06)
  })
})
