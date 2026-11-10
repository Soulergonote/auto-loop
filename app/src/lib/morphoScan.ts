/**
 * Scanner rows for Morpho Blue: every listed market of a network, looped at the leverage that gives a target health
 * factor, ranked by yield on equity. Rates come from the Morpho API (the open screen re-reads them on-chain), a PT's
 * yield from its Pendle market. Pure functions, tested without a chain.
 */
import { leverageAtMorphoHf, morphoNetApy, type MorphoMarket } from './morpho'
import { isExpired, type PtInfo } from './pendle'
import { isCorrelated, isUsdStable, MAX_SCAN_LEVERAGE, MIN_SCAN_LEVERAGE } from './scan'

/** Same ceiling as the Morpho open panel's slider: the leverage at a health factor of 1.02, at most 15x. */
const SLIDER_HF = 1.02

export type MorphoScanFlag = 'nativeUnknown' | 'lowCapacity' | 'unlisted'

export type MorphoScanRow = {
  market: MorphoMarket
  leverage: number
  healthFactor: number
  /** collateral yield (PT implied APY or the token's own) times leverage */
  nativeApy: number
  /** borrow APY net of the borrow-side rewards the API counts */
  borrowApy: number
  apy: number
  /** equity that can still be looped before the market runs out of loan token, USD */
  capacityUsd: number
  pt?: PtInfo
  stable: boolean
  correlated: boolean
  flags: MorphoScanFlag[]
}

export type MorphoScanOptions = {
  targetHf: number
  /** PtInfo by lower-cased collateral address, for the markets whose collateral is a PT */
  pts?: Map<string, PtInfo>
  /** capacity under which a market is flagged as nearly full, USD */
  lowCapacityUsd?: number
  nowSec?: number
}

const priced = (t: MorphoMarket['collateral'], usd: number) => ({ token: t, price: BigInt(Math.round(usd * 1e8)) })

/** One row per market that can be looped: priced by the API, no red warning, a PT only before maturity with a known APY. */
export function scanMorpho(markets: MorphoMarket[], opts: MorphoScanOptions): MorphoScanRow[] {
  const rows: MorphoScanRow[] = []
  for (const m of markets) {
    if (m.collateralUsd <= 0 || m.loanUsd <= 0 || m.lltv <= 0 || m.lltv >= 1) continue
    if (m.warnings.some((w) => w.level === 'RED')) continue
    const pt = opts.pts?.get(m.collateral.address.toLowerCase())
    if (pt && isExpired(pt, opts.nowSec)) continue
    const leverage = Math.min(leverageAtMorphoHf(m.lltv, opts.targetHf), leverageAtMorphoHf(m.lltv, SLIDER_HF), MAX_SCAN_LEVERAGE)
    if (!(leverage >= MIN_SCAN_LEVERAGE)) continue
    const healthFactor = (m.lltv * leverage) / (leverage - 1)
    const collateralApy = pt ? (pt.impliedApy ?? 0) : (m.collateralYield?.apy ?? 0)
    const borrowApy = m.borrowApy - m.borrowRewardsApr
    const apy = morphoNetApy(leverage, collateralApy, borrowApy)
    const C = priced(m.collateral, m.collateralUsd)
    const L = priced(m.loan, m.loanUsd)
    const correlated = isCorrelated(C, L)
    const capacityUsd = m.liquidityUsd / (leverage - 1)
    const flags: MorphoScanFlag[] = []
    // a PT without a readable Pendle market, or a token priced above its loan like a staked one with no rate: understated
    if ((pt && pt.impliedApy === undefined) || (!pt && correlated && !m.collateralYield && m.collateralUsd > m.loanUsd * 1.01)) flags.push('nativeUnknown')
    if (opts.lowCapacityUsd !== undefined && capacityUsd < opts.lowCapacityUsd) flags.push('lowCapacity')
    if (!m.listed) flags.push('unlisted')
    rows.push({
      market: m,
      leverage,
      healthFactor,
      nativeApy: collateralApy * leverage,
      borrowApy,
      apy,
      capacityUsd,
      pt,
      stable: isUsdStable(C) && isUsdStable(L),
      correlated,
      flags,
    })
  }
  return rows.sort((a, b) => b.apy - a.apy)
}
