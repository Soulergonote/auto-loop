import { useQuery } from '@tanstack/react-query'
import { isAddress, type Address } from 'viem'
import { DEMO, type Market } from '../config'

/**
 * Merkl incentive campaigns on Aave v3 (public API, no key). What each campaign type rewards, as the API
 * describes it (checked 2026-11-01):
 * - AAVE_SUPPLY / AAVE_BORROW: the supply on an aToken / the borrow on a variable debt token (identifier = that
 *   address). A suffix marks a restricted audience (e.g. JUMPER, bridgers only): skipped, except BORROW_BL
 *   (Ethena "looping required": borrow stablecoins, health factor at most 2, never borrow USDe), kept as conditional.
 * - AAVE_NET_LENDING: supply minus the borrows of the assets listed in the description.
 * - AAVE_NET_BORROWING: borrow minus the supplies of the assets listed in the description.
 * - AAVE_BORROW_FROM_COLLATERAL: borrowing one asset against one given collateral.
 * Campaigns are tied to a reserve by the aToken / debt token address (explorerAddress), never by the underlying
 * alone: Ethereum has several Aave markets on the same assets. `apr` comes in percent.
 */
const MERKL_API = 'https://api.merkl.xyz/v4/opportunities'
const PAGE = 100

export type CampaignKind = 'supply' | 'borrow' | 'netLending' | 'netBorrowing' | 'borrowFromCollateral'

export type Campaign = {
  name: string
  kind: CampaignKind
  /** fraction per year */
  apr: number
  /** aToken (supply kinds) or variable debt token (borrow kinds), lowercase */
  token: string
  /** net kinds: symbols whose borrows (net lending) or supplies (net borrowing) are subtracted; undefined = unknown */
  netOf?: string[]
  /** borrowFromCollateral: addresses of the campaign's tokens (borrowed and collateral underlyings), lowercase */
  tokens: string[]
  /**
   * net kinds, exact list from the campaign parameters: variable debt tokens subtracted (net lending) or aTokens
   * subtracted (net borrowing), lowercase. Preferred over `netOf` when present.
   */
  netOfTokens?: string[]
  /** reward only while the account's health factor is at or below this (e.g. Ethena looping campaigns) */
  maxHealthFactor?: number
  /** variable debt tokens that must not be borrowed (lowercase) */
  forbiddenBorrows: string[]
  /** eligibility rules the app could not read: the description has to be checked by hand */
  conditional: boolean
  /** end of the last live campaign, unix seconds */
  endsAt?: number
  description?: string
  url?: string
}

type Hook = { healthFactorThreshold?: string; borrowBytesLike?: string[]; [k: string]: unknown }

type Opportunity = {
  type: string
  action: string
  name: string
  identifier: string
  explorerAddress?: string
  description?: string
  apr?: number
  depositUrl?: string
  tokens?: { address?: string }[]
  latestCampaignEnd?: string | number
  campaigns?: { params?: { hooks?: Hook[]; borrowTokens?: string[]; supplyTokens?: string[] } }[]
}

const KINDS: Record<string, CampaignKind> = {
  AAVE_SUPPLY: 'supply',
  AAVE_BORROW: 'borrow',
  AAVE_NET_LENDING: 'netLending',
  AAVE_NET_BORROWING: 'netBorrowing',
  AAVE_BORROW_FROM_COLLATERAL: 'borrowFromCollateral',
}

/** "(USDS supply minus USDS, USDT, USDC borrows)" -> ['USDS', 'USDT', 'USDC'] */
export function parseNetOf(description: string | undefined): string[] | undefined {
  const m = description?.match(/minus ([^)]+?) (?:borrows|supplies)\)/)
  return m ? m[1].split(',').map((s) => s.trim().toLowerCase()) : undefined
}

const lower = (xs: string[] | undefined) => (xs ?? []).filter((x) => isAddress(x)).map((x) => x.toLowerCase())

export function toCampaign(o: Opportunity): Campaign | undefined {
  const kind = KINDS[o.type]
  if (!kind || !o.apr || o.apr <= 0 || !o.explorerAddress || !isAddress(o.explorerAddress)) return undefined
  let conditional = false
  if (kind === 'supply' || kind === 'borrow') {
    const suffix = o.identifier.slice(42)
    if (suffix === 'BORROW_BL') conditional = true
    else if (suffix) return undefined // restricted audience
  }
  // conditions and netted tokens, merged over the opportunity's live campaigns
  const params = (o.campaigns ?? []).map((c) => c.params ?? {})
  const hooks = params.flatMap((p) => p.hooks ?? [])
  const thresholds = hooks.map((h) => Number(h.healthFactorThreshold)).filter((x) => x > 0)
  const forbiddenBorrows = [...new Set(hooks.flatMap((h) => lower(h.borrowBytesLike)))]
  const known = (h: Hook) => h.healthFactorThreshold !== undefined || h.borrowBytesLike !== undefined
  // a rule we read is checked by the app; one we cannot read keeps the campaign flagged
  if (hooks.some((h) => !known(h))) conditional = true
  else if (hooks.length) conditional = false
  const nettedLists = params.map((p) => (kind === 'netLending' ? p.borrowTokens : kind === 'netBorrowing' ? p.supplyTokens : undefined)).filter((l) => !!l)
  const end = Number(o.latestCampaignEnd)
  return {
    name: o.name,
    kind,
    apr: o.apr / 100,
    token: o.explorerAddress.toLowerCase(),
    netOf: kind === 'netLending' || kind === 'netBorrowing' ? parseNetOf(o.description) : undefined,
    netOfTokens: nettedLists.length ? [...new Set(nettedLists.flatMap(lower))] : undefined,
    tokens: (o.tokens ?? []).map((t) => t.address?.toLowerCase()).filter((a): a is string => !!a),
    maxHealthFactor: thresholds.length ? Math.min(...thresholds) : undefined,
    forbiddenBorrows,
    conditional,
    endsAt: end > 0 ? end : undefined,
    description: o.description,
    url: o.depositUrl,
  }
}

export async function fetchCampaigns(chainId: number, signal: AbortSignal): Promise<Campaign[]> {
  const out: Campaign[] = []
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ chainId: String(chainId), mainProtocolId: 'aave', status: 'LIVE', items: String(PAGE), page: String(page), campaigns: 'true' })
    const res = await fetch(`${MERKL_API}?${q}`, { signal })
    if (!res.ok) throw new Error(`Merkl : HTTP ${res.status}`)
    const list = (await res.json()) as Opportunity[]
    for (const o of list) {
      const c = toCampaign(o)
      if (c) out.push(c)
    }
    if (list.length < PAGE) break
  }
  return out
}

export function useCampaigns(market: Market) {
  return useQuery({
    queryKey: ['merkl', market.chain.id],
    queryFn: ({ signal }) => fetchCampaigns(market.chain.id, signal),
    enabled: !DEMO,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

type Side = { token: { address: Address; symbol: string }; aToken: Address; variableDebtToken: Address }

/** Campaigns that pay on this pair: supplying the collateral and borrowing the debt asset. */
export function campaignsForPair(all: Campaign[] | undefined, collateral: Side, debt: Side) {
  const aToken = collateral.aToken.toLowerCase()
  const debtToken = debt.variableDebtToken.toLowerCase()
  const supply = (all ?? []).filter((c) => (c.kind === 'supply' || c.kind === 'netLending') && c.token === aToken)
  const borrow = (all ?? []).filter(
    (c) =>
      c.token === debtToken &&
      (c.kind === 'borrow' || c.kind === 'netBorrowing' || (c.kind === 'borrowFromCollateral' && c.tokens.includes(collateral.token.address.toLowerCase()))),
  )
  return { supply, borrow }
}

export type PairCampaigns = ReturnType<typeof campaignsForPair>

/** Rules of a campaign the position breaks (empty = eligible as far as the app can tell). */
export function unmetConditions(c: Campaign, position: { healthFactor: number; debtToken: Address }): string[] {
  const out: string[] = []
  if (c.maxHealthFactor !== undefined && !(position.healthFactor <= c.maxHealthFactor))
    out.push(`health factor ${Number.isFinite(position.healthFactor) ? position.healthFactor.toFixed(2) : '∞'} au-dessus du maximum ${c.maxHealthFactor}`)
  if (c.forbiddenBorrows.includes(position.debtToken.toLowerCase())) out.push('l’actif emprunté est exclu par la campagne')
  return out
}

/** Splits the pair's campaigns into those the position qualifies for and those it does not, with the reasons. */
export function eligibleForPosition(p: PairCampaigns, position: { healthFactor: number; debtToken: Address }) {
  const excluded: { campaign: Campaign; reasons: string[] }[] = []
  const keep = (c: Campaign) => {
    const reasons = unmetConditions(c, position)
    if (reasons.length) excluded.push({ campaign: c, reasons })
    return reasons.length === 0
  }
  return { pair: { supply: p.supply.filter(keep), borrow: p.borrow.filter(keep) }, excluded }
}

/**
 * Reward yield of each campaign on the equity of a loop at `leverage` (collateral = leverage x equity, debt =
 * (leverage - 1) x equity, in value). A net campaign that subtracts the other leg of the loop only pays on the
 * difference.
 */
export function campaignYields(p: PairCampaigns, leverage: number, collateral: Side, debt: Side): { campaign: Campaign; apy: number }[] {
  const supplied = leverage
  const borrowed = leverage - 1
  const netted = (c: Campaign, other: Side) =>
    c.netOfTokens !== undefined
      ? c.netOfTokens.includes((c.kind === 'netLending' ? other.variableDebtToken : other.aToken).toLowerCase())
      : c.netOf === undefined || c.netOf.includes(other.token.symbol.toLowerCase())
  return [
    ...p.supply.map((c) => ({ campaign: c, apy: c.apr * (c.kind === 'netLending' && netted(c, debt) ? Math.max(0, supplied - borrowed) : supplied) })),
    ...p.borrow.map((c) => ({ campaign: c, apy: c.apr * (c.kind === 'netBorrowing' && netted(c, collateral) ? Math.max(0, borrowed - supplied) : borrowed) })),
  ]
}

export function rewardsOnEquity(p: PairCampaigns, leverage: number, collateral: Side, debt: Side): number {
  return campaignYields(p, leverage, collateral, debt).reduce((s, y) => s + y.apy, 0)
}

/** Days until the campaign's last known end (Infinity when the API gives none). */
export function daysLeft(c: Campaign, nowMs = Date.now()): number {
  return c.endsAt === undefined ? Infinity : Math.max(0, (c.endsAt * 1000 - nowMs) / 86_400_000)
}

/** Average reward yield over the next `days`, each campaign counted only until its known end. */
export function rewardsOverHorizon(yields: { campaign: Campaign; apy: number }[], days: number, nowMs = Date.now()): number {
  return yields.reduce((s, y) => s + (y.apy * Math.min(days, daysLeft(y.campaign, nowMs))) / days, 0)
}

/** Headline reward APRs of one reserve, as Merkl shows them (not pair-specific campaigns). */
export function headlineRewards(all: Campaign[] | undefined, r: Side) {
  const a = r.aToken.toLowerCase()
  const d = r.variableDebtToken.toLowerCase()
  const sum = (f: (c: Campaign) => boolean) => (all ?? []).filter(f).reduce((s, c) => s + c.apr, 0)
  return {
    supply: sum((c) => (c.kind === 'supply' || c.kind === 'netLending') && c.token === a),
    borrow: sum((c) => (c.kind === 'borrow' || c.kind === 'netBorrowing') && c.token === d),
  }
}
