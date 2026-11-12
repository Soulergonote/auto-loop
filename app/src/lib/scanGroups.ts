/**
 * Scanner lines grouped by pair: several Morpho markets for the same collateral and loan on one network (different
 * LLTVs or oracles) read as one line, the best one in front and the others one click away.
 */
export type Groupable = { group: string; apy: number }

export type Group<T extends Groupable> = { head: T; variants: T[] }

/** Groups in the order of their first line; the head is the line with the best APY, the others follow by APY. */
export function groupLines<T extends Groupable>(lines: T[]): Group<T>[] {
  const byKey = new Map<string, T[]>()
  for (const l of lines) {
    const g = byKey.get(l.group)
    if (g) g.push(l)
    else byKey.set(l.group, [l])
  }
  return [...byKey.values()].map((g) => {
    const sorted = [...g].sort((a, b) => b.apy - a.apy)
    return { head: sorted[0], variants: sorted.slice(1) }
  })
}

/** What a loop of this pair earns per unit of leverage: collateral yield minus the cost of the debt, before leverage and bonuses. */
export const spreadOf = (l: { collateralYield: number; borrowCost: number }) => l.collateralYield - l.borrowCost
