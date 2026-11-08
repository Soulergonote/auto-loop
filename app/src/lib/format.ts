/**
 * Every number shown in the app goes through here, so that the formats of the UI charter hold everywhere:
 * decimal comma, narrow no-break space between thousands, no-break space before units, true minus sign.
 */
import { formatUnits } from 'viem'

/** no-break space, before "$", "%", "j" */
export const NBSP = ' '
const MINUS = '−'

const nf = (max: number, min = 0) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: max, minimumFractionDigits: min })
/** fr-FR already groups thousands with a narrow no-break space; only the minus sign needs fixing */
const minus = (s: string) => s.replace(/^-/, MINUS)
const num = (x: number, max: number, min = 0) => minus(nf(max, min).format(x))

/** Token amount: 4 decimals from 1, 4 significant digits below. `max` caps the decimals (8 to fill an input). */
export function fmtAmount(amount: bigint, decimals: number, max?: number): string {
  const n = Number(formatUnits(amount, decimals))
  if (max !== undefined) return num(n, max)
  if (n === 0 || Math.abs(n) >= 1) return num(n, 4)
  return minus(new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 4 }).format(n))
}

/** Dollars with 2 decimals (`compact`: k / M from 10 000 $, for tables). */
export function fmtDollars(usd: number, compact = false): string {
  if (!Number.isFinite(usd)) return '—'
  if (compact && Math.abs(usd) >= 10_000) {
    const [v, unit] = Math.abs(usd) >= 1e6 ? [usd / 1e6, 'M'] : [usd / 1e3, 'k']
    return `${num(v, 1)}${NBSP}${unit}${NBSP}$`
  }
  return `${num(usd, 2, 2)}${NBSP}$`
}

/** Oracle base units (8 decimals, USD on Aave v3). */
export const fmtUsd = (base: bigint, compact = false) => fmtDollars(Number(base) / 1e8, compact)

/** Oracle price: 4 decimals under 10 $, so that a stablecoin's depeg shows. */
export function fmtPrice(base: bigint): string {
  const n = Number(base) / 1e8
  return n < 10 ? `${num(n, 4, 2)}${NBSP}$` : fmtDollars(n)
}

/** Fraction as a percentage: 2 decimals (0 for LTV and liquidation thresholds). */
export const fmtPct = (x: number, digits = 2) => (Number.isFinite(x) ? `${num(x * 100, digits)}${NBSP}%` : '∞')

export const fmtHf = (x: number) => (Number.isFinite(x) ? num(x, 2) : '∞')

export const fmtX = (x: number) => (Number.isFinite(x) ? `${num(x, 2)}x` : '∞')

/** Plain number (Merkl reward amounts…): 4 decimals, none from 100. */
export const fmtNum = (x: number) => num(x, Math.abs(x) >= 100 ? 0 : 4)

/** Unix seconds: "11 nov.", with the year when it is not the current one. */
export function fmtDate(seconds: number, now = new Date()): string {
  const d = new Date(seconds * 1000)
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) }).format(d)
}

/** Holding time: days under 6 months, months above. */
export const fmtDays = (days: number) =>
  days < 180 ? `${days}${NBSP}j` : days < 365 ? `${Math.round(days / 30)}${NBSP}mois` : days === 365 ? '1 an' : `${num(days / 365, 1)} ans`

/** "0x6A00…1068": 0x, the next 4 characters, the last 4. */
export const fmtAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Time to a PT's maturity: "J−32", "J−0" on the day, "échu" after. */
export function fmtMaturity(expirySec: number, nowSec = Date.now() / 1000): string {
  const days = (expirySec - nowSec) / 86_400
  return days > 0 ? `J${MINUS}${Math.floor(days)}` : 'échu'
}
