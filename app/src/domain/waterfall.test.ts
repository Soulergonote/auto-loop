import { describe, expect, it } from 'vitest'
import { waterfall, waterfallRange } from './waterfall'

describe('waterfall', () => {
  const steps = waterfall([
    { label: 'collatéral × 3', value: 0.09 },
    { label: 'Merkl', value: 0.02 },
    { label: 'emprunt × 2', value: -0.14 },
    { label: 'APY net', total: true },
    { label: 'coûts', value: -0.01 },
    { label: 'NaN', value: NaN },
    { label: 'coûts compris', total: true },
  ])
  it('chains each step from the running total, totals from zero', () => {
    expect(steps.map((s) => s.kind)).toEqual(['up', 'up', 'down', 'total', 'down', 'total'])
    expect(steps[2].start).toBeCloseTo(0.11)
    expect(steps[2].end).toBeCloseTo(-0.03)
    expect(steps[3]).toMatchObject({ start: 0, kind: 'total' })
    expect(steps[3].end).toBeCloseTo(-0.03)
    expect(steps[5].value).toBeCloseTo(-0.04)
  })
  it('the range covers every point and zero', () => {
    const r = waterfallRange(steps)
    expect(r.lo).toBeCloseTo(-0.04)
    expect(r.hi).toBeCloseTo(0.11)
    expect(waterfallRange([])).toEqual({ lo: -0.01, hi: 0.01 })
  })
})
