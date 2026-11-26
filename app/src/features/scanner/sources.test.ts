import { describe, expect, it } from 'vitest'
import { networkProgress, sourceStatus } from './sources'

describe('networkProgress', () => {
  it('merges the sources of a network, worst state first', () => {
    expect(
      networkProgress([
        { label: 'Ethereum', pending: false, failed: false },
        { label: 'Ethereum', pending: true, failed: false },
        { label: 'Base', pending: false, failed: false },
        { label: 'Base', pending: false, failed: true },
        { label: 'Plasma', pending: false, failed: false },
      ]),
    ).toEqual([
      { label: 'Ethereum', state: 'pending' },
      { label: 'Base', state: 'failed' },
      { label: 'Plasma', state: 'read' },
    ])
  })
})

describe('sourceStatus', () => {
  const networks = [
    { label: 'Ethereum', state: 'read' as const },
    { label: 'Base', state: 'read' as const },
    { label: 'Sonic', state: 'failed' as const },
  ]
  it('names what failed and what did not answer', () => {
    const s = sourceStatus({ networks, readAt: 0, silent: ['Pendle', false, undefined] })
    expect(s).toBe('2 réseaux lus · en échec : Sonic · sans réponse : Pendle')
  })
  it('gives the time of the reading', () => {
    expect(sourceStatus({ networks: [networks[0]], readAt: Date.UTC(2026, 10, 15, 14, 32), silent: [] })).toMatch(/^1 réseau lu à \d\d:\d\d$/)
  })
  it('says the snapshot is shown while networks are read again (D1)', () => {
    const at = Date.UTC(2026, 10, 26, 14, 0)
    expect(sourceStatus({ networks, readAt: at, silent: [], snapshot: { at, networks: 3 } })).toMatch(
      /^instantané de \d\d:\d\d · 3 réseaux en relecture · en échec : Sonic$/,
    )
    expect(sourceStatus({ networks: [networks[0]], readAt: at, silent: [], snapshot: { at, networks: 0 } })).toMatch(/^1 réseau lu à/)
  })
  it('is undefined while nothing is read', () => {
    expect(sourceStatus({ networks: [{ label: 'Base', state: 'pending' }], readAt: 0, silent: [] })).toBeUndefined()
  })
})
