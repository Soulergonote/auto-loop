/**
 * What the app remembers in this browser, and the Scanner's filters in the page address. Browser storage can be
 * missing (private window) or hold anything: every read is checked and falls back to the default.
 */
import type { ScanRow } from './scan'

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // not remembered, nothing else changes
  }
}

/* ---------- last pair of each network (Boucle) ---------- */

const PAIRS_KEY = 'auto-loop.pairs'
type SavedPair = { collateral: string; debt: string }

/** last pair opened on a network, by token symbol (an address could be re-listed, a symbol reads the same) */
export function savedPair(marketId: string): SavedPair | undefined {
  const all = readJson(PAIRS_KEY)
  const p = all && typeof all === 'object' ? (all as Record<string, unknown>)[marketId] : undefined
  if (!p || typeof p !== 'object') return undefined
  const { collateral, debt } = p as Record<string, unknown>
  return typeof collateral === 'string' && typeof debt === 'string' ? { collateral, debt } : undefined
}

export function savePair(marketId: string, collateral: string, debt: string) {
  const all = readJson(PAIRS_KEY)
  const next = all && typeof all === 'object' ? { ...(all as object) } : {}
  writeJson(PAIRS_KEY, { ...next, [marketId]: { collateral, debt } })
}

/** same threshold as the scanner's « presque plein » tag: 50 000 $ of equity, oracle base units */
export const BEST_MIN_CAPACITY = 50_000n * 10n ** 8n

/**
 * The pair the Boucle opens on when nothing was picked on this network yet: the best correlated pair the scanner
 * finds there, with a positive yield and room to loop. None: the market's usual default.
 */
export function bestPair(rows: ScanRow[]): ScanRow | undefined {
  return rows.filter((r) => r.correlated && r.apy > 0 && !r.flags.includes('lowCapacity')).sort((a, b) => b.apy - a.apy)[0]
}

/* ---------- Scanner filters ---------- */

export const SCAN_HFS = ['1.05', '1.1', '1.2', '1.5'] as const
export const SCAN_FILTERS = ['correlated', 'stable', 'all'] as const
export const SCAN_PROTOCOLS = ['all', 'aave', 'morpho'] as const

export type ScannerPrefs = {
  protocol: (typeof SCAN_PROTOCOLS)[number]
  /** chain id, or all networks */
  scope: number | 'all'
  hf: (typeof SCAN_HFS)[number]
  filter: (typeof SCAN_FILTERS)[number]
  negative: boolean
}

export const DEFAULT_SCANNER: ScannerPrefs = { protocol: 'all', scope: 'all', hf: '1.1', filter: 'correlated', negative: false }

const SCANNER_KEY = 'auto-loop.scanner'
/** French names in the address: #scanner?protocole=aave&reseau=8453&hf=1.2&paires=stables&negatifs=1 */
const FILTER_NAMES: Record<ScannerPrefs['filter'], string> = { correlated: 'correlees', stable: 'stables', all: 'toutes' }

const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined => ((list as readonly unknown[]).includes(v) ? (v as T) : undefined)

/** keeps only what is valid; anything else takes the default */
export function cleanScanner(raw: Partial<Record<keyof ScannerPrefs, unknown>> | undefined): ScannerPrefs {
  const r = raw ?? {}
  const scope = typeof r.scope === 'number' && Number.isInteger(r.scope) && r.scope > 0 ? r.scope : 'all'
  return {
    protocol: pick(SCAN_PROTOCOLS, r.protocol) ?? DEFAULT_SCANNER.protocol,
    scope,
    hf: pick(SCAN_HFS, r.hf) ?? DEFAULT_SCANNER.hf,
    filter: pick(SCAN_FILTERS, r.filter) ?? DEFAULT_SCANNER.filter,
    negative: r.negative === true,
  }
}

/** the filters named in the address after "#scanner?", if any */
export function scannerFromQuery(query: string): ScannerPrefs | undefined {
  if (!query) return undefined
  const q = new URLSearchParams(query)
  if ([...q.keys()].length === 0) return undefined
  const filterName = q.get('paires')
  const reseau = Number(q.get('reseau'))
  return cleanScanner({
    protocol: q.get('protocole') ?? undefined,
    scope: Number.isInteger(reseau) && reseau > 0 ? reseau : undefined,
    hf: q.get('hf') ?? undefined,
    filter: (Object.keys(FILTER_NAMES) as ScannerPrefs['filter'][]).find((k) => FILTER_NAMES[k] === filterName),
    negative: q.get('negatifs') === '1',
  })
}

/** the address query for these filters; empty when they are all the defaults */
export function scannerQuery(p: ScannerPrefs): string {
  const q = new URLSearchParams()
  if (p.protocol !== DEFAULT_SCANNER.protocol) q.set('protocole', p.protocol)
  if (p.scope !== 'all') q.set('reseau', String(p.scope))
  if (p.hf !== DEFAULT_SCANNER.hf) q.set('hf', p.hf)
  if (p.filter !== DEFAULT_SCANNER.filter) q.set('paires', FILTER_NAMES[p.filter])
  if (p.negative) q.set('negatifs', '1')
  return q.toString()
}

/** filters to start with: the address first (a shared link), then this browser's last ones */
export function loadScanner(hash = typeof window === 'undefined' ? '' : window.location.hash): ScannerPrefs {
  const i = hash.indexOf('?')
  return (i >= 0 ? scannerFromQuery(hash.slice(i + 1)) : undefined) ?? cleanScanner(readJson(SCANNER_KEY) as Partial<Record<keyof ScannerPrefs, unknown>>)
}

export const saveScanner = (p: ScannerPrefs) => writeJson(SCANNER_KEY, p)
