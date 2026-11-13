import { waterfall, type WaterfallPart } from '../../../domain/waterfall'
import { Fold } from '../../../ui/primitives'
import { Waterfall } from '../../../ui/Waterfall'
import { fmtDays, fmtPct, fmtX } from '../../../ui/format'
import { apyTone } from '../../../ui/tone'

type Props = {
  leverage: number
  /** what the collateral earns, per unit (lending rate + own yield, or a PT's fixed yield) */
  collateralYield: number
  collateralLabel: string
  /** rewards on the whole loop, already levered (Merkl on Aave, borrow rewards on Morpho) */
  rewards: number
  rewardsLabel: string
  /** what the debt costs, per unit (borrow rate + the debt token's own yield) */
  borrowCost: number
  debtLabel: string
  /** net APY with the one-off costs spread over the planned duration, when the costs are known */
  withCosts?: number
  /** planned duration in days, or undefined for a PT held to maturity */
  horizon?: number
}

/**
 * Where the net APY comes from (J2): the collateral's yield × L, the rewards, the borrow cost × (L − 1), and the entry
 * and exit costs spread over the planned duration, as a waterfall.
 */
export function ApyBreakdown({ leverage: L, collateralYield, collateralLabel, rewards, rewardsLabel, borrowCost, debtLabel, withCosts, horizon }: Props) {
  if (!Number.isFinite(L) || L < 1) return null
  const net = collateralYield * L + rewards - borrowCost * (L - 1)
  const parts: WaterfallPart[] = [
    { label: `${collateralLabel} × ${fmtX(L)}`, value: collateralYield * L },
    ...(rewards !== 0 ? [{ label: rewardsLabel, value: rewards }] : []),
    { label: `Emprunt ${debtLabel} × ${fmtX(L - 1)}`, value: -borrowCost * (L - 1) },
    { label: 'APY net', total: true },
    ...(withCosts !== undefined && Number.isFinite(withCosts)
      ? [
          { label: horizon !== undefined ? `Coûts sur ${fmtDays(horizon)}` : 'Coûts jusqu’à l’échéance', value: withCosts - net },
          { label: 'APY coûts compris', total: true } as const,
        ]
      : []),
  ]
  return (
    <Fold
      title="Décomposition de l’APY"
      value={
        <>
          <span className={apyTone(net)}>{fmtPct(net)}</span> net
          {withCosts !== undefined && Number.isFinite(withCosts) && (
            <>
              {' · '}
              <span className={apyTone(withCosts)}>{fmtPct(withCosts)}</span> coûts compris
            </>
          )}
        </>
      }
    >
      <Waterfall steps={waterfall(parts)} label="Décomposition de l’APY net, étape par étape" />
      <p className="muted small">
        Le collatéral rapporte sur tout le levier, l’emprunt coûte sur la part empruntée (L − 1). Les coûts d’entrée et de sortie (swaps, gas) sont répartis sur
        la durée prévue{horizon === undefined ? ', ici jusqu’à l’échéance du PT' : ''}.
      </p>
    </Fold>
  )
}
