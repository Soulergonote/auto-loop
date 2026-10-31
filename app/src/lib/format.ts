import { formatUnits } from 'viem'

const nf = (max: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: max })

export function fmtAmount(amount: bigint, decimals: number, max = 6): string {
  const n = Number(formatUnits(amount, decimals))
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : max
  return nf(digits).format(n)
}

/** Oracle base units (8 decimals, USD on Aave v3). */
export function fmtUsd(base: bigint): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(
    Number(base) / 1e8,
  )
}

export function fmtPrice(base: bigint): string {
  const n = Number(base) / 1e8
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 10 ? 4 : 2 }).format(n)
}

export const fmtPct = (x: number, digits = 2) =>
  Number.isFinite(x) ? `${nf(digits).format(x * 100)} %` : '∞'

export const fmtHf = (x: number) => (Number.isFinite(x) ? nf(2).format(x) : '∞')

export const fmtX = (x: number) => (Number.isFinite(x) ? `${nf(2).format(x)}x` : '∞')
