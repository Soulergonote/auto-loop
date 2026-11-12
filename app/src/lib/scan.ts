/**
 * Opportunity scanner: every collateral / debt pair of a market, looped at the leverage that gives a target health
 * factor, ranked by yield on equity (Aave rates + intrinsic yield of yield-bearing tokens + the Merkl campaigns the
 * position would qualify for).
 * Pure functions over a market snapshot, so they can be tested without a chain.
 */
import { maxLeverage, netApy } from './math'
import { campaignYields, campaignsForPair, daysLeft, eligibleForPosition, type Campaign } from './merkl'
import { loopNativeApy } from './nativeYield'
import { eligibleEModes, type EModeCategory } from './useMarket'
import type { Snapshot, SnapReserve } from './snapshot'

/** Same ceiling as the leverage slider of the open panel: 95 % of the LTV maximum, at most 15x. */
export const MAX_SCAN_LEVERAGE = 15
const LTV_MARGIN = 0.95
/** Below this the loop is not worth a flash loan and two swaps. */
export const MIN_SCAN_LEVERAGE = 1.05

/**
 * Leverage of a loop (collateral = L x equity, debt = (L - 1) x equity in value) whose health factor is
 * `targetHf`: HF = LT x L / (L - 1), so L = HF / (HF - LT). Capped like the open panel's slider, and never above
 * what the LTV lets Aave mint.
 */
export function leverageAtHf(liquidationThresholdBps: number, ltvBps: number, targetHf: number): number {
  const lt = liquidationThresholdBps / 10_000
  const byHf = targetHf > lt ? targetHf / (targetHf - lt) : Infinity
  return Math.min(byHf, maxLeverage(ltvBps) * LTV_MARGIN, MAX_SCAN_LEVERAGE)
}

/** Health factor of such a loop at leverage L (Infinity without debt). */
export function hfAtLeverage(liquidationThresholdBps: number, leverage: number): number {
  return leverage <= 1 ? Infinity : ((liquidationThresholdBps / 10_000) * leverage) / (leverage - 1)
}

const NOT_USD = /EUR|GBP|CHF|JPY|XAU|PAXG|GOLD|BTC|ETH|SOL|AVAX|BNB|POL|MATIC|XPL|MON|LINK|AAVE/i

/** USD stablecoin, including yield-bearing ones (sUSDe, sUSDS…): oracle price between 0.95 and 1.35 USD. */
export function isUsdStable(r: Pick<SnapReserve, 'price' | 'token'>): boolean {
  const usd = Number(r.price) / 1e8
  return usd >= 0.95 && usd <= 1.35 && !NOT_USD.test(r.token.symbol)
}

/** What an asset follows, from its symbol: USD stablecoins (by price), EUR, BTC and ETH with their derivatives. */
export function assetFamily(r: Pick<SnapReserve, 'price' | 'token'>): string {
  if (isUsdStable(r)) return 'USD'
  const sym = r.token.symbol.toUpperCase()
  for (const f of ['EUR', 'BTC', 'ETH']) if (sym.includes(f)) return f
  return sym
}

/**
 * Both legs move together: two USD stablecoins, or the same family priced alike (wstETH / WETH, cbBTC / WBTC):
 * a staked derivative is worth a bit more than its base, up to 1.6x. EURC / USDC is not correlated.
 */
export function isCorrelated(C: Pick<SnapReserve, 'price' | 'token'>, D: Pick<SnapReserve, 'price' | 'token'>): boolean {
  if (isUsdStable(C) && isUsdStable(D)) return true
  const ratio = Number(C.price) / Number(D.price)
  return assetFamily(C) === assetFamily(D) && ratio >= 0.97 && ratio <= 1.6
}

/** nativeUnknown: priced above its base like a yield-bearing token, but its adapter gives no rate to count */
export type ScanFlag = 'conditional' | 'nativeUnknown' | 'lowCapacity'

export type ScanRow = {
  marketId: string
  collateral: SnapReserve
  debt: SnapReserve
  emode?: EModeCategory
  leverage: number
  healthFactor: number
  /** yield on equity: Aave rates, intrinsic yield of yield-bearing legs, Merkl campaigns the position qualifies for */
  ratesApy: number
  nativeApy: number
  rewardsApy: number
  apy: number
  /** unlevered legs: collateral supply APY + its own yield, borrow APY − the debt token's own yield (apy = collateralYield × L − borrowCost × (L − 1) + rewardsApy) */
  collateralYield: number
  borrowCost: number
  /** campaigns counted in rewardsApy */
  campaigns: Campaign[]
  /** earliest known end among them, unix seconds */
  rewardsEnd?: number
  /** equity that can still be looped, oracle base units: limited by the debt asset's cash and caps */
  capacityBase: bigint
  stable: boolean
  /** both legs move together (see isCorrelated) */
  correlated: boolean
  flags: ScanFlag[]
}

export type ScanOptions = {
  targetHf: number
  /** equity under which a pair is flagged as nearly full, base units */
  minCapacityBase?: bigint
  nowMs?: number
}

/** A PT is only looped while it can still be bought: before maturity, through a known Pendle market. */
const canBeCollateral = (r: SnapReserve) =>
  r.config.active && !r.config.paused && !r.config.frozen && !r.config.isolated && (!r.pt || (!!r.pt.market && !r.pt.expired && !!r.native))
const canBeBorrowed = (r: SnapReserve) => r.config.active && !r.config.paused && !r.config.frozen && r.config.borrowingEnabled && r.config.flashLoanEnabled

/** What is left under a cap (whole tokens, 0 = none), in base units. */
function roomUnderCap(capTokens: bigint, used: bigint, price: bigint): bigint {
  if (capTokens === 0n) return BigInt(Number.MAX_SAFE_INTEGER) * 10n ** 8n
  const room = capTokens * price - used
  return room > 0n ? room : 0n
}

/** Equity that can be looped at `leverage` before the debt asset runs out of cash / hits its borrow cap or the collateral hits its supply cap. */
export function loopCapacity(C: SnapReserve, D: SnapReserve, leverage: number): bigint {
  const debtRoom = [D.cashBase, roomUnderCap(D.config.borrowCap, D.totalDebtBase, D.price)].reduce((a, b) => (a < b ? a : b))
  const supplyRoom = roomUnderCap(C.config.supplyCap, C.totalSupplyBase, C.price)
  const scale = (x: bigint, f: number) => BigInt(Math.floor(Number(x) / f))
  const byDebt = leverage > 1 ? scale(debtRoom, leverage - 1) : debtRoom
  const bySupply = scale(supplyRoom, leverage)
  return byDebt < bySupply ? byDebt : bySupply
}

/** Best configuration (no eMode, or one of the eligible categories) of every pair of the market. */
export function scanMarket(snapshot: Snapshot, campaigns: Campaign[] | undefined, opts: ScanOptions): ScanRow[] {
  const { reserves, emodes, market } = snapshot
  const nowMs = opts.nowMs ?? Date.now()
  const rows: ScanRow[] = []
  for (const C0 of reserves.filter(canBeCollateral)) {
    for (const D of reserves.filter(canBeBorrowed)) {
      if (D.token.address === C0.token.address) continue
      const configs = [undefined, ...eligibleEModes(emodes, C0, D)]
      const stable = isUsdStable(C0) && isUsdStable(D)
      const correlated = isCorrelated(C0, D)
      let best: ScanRow | undefined
      for (const emode of configs) {
        const C: SnapReserve = emode
          ? {
              ...C0,
              config: {
                ...C0.config,
                ltvBps: emode.ltvBps,
                liquidationThresholdBps: emode.liquidationThresholdBps,
                liquidationBonusBps: emode.liquidationBonusBps,
              },
            }
          : C0
        if (C.config.ltvBps === 0) continue
        const leverage = leverageAtHf(C.config.liquidationThresholdBps, C.config.ltvBps, opts.targetHf)
        if (!(leverage >= MIN_SCAN_LEVERAGE)) continue
        const healthFactor = hfAtLeverage(C.config.liquidationThresholdBps, leverage)
        const ratesApy = netApy(leverage, C.supplyApy, D.borrowApy)
        const nativeApy = loopNativeApy(leverage, C0.native, D.native)
        const { pair } = eligibleForPosition(campaignsForPair(campaigns, C, D), { healthFactor, debtToken: D.variableDebtToken })
        const yields = campaignYields(pair, leverage, C, D).filter((y) => y.apy > 0)
        const rewardsApy = yields.reduce((s, y) => s + y.apy, 0)
        const ends = yields.filter((y) => y.campaign.endsAt !== undefined && daysLeft(y.campaign, nowMs) > 0).map((y) => y.campaign.endsAt!)
        const capacityBase = loopCapacity(C0, D, leverage)
        const flags: ScanFlag[] = []
        if (yields.some((y) => y.campaign.conditional)) flags.push('conditional')
        // priced above what it is borrowed against, like a staked token, but no rate to count: the APY is understated
        if (correlated && !C0.native && C0.price * 100n > D.price * 101n) flags.push('nativeUnknown')
        if (opts.minCapacityBase !== undefined && capacityBase < opts.minCapacityBase) flags.push('lowCapacity')
        const row: ScanRow = {
          marketId: market.id,
          collateral: C,
          debt: D,
          emode,
          leverage,
          healthFactor,
          ratesApy,
          nativeApy,
          rewardsApy,
          apy: ratesApy + nativeApy + rewardsApy,
          collateralYield: C.supplyApy + (C0.native?.apy ?? 0),
          borrowCost: D.borrowApy - (D.native?.apy ?? 0),
          campaigns: yields.map((y) => y.campaign),
          rewardsEnd: ends.length ? Math.min(...ends) : undefined,
          capacityBase,
          stable,
          correlated,
          flags,
        }
        if (!best || row.apy > best.apy) best = row
      }
      if (best) rows.push(best)
    }
  }
  return rows.sort((a, b) => b.apy - a.apy)
}
