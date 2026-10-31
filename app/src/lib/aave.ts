/** Decoding of Aave v3 reserve configuration bitmaps and rates. */

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
  }
}

const RAY = 10n ** 27n
const SECONDS_PER_YEAR = 31_536_000

/** Aave rates are APRs in ray; convert to a compounded APY (as a fraction). */
export function rayAprToApy(rate: bigint): number {
  const apr = Number((rate * 10n ** 9n) / RAY) / 1e9
  return Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1
}
