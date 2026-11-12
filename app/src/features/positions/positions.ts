/**
 * An account's Aave position on one market, whatever its shape (several collaterals or debts), and what it earns:
 * Aave rates on each asset plus the Merkl campaigns it qualifies for. Pure functions, tested without a chain.
 */
import { daysLeft, type Campaign } from '../../services/merkl'
import type { SnapReserve } from '../../protocols/aave/snapshot'
import { fmtHf } from '../../ui/format'

export type Holding = {
  reserve: SnapReserve
  /** token amounts */
  supplied: bigint
  borrowed: bigint
  /** oracle base units */
  suppliedBase: bigint
  borrowedBase: bigint
}

export type CampaignOnPosition = {
  campaign: Campaign
  /** reward yield on the position's equity (fraction per year), 0 when not eligible */
  apy: number
  /** rules the position breaks: the campaign pays nothing then */
  reasons: string[]
}

const lower = (a: string) => a.toLowerCase()

/** Whether a net campaign subtracts this leg (exact token list first, then the symbols of its description, unknown = netted). */
function netted(c: Campaign, tokenOfLeg: string, symbol: string): boolean {
  if (c.netOfTokens !== undefined) return c.netOfTokens.includes(lower(tokenOfLeg))
  return c.netOf === undefined || c.netOf.includes(lower(symbol))
}

/** Value (base units) each campaign pays on, per the Merkl rules described in merkl.ts. */
function rewardedBase(c: Campaign, holdings: Holding[]): number {
  const supplyOf = holdings.find((h) => lower(h.reserve.aToken) === c.token)
  const debtOf = holdings.find((h) => lower(h.reserve.variableDebtToken) === c.token)
  const n = (x: bigint) => Number(x)
  switch (c.kind) {
    case 'supply':
      return supplyOf ? n(supplyOf.suppliedBase) : 0
    case 'netLending': {
      if (!supplyOf) return 0
      const sub = holdings
        .filter((h) => h.borrowedBase > 0n && netted(c, h.reserve.variableDebtToken, h.reserve.token.symbol))
        .reduce((s, h) => s + n(h.borrowedBase), 0)
      return Math.max(0, n(supplyOf.suppliedBase) - sub)
    }
    case 'borrow':
      return debtOf ? n(debtOf.borrowedBase) : 0
    case 'netBorrowing': {
      if (!debtOf) return 0
      const sub = holdings.filter((h) => h.suppliedBase > 0n && netted(c, h.reserve.aToken, h.reserve.token.symbol)).reduce((s, h) => s + n(h.suppliedBase), 0)
      return Math.max(0, n(debtOf.borrowedBase) - sub)
    }
    case 'borrowFromCollateral':
      return debtOf && holdings.some((h) => h.suppliedBase > 0n && c.tokens.includes(lower(h.reserve.token.address))) ? n(debtOf.borrowedBase) : 0
  }
}

/** Campaigns that touch the position, with their yield on equity and the rules it breaks. */
export function positionRewards(campaigns: Campaign[] | undefined, holdings: Holding[], healthFactor: number, equityBase: bigint): CampaignOnPosition[] {
  const equity = Number(equityBase)
  const out: CampaignOnPosition[] = []
  for (const c of campaigns ?? []) {
    const base = rewardedBase(c, holdings)
    const touches = holdings.some(
      (h) => (h.suppliedBase > 0n && lower(h.reserve.aToken) === c.token) || (h.borrowedBase > 0n && lower(h.reserve.variableDebtToken) === c.token),
    )
    if (!touches) continue
    const reasons: string[] = []
    if (c.maxHealthFactor !== undefined && !(healthFactor <= c.maxHealthFactor))
      reasons.push(`health factor ${fmtHf(healthFactor)} au-dessus du maximum ${fmtHf(c.maxHealthFactor)}`)
    const forbidden = holdings.filter((h) => h.borrowedBase > 0n && c.forbiddenBorrows.includes(lower(h.reserve.variableDebtToken)))
    if (forbidden.length) reasons.push(`emprunt de ${forbidden.map((h) => h.reserve.token.symbol).join(', ')} exclu par la campagne`)
    if (base === 0 && reasons.length === 0) reasons.push('rien d’éligible : la dette compense le dépôt')
    out.push({ campaign: c, apy: reasons.length || equity <= 0 ? 0 : (c.apr * base) / equity, reasons })
  }
  return out.sort((a, b) => b.apy - a.apy)
}

export type PositionSummary = {
  collateralBase: bigint
  debtBase: bigint
  equityBase: bigint
  leverage: number
  /** Aave rates only, on equity */
  ratesApy: number
  /** intrinsic yield of yield-bearing tokens held or owed, on equity */
  nativeApy: number
  rewardsApy: number
  apy: number
  campaigns: CampaignOnPosition[]
  /** campaigns counted that end within a week */
  endingSoon: Campaign[]
}

export function summarizePosition(holdings: Holding[], campaigns: Campaign[] | undefined, healthFactor: number, nowMs = Date.now()): PositionSummary {
  const collateralBase = holdings.reduce((s, h) => s + h.suppliedBase, 0n)
  const debtBase = holdings.reduce((s, h) => s + h.borrowedBase, 0n)
  const equityBase = collateralBase - debtBase
  const equity = Number(equityBase)
  const yearly = holdings.reduce((s, h) => s + Number(h.suppliedBase) * h.reserve.supplyApy - Number(h.borrowedBase) * h.reserve.borrowApy, 0)
  const ratesApy = equity > 0 ? yearly / equity : NaN
  // a yield-bearing debt grows with its exchange rate too: it costs what a supplied one earns
  const nativeYearly = holdings.reduce((s, h) => s + (Number(h.suppliedBase) - Number(h.borrowedBase)) * (h.reserve.native?.apy ?? 0), 0)
  const nativeApy = equity > 0 ? nativeYearly / equity : NaN
  const onPosition = positionRewards(campaigns, holdings, healthFactor, equityBase)
  const rewardsApy = onPosition.reduce((s, c) => s + c.apy, 0)
  return {
    collateralBase,
    debtBase,
    equityBase,
    leverage: equity > 0 ? Number(collateralBase) / equity : Infinity,
    ratesApy,
    nativeApy,
    rewardsApy,
    apy: ratesApy + nativeApy + rewardsApy,
    campaigns: onPosition,
    endingSoon: onPosition.filter((c) => c.apy > 0 && daysLeft(c.campaign, nowMs) < 7).map((c) => c.campaign),
  }
}

/** Merkl rewards of an account on a chain (api.merkl.xyz/v4/users/{address}/rewards), as returned on 2026-11-02. */
export type MerklUserRewards = {
  chain: { id: number }
  rewards: { amount: string; claimed: string; pending: string; token: { address: string; symbol: string; decimals: number; price?: number } }[]
}[]

/** Claimable now (earned minus claimed) and still accruing (pending, claimable after the next Merkl update), per token. */
export function merklBalances(data: MerklUserRewards | undefined) {
  return (
    (data ?? [])
      .flatMap((c) => c.rewards)
      .map((r) => {
        const unit = 10 ** r.token.decimals
        const claimable = Math.max(0, Number(BigInt(r.amount) - BigInt(r.claimed)) / unit)
        const pending = Number(BigInt(r.pending)) / unit
        const price = r.token.price ?? 0
        return { address: r.token.address, symbol: r.token.symbol, claimable, pending, usd: (claimable + pending) * price, price }
      })
      // nothing worth a line: under a cent when the price is known, under 0.0001 token otherwise
      .filter((r) => (r.price > 0 ? r.usd >= 0.01 : r.claimable + r.pending >= 1e-4))
      .map(({ price: _, ...r }) => r)
      .sort((a, b) => b.usd - a.usd)
  )
}

const MERKL_USERS = 'https://api.merkl.xyz/v4/users'

export async function fetchUserRewards(chainId: number, user: string, signal: AbortSignal): Promise<MerklUserRewards> {
  const res = await fetch(`${MERKL_USERS}/${user}/rewards?chainId=${chainId}`, { signal })
  if (!res.ok) throw new Error(`Merkl : HTTP ${res.status}`)
  return (await res.json()) as MerklUserRewards
}

export const userRewardsQuery = (chainId: number, user: string | undefined) => ({
  queryKey: ['merkl-user', chainId, user],
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchUserRewards(chainId, user!, signal),
  enabled: !!user,
  staleTime: 5 * 60_000,
  retry: 1,
})
