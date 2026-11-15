import type { V4Setup } from '../../../protocols/aavev4/execute'
import type { V4User } from '../../../protocols/aavev4/state'

/** What the once-per-spoke setup still lacks; everything while the account is not read. Pure, tested. */
export const v4SetupOf = (user?: Pick<V4User, 'giverSet' | 'takerSet' | 'collateralEnabled'>): V4Setup => ({
  giver: !user?.giverSet,
  taker: !user?.takerSet,
  collateral: !user?.collateralEnabled,
})

/** The setup as the « Étapes » list words it: one line, a transaction of its own without atomic batches. */
export function v4SetupSteps(setup: V4Setup, batch: boolean, opts: { collateral?: boolean } = {}): { label: string }[] {
  const managers = setup.giver || setup.taker
  const flag = setup.collateral && opts.collateral !== false
  if (!managers && !flag) return []
  const what = [managers && 'activer les gestionnaires de position d’Aave sur ce spoke', flag && 'marquer la réserve comme collatéral']
    .filter(Boolean)
    .join(', ')
  const text = what.charAt(0).toUpperCase() + what.slice(1)
  return [{ label: batch ? text : `${text} (transaction, une fois par spoke)` }]
}
