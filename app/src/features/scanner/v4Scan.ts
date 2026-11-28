/**
 * Scanner rows for Aave v4, read-only (O3): every collateral × borrowable pair of a spoke, looped at the leverage that
 * gives a target health factor. A v4 position lives in one spoke; its borrow rate is the reserve's base rate plus the
 * user's risk premium, which a single collateral sets (`collateralRisk`, a share of the base rate). Pure, tested.
 */
import { v4EndingRewards, type V4Reserve } from '../../protocols/aavev4/reserves'
import { isCorrelated, isUsdStable } from '../../domain/pairs'
import { MAX_SCAN_LEVERAGE, MIN_SCAN_LEVERAGE } from './aaveScan'
import { rateOf } from '../../domain/irm'
import { v4AdjustedRates } from '../../protocols/aavev4/state'

/** Same ceiling as the sliders of the app: the leverage at a health factor of 1.02, at most 15x. */
const SLIDER_HF = 1.02

export type V4ScanRow = {
  collateral: V4Reserve
  debt: V4Reserve
  leverage: number
  /** unlevered legs: lending rate + the token's own yield; base borrow rate × (1 + risk premium) */
  collateralYield: number
  borrowCost: number
  /** the token's own yield, levered */
  nativeApy: number
  /** Merkl on both legs, levered */
  rewardsApy: number
  rewardsEnd?: number
  apy: number
  /** with an amount: the APY at today's rates, before this loop's own effect on them */
  apyBefore?: number
  /** A5: the APY once the rewards with a known end are over */
  apyAfterRewards: number
  /** equity that can still be looped before the debt runs out or the collateral reaches its cap, USD */
  capacityUsd: number
  stable: boolean
  correlated: boolean
  /** a PT: the API gives no yield for it, so the row undercounts */
  nativeUnknown: boolean
}

/** HF = CF × L / (L − 1), so L = HF / (HF − CF); capped at the leverage of a health factor of 1.02 and at 15x. */
export function v4LeverageAtHf(collateralFactor: number, targetHf: number): number {
  const at = (hf: number) => (hf > collateralFactor ? hf / (hf - collateralFactor) : Infinity)
  return Math.min(at(targetHf), at(SLIDER_HF), MAX_SCAN_LEVERAGE)
}

const spokeKey = (r: V4Reserve) => `${r.chainId}:${r.spoke.address.toLowerCase()}`

/** `equityUsd`: capital to loop; the rates are then the ones right after this loop (the hub's curve, irm.ts) */
export function scanV4(reserves: V4Reserve[], opts: { targetHf: number; equityUsd?: number }): V4ScanRow[] {
  const E = opts.equityUsd ?? 0
  const spokes = new Map<string, V4Reserve[]>()
  for (const r of reserves) spokes.set(spokeKey(r), [...(spokes.get(spokeKey(r)) ?? []), r])
  const rows: V4ScanRow[] = []
  for (const list of spokes.values())
    for (const C of list) {
      if (!C.canCollateral || C.price <= 0n) continue
      const leverage = v4LeverageAtHf(C.collateralFactor, opts.targetHf)
      if (!(leverage >= MIN_SCAN_LEVERAGE)) continue
      for (const D of list) {
        if (!D.canBorrow || D.price <= 0n || D.token.address.toLowerCase() === C.token.address.toLowerCase()) continue
        const rates = v4AdjustedRates(C, D, C.collateralRisk, E > 0 ? { supply: leverage * E, borrow: (leverage - 1) * E } : {})
        const collateralYield = rateOf(rates.supply) + C.underlyingApy
        const borrowCost = rateOf(rates.borrow)
        const rewardsApy = C.supplyRewardApy * leverage + D.borrowRewardApy * (leverage - 1)
        const ending = v4EndingRewards(C, D, leverage)
        const apy = collateralYield * leverage - borrowCost * (leverage - 1) + rewardsApy
        const before = (rates.supply.now + C.underlyingApy) * leverage - rates.borrow.now * (leverage - 1) + rewardsApy
        rows.push({
          collateral: C,
          debt: D,
          leverage,
          collateralYield,
          borrowCost,
          nativeApy: C.underlyingApy * leverage,
          rewardsApy,
          rewardsEnd: ending.endsAt,
          apy,
          apyBefore: E > 0 ? before : undefined,
          apyAfterRewards: apy - ending.apy,
          capacityUsd: Math.max(0, Math.min(D.borrowableUsd / (leverage - 1), C.suppliableUsd / leverage)),
          stable: isUsdStable(C) && isUsdStable(D),
          correlated: isCorrelated(C, D),
          nativeUnknown: /^PT[\s-]/i.test(C.token.symbol),
        })
      }
    }
  return rows
}
