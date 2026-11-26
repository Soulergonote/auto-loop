import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { MARKETS, getMarket } from '../config'
import { decodeSnapshot, encodeSnapshot } from './snapshotCodec'
import { SNAPSHOT_MAX_AGE_MS, scannerSnapshotAt, seedSnapshot } from './scannerSnapshot'

describe('scanner snapshot (D1)', () => {
  const market = getMarket(MARKETS.find((m) => !m.soon)!.id)
  const data = { market, reserves: [{ cashBase: 123456789012345678901234n, apy: 0.05 }], pts: new Map([['0xabc', { expiry: 1n }]]) }

  it('round-trips bigints, maps and markets through JSON', () => {
    const back = decodeSnapshot<typeof data>(encodeSnapshot(data))
    expect(back.reserves[0].cashBase).toBe(123456789012345678901234n)
    expect(back.pts.get('0xabc')).toEqual({ expiry: 1n })
    expect(back.market).toEqual(market)
    expect(encodeSnapshot(back)).toBe(encodeSnapshot(data))
  })

  it('seeds empty queries dated from the snapshot, leaves live data alone', () => {
    const client = new QueryClient()
    client.setQueryData(['live'], 'fresh')
    const at = Date.now() - 30 * 60_000
    const ok = seedSnapshot(client, {
      version: 1,
      at,
      entries: [
        { key: ['snapshot', 'x'], data: 1 },
        { key: ['live'], data: 'old' },
      ],
    })
    expect(ok).toBe(true)
    expect(client.getQueryData(['snapshot', 'x'])).toBe(1)
    expect(client.getQueryState(['snapshot', 'x'])!.dataUpdatedAt).toBe(at)
    expect(client.getQueryData(['live'])).toBe('fresh')
    expect(scannerSnapshotAt()).toBe(at)
  })

  it('ignores an old snapshot or another version', () => {
    const client = new QueryClient()
    const entries = [{ key: ['k'], data: 1 }]
    expect(seedSnapshot(client, { version: 1, at: Date.now() - SNAPSHOT_MAX_AGE_MS - 1, entries })).toBe(false)
    expect(seedSnapshot(client, { version: 2, at: Date.now(), entries })).toBe(false)
    expect(client.getQueryData(['k'])).toBeUndefined()
  })
})
