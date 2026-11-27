/**
 * Aave v4 reserves: every reserve of every spoke on the chains where v4 is live, in one request to Aave's public
 * GraphQL API (no key, CORS open). Rates, caps and ids for the Scanner and the Boucle screen; the position itself is
 * read on chain (state.ts).
 */
import type { Address } from 'viem'
import { DEMO } from '../../config'

export const AAVE_V4_API = 'https://api.v4.aave.com/graphql'

export type V4Reserve = {
  chainId: number
  network: string
  spoke: { name: string; address: Address }
  /** the reserve's id in its spoke: a spoke can list the same token twice (two hubs), so this is the key */
  reserveId: number
  hub: string
  token: { address: Address; symbol: string; name: string; decimals: number }
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
  /** A5: the reward APYs above that stop at a known date, and the first such date, per side */
  ending: { supply: EndingReward; borrow: EndingReward }
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
  onChainId chain { chainId name } spoke { name address } status { frozen paused active } canBorrow canSupply canUseAsCollateral
  asset { hub { name } underlying { address info { symbol decimals } } }
  summary { supplyApy { value } borrowApy { value } underlyingApy { value }
    borrowable { exchange { value } exchangeRate { value } } suppliable { exchange { value } }
    rewards { __typename ... on MerklSupplyReward { extraApy { value } endDate } ... on MerklBorrowReward { discountApy { value } endDate } } }
  settings { collateralFactor { value } collateralRisk { value } }
} }`

type Num = { value: string } | null
type Raw = {
  onChainId: number | string
  chain: { chainId: number; name: string }
  spoke: { name: string; address: Address }
  status: { frozen: boolean; paused: boolean; active: boolean }
  canBorrow: boolean
  canSupply: boolean
  canUseAsCollateral: boolean
  asset: { hub?: { name: string }; underlying: { address: Address; info: { symbol: string; decimals: number } } }
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

export type EndingReward = { apy: number; endsAt?: number }

const endOf = (x: { endDate?: string }) => (x.endDate && Number.isFinite(Date.parse(x.endDate)) ? Date.parse(x.endDate) / 1000 : undefined)

/** The rewards of one kind that have an end date: their APY summed, the first date. */
function endingOf(rewards: Raw['summary']['rewards'], kind: string, apy: (x: Raw['summary']['rewards'][number]) => number): EndingReward {
  const dated = (rewards ?? []).filter((x) => x.__typename === kind && endOf(x) !== undefined)
  return { apy: dated.reduce((s, x) => s + apy(x), 0), endsAt: dated.length ? Math.min(...dated.map((x) => endOf(x)!)) : undefined }
}

/** The API's reserves as the scan reads them; frozen, paused and inactive reserves are left out. Pure, tested. */
export function parseV4Reserves(raw: Raw[]): V4Reserve[] {
  return raw
    .filter((r) => r.status.active && !r.status.frozen && !r.status.paused)
    .map((r) => {
      const rewards = r.summary.rewards ?? []
      return {
        chainId: r.chain.chainId,
        network: r.chain.name,
        spoke: r.spoke,
        reserveId: Number(r.onChainId),
        hub: r.asset.hub?.name ?? '',
        token: {
          address: r.asset.underlying.address,
          symbol: r.asset.underlying.info.symbol,
          name: r.asset.underlying.info.symbol,
          decimals: r.asset.underlying.info.decimals,
        },
        price: BigInt(Math.round(num(r.summary.borrowable.exchangeRate) * 1e8)),
        supplyApy: num(r.summary.supplyApy),
        underlyingApy: num(r.summary.underlyingApy),
        borrowApy: num(r.summary.borrowApy),
        supplyRewardApy: rewards.reduce((s, x) => s + (x.__typename === 'MerklSupplyReward' ? num(x.extraApy) : 0), 0),
        borrowRewardApy: rewards.reduce((s, x) => s + (x.__typename === 'MerklBorrowReward' ? num(x.discountApy) : 0), 0),
        ending: {
          supply: endingOf(rewards, 'MerklSupplyReward', (x) => num(x.extraApy)),
          borrow: endingOf(rewards, 'MerklBorrowReward', (x) => num(x.discountApy)),
        },
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
  queryKey: [
    // the version changes with the shape of V4Reserve, so that an hourly snapshot (D1) of the previous shape is not used
    'aave-v4-reserves-2',
    ...chainIds,
  ],
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchV4Reserves(chainIds, signal),
  enabled: !DEMO && chainIds.length > 0,
  staleTime: 120_000,
  refetchInterval: 300_000,
  retry: 1,
})
