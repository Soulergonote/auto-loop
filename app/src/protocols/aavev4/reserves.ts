/**
 * Aave v4 reserves, read-only (O3): every reserve of every spoke on the chains where v4 is live, in one request to
 * Aave's public GraphQL API (no key, CORS open). Nothing here is signed or executed: the Scanner only shows what a
 * loop would earn there, to tell whether a v4 executor is worth writing.
 */
import type { Address } from 'viem'
import { DEMO } from '../../config'

export const AAVE_V4_API = 'https://api.v4.aave.com/graphql'

export type V4Reserve = {
  chainId: number
  network: string
  spoke: { name: string; address: Address }
  token: { address: Address; symbol: string }
  /** USD price, 8 decimals like an Aave oracle */
  price: bigint
  /** lending rate of the reserve, and the token's own yield when the API knows it (wstETH, sUSDe…) */
  supplyApy: number
  underlyingApy: number
  /** base borrow rate, before the user's risk premium */
  borrowApy: number
  /** Merkl: extra APY on the supply, discount on the borrow rate */
  supplyRewardApy: number
  borrowRewardApy: number
  rewardsEnd?: number
  /** share of the collateral's value that backs debt (the liquidation line), 0 when it is not a collateral */
  collateralFactor: number
  /** risk premium this collateral adds to the borrow rate, as a fraction of the base rate */
  collateralRisk: number
  canCollateral: boolean
  canBorrow: boolean
  /** what can still be borrowed and supplied, USD */
  borrowableUsd: number
  suppliableUsd: number
}

const QUERY = `query($chainIds: [ChainId!]!) { reserves(request: { query: { chainIds: $chainIds }, filter: ALL, orderBy: { assetName: ASC } }) {
  chain { chainId name } spoke { name address } status { frozen paused active } canBorrow canSupply canUseAsCollateral
  asset { underlying { address info { symbol } } }
  summary { supplyApy { value } borrowApy { value } underlyingApy { value }
    borrowable { exchange { value } exchangeRate { value } } suppliable { exchange { value } }
    rewards { __typename ... on MerklSupplyReward { extraApy { value } endDate } ... on MerklBorrowReward { discountApy { value } endDate } } }
  settings { collateralFactor { value } collateralRisk { value } }
} }`

type Num = { value: string } | null
type Raw = {
  chain: { chainId: number; name: string }
  spoke: { name: string; address: Address }
  status: { frozen: boolean; paused: boolean; active: boolean }
  canBorrow: boolean
  canSupply: boolean
  canUseAsCollateral: boolean
  asset: { underlying: { address: Address; info: { symbol: string } } }
  summary: {
    supplyApy: Num
    borrowApy: Num
    underlyingApy: Num
    borrowable: { exchange: Num; exchangeRate: Num }
    suppliable: { exchange: Num }
    rewards: { __typename: string; extraApy?: Num; discountApy?: Num; endDate?: string }[]
  }
  settings: { collateralFactor: Num; collateralRisk: Num }
}

const num = (n: Num | undefined) => {
  const x = Number(n?.value ?? 0)
  return Number.isFinite(x) ? x : 0
}

/** The API's reserves as the scan reads them; frozen, paused and inactive reserves are left out. Pure, tested. */
export function parseV4Reserves(raw: Raw[]): V4Reserve[] {
  return raw
    .filter((r) => r.status.active && !r.status.frozen && !r.status.paused)
    .map((r) => {
      const rewards = r.summary.rewards ?? []
      const ends = rewards.flatMap((x) => (x.endDate && Number.isFinite(Date.parse(x.endDate)) ? [Date.parse(x.endDate) / 1000] : []))
      return {
        chainId: r.chain.chainId,
        network: r.chain.name,
        spoke: r.spoke,
        token: { address: r.asset.underlying.address, symbol: r.asset.underlying.info.symbol },
        price: BigInt(Math.round(num(r.summary.borrowable.exchangeRate) * 1e8)),
        supplyApy: num(r.summary.supplyApy),
        underlyingApy: num(r.summary.underlyingApy),
        borrowApy: num(r.summary.borrowApy),
        supplyRewardApy: rewards.reduce((s, x) => s + (x.__typename === 'MerklSupplyReward' ? num(x.extraApy) : 0), 0),
        borrowRewardApy: rewards.reduce((s, x) => s + (x.__typename === 'MerklBorrowReward' ? num(x.discountApy) : 0), 0),
        rewardsEnd: ends.length ? Math.min(...ends) : undefined,
        collateralFactor: num(r.settings.collateralFactor),
        collateralRisk: num(r.settings.collateralRisk),
        canCollateral: r.canUseAsCollateral && r.canSupply && num(r.settings.collateralFactor) > 0,
        canBorrow: r.canBorrow,
        borrowableUsd: num(r.summary.borrowable.exchange),
        suppliableUsd: num(r.summary.suppliable.exchange),
      }
    })
}

export async function fetchV4Reserves(chainIds: number[], signal?: AbortSignal): Promise<V4Reserve[]> {
  const res = await fetch(AAVE_V4_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { chainIds } }),
    signal,
  })
  if (!res.ok) throw new Error(`API Aave v4 : HTTP ${res.status}`)
  const body = (await res.json()) as { data?: { reserves?: Raw[] }; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(`API Aave v4 : ${body.errors[0].message}`)
  if (!body.data?.reserves) throw new Error('API Aave v4 : réponse vide')
  return parseV4Reserves(body.data.reserves)
}

export const v4ReservesQuery = (chainIds: number[]) => ({
  queryKey: ['aave-v4-reserves', ...chainIds],
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchV4Reserves(chainIds, signal),
  enabled: !DEMO && chainIds.length > 0,
  staleTime: 120_000,
  refetchInterval: 300_000,
  retry: 1,
})
