/**
 * The net APY of a loop, one line per contribution (Scanner « Détail »): what each leg earns or costs unlevered, the
 * leverage it applies to, and its share of the net APY. Rates are fractions. Pure, tested.
 */
export type ApyParts = {
  leverage: number
  /** lending rate of the collateral (none on Morpho: collateral is not lent) */
  deposit: number
  /** the collateral token's own yield (wstETH, sUSDe…), or a PT's fixed rate */
  native: number
  /** `native` is a PT's fixed rate */
  nativeFixed?: boolean
  /** borrow rate of the debt, before any premium */
  borrow: number
  /** Aave v4: what the collateral's risk premium adds to the borrow rate */
  riskPremium?: number
  /** own yield of a yield-bearing debt token: the debt grows by it */
  debtNative?: number
  /** Merkl of the whole loop, already levered */
  rewards: number
}

export type ApyLine = { label: string; /** unlevered rate and its multiplier, when the line has them */ rate?: number; factor?: number; value: number }

/** One line per contribution that is not zero (deposit and borrow always shown when they exist), then their sum. */
export function apyLines(p: ApyParts, opts: { lends: boolean }): { lines: ApyLine[]; total: number } {
  const L = p.leverage
  const lines: ApyLine[] = []
  const add = (label: string, rate: number, factor: number, sign: 1 | -1, always = false) => {
    if (rate !== 0 || always) lines.push({ label, rate, factor, value: sign * rate * factor })
  }
  add('Dépôt du collatéral', p.deposit, L, 1, opts.lends)
  add(p.nativeFixed ? 'Rendement fixe du PT' : 'Rendement du token', p.native, L, 1)
  add('Emprunt', p.borrow, L - 1, -1, true)
  add('Prime de risque', p.riskPremium ?? 0, L - 1, -1)
  add('Rendement du token emprunté', p.debtNative ?? 0, L - 1, -1)
  if (p.rewards !== 0) lines.push({ label: 'Bonus Merkl', value: p.rewards })
  return { lines, total: lines.reduce((s, l) => s + l.value, 0) }
}
