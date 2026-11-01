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
  /** eligibility rules beyond the position itself */
  conditional: boolean
  url?: string
}

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

export function toCampaign(o: Opportunity): Campaign | undefined {
  const kind = KINDS[o.type]
  if (!kind || !o.apr || o.apr <= 0 || !o.explorerAddress || !isAddress(o.explorerAddress)) return undefined
  let conditional = false
  if (kind === 'supply' || kind === 'borrow') {
    const suffix = o.identifier.slice(42)
    if (suffix === 'BORROW_BL') conditional = true
    else if (suffix) return undefined // restricted audience
  }
  return {
    name: o.name,
    kind,
    apr: o.apr / 100,
    token: o.explorerAddress.toLowerCase(),
    netOf: kind === 'netLending' || kind === 'netBorrowing' ? parseNetOf(o.description) : undefined,
    tokens: (o.tokens ?? []).map((t) => t.address?.toLowerCase()).filter((a): a is string => !!a),
    conditional,
    url: o.depositUrl,
  }
}

export async function fetchCampaigns(chainId: number, signal: AbortSignal): Promise<Campaign[]> {
  const out: Campaign[] = []
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ chainId: String(chainId), mainProtocolId: 'aave', status: 'LIVE', items: String(PAGE), page: String(page) })
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

/**
 * Reward yield on the equity of a loop at `leverage` (collateral = leverage x equity, debt = (leverage - 1) x
 * equity, in value). A net campaign that subtracts the other leg of the loop only pays on the difference.
 */
export function rewardsOnEquity(p: PairCampaigns, leverage: number, collateralSymbol: string, debtSymbol: string): number {
  const supplied = leverage
  const borrowed = leverage - 1
  const nets = (c: Campaign, symbol: string) => c.netOf === undefined || c.netOf.includes(symbol.toLowerCase())
  let total = 0
  for (const c of p.supply) total += c.apr * (c.kind === 'netLending' && nets(c, debtSymbol) ? Math.max(0, supplied - borrowed) : supplied)
  for (const c of p.borrow) total += c.apr * (c.kind === 'netBorrowing' && nets(c, collateralSymbol) ? Math.max(0, borrowed - supplied) : borrowed)
  return total
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
