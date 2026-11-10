import { breakEvenBorrowApy, daysToLiquidationByInterest, hfAfterDays, hfAfterDrop } from '../lib/economics'
import { fmtHf, fmtPct } from '../lib/format'
import { apyTone, hfTone } from '../lib/tone'
import { WINDOWS, type Window } from '../lib/rateHistory'
import { Fold } from './ui'

const DROPS = [0.01, 0.02, 0.05, 0.1]

type Props = {
  collateral: string
  debt: string
  healthFactor: number
  leverage: number
  /** collateral yield: Aave rate plus the token's intrinsic yield */
  supplyApy: number
  /** Aave borrow rate of the debt asset */
  borrowApy: number
  /** intrinsic yield of a yield-bearing debt asset, which the debt also accrues */
  debtNativeApy?: number
  rewardsApy: number
  correlated: boolean
  /** net APY today, and priced on the 7- and 30-day average Aave rates when they could be read */
  apy?: number
  averageApy?: Partial<Record<Window, number>>
  /** a Pendle PT: days to maturity and the health factor then (Aave's PT price at par, debt grown) */
  maturity?: { days: number; healthFactor: number }
}

/** What would hurt the loop: a price move, a rate rise, or simply time while interest accrues. */
export function RiskPanel({
  collateral,
  debt,
  healthFactor,
  leverage,
  supplyApy,
  borrowApy,
  debtNativeApy = 0,
  rewardsApy,
  correlated,
  apy,
  averageApy = {},
  maturity,
}: Props) {
  const hfClass = (hf: number) => hfTone(hf, correlated)
  if (!Number.isFinite(healthFactor)) return null
  // the thresholds are on the Aave borrow rate: the debt's own yield is already a cost on top of it
  const zeroWith = breakEvenBorrowApy(leverage, supplyApy, rewardsApy) - debtNativeApy
  const zeroWithout = breakEvenBorrowApy(leverage, supplyApy) - debtNativeApy
  const debtGrowth = borrowApy + debtNativeApy
  const liqDays = daysToLiquidationByInterest(healthFactor, supplyApy, debtGrowth)
  return (
    <Fold
      title="Risques"
      value={`${collateral} −5 % : ${hfAfterDrop(healthFactor, 0.05) < 1 ? 'liquidé' : `HF ${fmtHf(hfAfterDrop(healthFactor, 0.05))}`} · APY nul si emprunt à ${fmtPct(zeroWith)}`}
    >
      <table className="reserves risk">
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
            <th colSpan={DROPS.length + 1}>
              Taux d’emprunt {debt} qui rend l’APY nul (aujourd’hui {fmtPct(borrowApy)})
            </th>
          </tr>
          <tr>
            <td colSpan={2} className={zeroWith <= borrowApy ? 'bad' : undefined}>
              avec Merkl : {fmtPct(zeroWith)}
            </td>
            <td colSpan={3} className={zeroWithout <= borrowApy ? 'bad' : undefined}>
              sans Merkl : {fmtPct(zeroWithout)}
            </td>
          </tr>
          {apy !== undefined && WINDOWS.some((w) => averageApy[w] !== undefined) && (
            <>
              <tr>
                <th colSpan={DROPS.length + 1}>APY net aux taux moyens d’Aave (aujourd’hui {fmtPct(apy)})</th>
              </tr>
              <tr>
                {WINDOWS.map((w, i) => (
                  <td key={w} colSpan={i === 0 ? 2 : 3} className={apyTone(averageApy[w])}>
                    sur {w} j : {averageApy[w] !== undefined ? fmtPct(averageApy[w]!) : 'non lu'}
                  </td>
                ))}
              </tr>
            </>
          )}
          {maturity && (
            <>
              <tr>
                <th colSpan={DROPS.length + 1}>Health factor à l’échéance du PT, prix Aave au pair et dette aux taux actuels</th>
              </tr>
              <tr>
                <td colSpan={DROPS.length + 1} className={hfClass(maturity.healthFactor)}>
                  dans {Math.max(0, Math.floor(maturity.days))} j : {fmtHf(maturity.healthFactor)}
                </td>
              </tr>
            </>
          )}
          <tr>
            <th colSpan={DROPS.length + 1}>Health factor avec le temps, aux taux actuels, sans réclamer les récompenses</th>
          </tr>
          <tr>
            <td colSpan={2} className={hfClass(hfAfterDays(healthFactor, supplyApy, debtGrowth, 30))}>
              dans 30 j : {fmtHf(hfAfterDays(healthFactor, supplyApy, debtGrowth, 30))}
            </td>
            <td colSpan={2} className={hfClass(hfAfterDays(healthFactor, supplyApy, debtGrowth, 365))}>
              dans 1 an : {fmtHf(Math.max(0, hfAfterDays(healthFactor, supplyApy, debtGrowth, 365)))}
            </td>
            <td className={liqDays < 365 ? 'bad' : undefined}>
              {Number.isFinite(liqDays) ? `liquidation dans ${liqDays > 3650 ? 'plus de 10 ans' : `${Math.floor(liqDays)} j`}` : 'pas d’érosion'}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Le health factor ne suit que les prix oracle d’Aave. Sur une paire de stablecoins, l’oracle peut ignorer une baisse du prix de marché : le risque est
        alors celui de l’émetteur du token.
      </p>
    </Fold>
  )
}
