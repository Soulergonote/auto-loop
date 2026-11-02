import { breakEvenBorrowApy, daysToLiquidationByInterest, hfAfterDays, hfAfterDrop } from '../lib/economics'
import { fmtHf, fmtPct } from '../lib/format'

const DROPS = [0.01, 0.02, 0.05, 0.1]

type Props = {
  collateral: string
  debt: string
  healthFactor: number
  leverage: number
  supplyApy: number
  borrowApy: number
  rewardsApy: number
}

const hfClass = (hf: number) => (hf < 1 ? 'bad' : hf < 1.1 ? 'warn' : undefined)

/** What would hurt the loop: a price move, a rate rise, or simply time while interest accrues. */
export function RiskPanel({ collateral, debt, healthFactor, leverage, supplyApy, borrowApy, rewardsApy }: Props) {
  if (!Number.isFinite(healthFactor)) return null
  const zeroWith = breakEvenBorrowApy(leverage, supplyApy, rewardsApy)
  const zeroWithout = breakEvenBorrowApy(leverage, supplyApy)
  const liqDays = daysToLiquidationByInterest(healthFactor, supplyApy, borrowApy)
  return (
    <details className="risk" open>
      <summary>Risques</summary>
      <table className="reserves">
        <tbody>
          <tr>
            <th colSpan={DROPS.length + 1}>
              Health factor si {collateral} baisse face à {debt} (aujourd’hui {fmtHf(healthFactor)})
            </th>
          </tr>
          <tr>
            {DROPS.map((d) => {
              const hf = hfAfterDrop(healthFactor, d)
              return (
                <td key={d} className={hfClass(hf)}>
                  −{fmtPct(d, 0)} : {hf < 1 ? 'liquidé' : fmtHf(hf)}
                </td>
              )
            })}
            <td />
          </tr>
          <tr>
            <th colSpan={DROPS.length + 1}>Taux d’emprunt {debt} qui rend l’APY nul (aujourd’hui {fmtPct(borrowApy)})</th>
          </tr>
          <tr>
            <td colSpan={2} className={zeroWith <= borrowApy ? 'bad' : undefined}>
              avec Merkl : {fmtPct(zeroWith)}
            </td>
            <td colSpan={3} className={zeroWithout <= borrowApy ? 'bad' : undefined}>
              sans Merkl : {fmtPct(zeroWithout)}
            </td>
          </tr>
          <tr>
            <th colSpan={DROPS.length + 1}>Health factor avec le temps, aux taux actuels, sans réclamer les rewards</th>
          </tr>
          <tr>
            <td colSpan={2} className={hfClass(hfAfterDays(healthFactor, supplyApy, borrowApy, 30))}>
              dans 30 j : {fmtHf(hfAfterDays(healthFactor, supplyApy, borrowApy, 30))}
            </td>
            <td colSpan={2} className={hfClass(hfAfterDays(healthFactor, supplyApy, borrowApy, 365))}>
              dans 1 an : {fmtHf(Math.max(0, hfAfterDays(healthFactor, supplyApy, borrowApy, 365)))}
            </td>
            <td className={liqDays < 365 ? 'bad' : undefined}>
              {Number.isFinite(liqDays) ? `liquidation dans ${liqDays > 3650 ? 'plus de 10 ans' : `${Math.floor(liqDays)} j`}` : 'pas d’érosion'}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Le health factor ne tient compte que des prix oracle d’Aave. Sur une paire de stablecoins, l’oracle peut ignorer une baisse du prix de marché :
        le risque est alors celui de l’émetteur du token, pas la liquidation.
      </p>
    </details>
  )
}
