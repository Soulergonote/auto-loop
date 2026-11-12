import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SCANNER, bestPair, cleanScanner, loadScanner, savePair, saveScanner, savedPair, scannerFromQuery, scannerQuery } from './prefs'
import type { ScanRow } from './aaveScan'

function fakeStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

describe('scanner filters in the address', () => {
  it('writes nothing for the defaults', () => {
    expect(scannerQuery(DEFAULT_SCANNER)).toBe('')
    expect(scannerFromQuery('')).toBeUndefined()
  })

  it('round-trips every filter', () => {
    const p = { protocol: 'aave', scope: 9745, hf: '1.2', filter: 'stable', negative: true } as const
    const q = scannerQuery(p)
    expect(q).toBe('protocole=aave&reseau=9745&hf=1.2&paires=stables&negatifs=1')
    expect(scannerFromQuery(q)).toEqual(p)
  })

  it('drops what it does not know', () => {
    expect(scannerFromQuery('protocole=euler&reseau=abc&hf=9&paires=x')).toEqual(DEFAULT_SCANNER)
    expect(cleanScanner({ scope: -1, negative: 'yes' })).toEqual(DEFAULT_SCANNER)
  })
})

describe('remembered in the browser', () => {
  beforeEach(() => void ((globalThis as { localStorage?: unknown }).localStorage = fakeStorage()))
  afterEach(() => void delete (globalThis as { localStorage?: unknown }).localStorage)

  it('keeps the last pair of each network', () => {
    expect(savedPair('base')).toBeUndefined()
    savePair('base', 'wstETH', 'WETH')
    savePair('plasma', 'USDe', 'GHO')
    expect(savedPair('base')).toEqual({ collateral: 'wstETH', debt: 'WETH' })
    expect(savedPair('plasma')).toEqual({ collateral: 'USDe', debt: 'GHO' })
  })

  it('ignores garbage', () => {
    localStorage.setItem('auto-loop.pairs', '{"base":{"collateral":1}}')
    expect(savedPair('base')).toBeUndefined()
    localStorage.setItem('auto-loop.scanner', 'not json')
    expect(loadScanner('#scanner')).toEqual(DEFAULT_SCANNER)
  })

  it('prefers a shared link to the saved filters', () => {
    saveScanner({ ...DEFAULT_SCANNER, hf: '1.5' })
    expect(loadScanner('#scanner').hf).toBe('1.5')
    expect(loadScanner('#scanner?hf=1.05').hf).toBe('1.05')
  })

  it('works without storage', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(savedPair('base')).toBeUndefined()
    expect(() => savePair('base', 'a', 'b')).not.toThrow()
  })
})

describe('pair the Boucle opens on', () => {
  const row = (apy: number, correlated = true, flags: ScanRow['flags'] = []) => ({ apy, correlated, flags }) as ScanRow
  it('takes the best correlated pair with a positive yield and room', () => {
    const rows = [row(0.3, false), row(0.2, true, ['lowCapacity']), row(0.08), row(0.12), row(-0.01)]
    expect(bestPair(rows)?.apy).toBe(0.12)
  })
  it('gives none when nothing pays', () => {
    expect(bestPair([row(-0.02), row(0.5, false)])).toBeUndefined()
  })
})
