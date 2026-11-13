/** Decoding of Aave v3 reserve configuration bitmaps and rates. */
import type { EModeCategory } from './useMarket'

const bits = (data: bigint, start: number, size: number) => (data >> BigInt(start)) & ((1n << BigInt(size)) - 1n)

export type ReserveConfig = {
  ltvBps: number
  liquidationThresholdBps: number
  liquidationBonusBps: number
  decimals: number
  active: boolean
  frozen: boolean
  borrowingEnabled: boolean
  paused: boolean
  flashLoanEnabled: boolean
  /** non-zero debt ceiling = isolated asset */
  isolated: boolean
  /** caps in whole tokens, 0 = none */
  borrowCap: bigint
  supplyCap: bigint
}

export function decodeReserveConfig(data: bigint): ReserveConfig {
  return {
    ltvBps: Number(bits(data, 0, 16)),
    liquidationThresholdBps: Number(bits(data, 16, 16)),
    liquidationBonusBps: Number(bits(data, 32, 16)),
    decimals: Number(bits(data, 48, 8)),
    active: bits(data, 56, 1) === 1n,
    frozen: bits(data, 57, 1) === 1n,
    borrowingEnabled: bits(data, 58, 1) === 1n,
    paused: bits(data, 60, 1) === 1n,
    flashLoanEnabled: bits(data, 63, 1) === 1n,
    isolated: bits(data, 212, 40) !== 0n,
    borrowCap: bits(data, 80, 36),
    supplyCap: bits(data, 116, 36),
  }
}

const RAY = 10n ** 27n
const SECONDS_PER_YEAR = 31_536_000

/** Aave rates are APRs in ray; convert to a compounded APY (as a fraction). */
export function rayAprToApy(rate: bigint): number {
  const apr = Number((rate * 10n ** 9n) / RAY) / 1e9
  return Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1
}

/** eMode category of a reserve in a pool before Aave v3.2 (configuration bits 168-175; 0 = none). */
export const legacyEModeOf = (configuration: bigint) => Number(bits(configuration, 168, 8))

export type LegacyEModeData = { ltv: number; liquidationThreshold: number; liquidationBonus: number; label: string }

/**
 * eMode categories of a pool before Aave v3.2 (SparkLend, older forks), in the v3.2 shape the app works with: each
 * reserve belongs to at most one category, which is both where it counts with the category's LTV and what an account
 * in that category may borrow (when the reserve allows borrowing). `data[i]` is getEModeCategoryData(i + 1).
 */
export function legacyEModes(data: (LegacyEModeData | undefined)[], reserves: { id: number; configuration: bigint }[]): EModeCategory[] {
  const out: EModeCategory[] = []
  data.forEach((d, i) => {
    if (!d || d.liquidationThreshold === 0) return
    const id = i + 1
    let collateralBitmap = 0n
    let borrowableBitmap = 0n
    for (const r of reserves) {
      if (legacyEModeOf(r.configuration) !== id) continue
      collateralBitmap |= 1n << BigInt(r.id)
      if (decodeReserveConfig(r.configuration).borrowingEnabled) borrowableBitmap |= 1n << BigInt(r.id)
    }
    out.push({
      id,
      label: d.label || `catégorie ${id}`,
      ltvBps: d.ltv,
      liquidationThresholdBps: d.liquidationThreshold,
      liquidationBonusBps: d.liquidationBonus,
      collateralBitmap,
      borrowableBitmap,
      ltvZeroBitmap: 0n,
    })
  })
  return out
}
