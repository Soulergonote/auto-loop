/**
 * APY waterfall (J2): each part of a loop's yield as a step from the previous running total, with subtotals, so that one
 * picture explains a negative WETH / USDC loop or a 58 % PT loop.
 */
export type WaterfallPart = { label: string; value: number } | { label: string; total: true }
export type WaterfallStep = { label: string; value: number; start: number; end: number; kind: 'up' | 'down' | 'total' }

/** Running sum of the parts; a `total` part shows the sum so far, from zero. Parts that are not finite are skipped. */
export function waterfall(parts: WaterfallPart[]): WaterfallStep[] {
  let sum = 0
  const out: WaterfallStep[] = []
  for (const p of parts) {
    if ('total' in p) {
      out.push({ label: p.label, value: sum, start: 0, end: sum, kind: 'total' })
      continue
    }
    if (!Number.isFinite(p.value)) continue
    out.push({ label: p.label, value: p.value, start: sum, end: sum + p.value, kind: p.value < 0 ? 'down' : 'up' })
    sum += p.value
  }
  return out
}

/** Scale of the chart: from the lowest to the highest point reached, zero always included. */
export function waterfallRange(steps: WaterfallStep[]): { lo: number; hi: number } {
  const xs = steps.flatMap((s) => [s.start, s.end])
  const lo = Math.min(0, ...xs)
  const hi = Math.max(0, ...xs)
  return hi > lo ? { lo, hi } : { lo: lo - 0.01, hi: hi + 0.01 }
}
