/**
 * Morpho Blue: market list (Morpho's API), the selected market and position read and checked on-chain, the loop math
 * and the calls of LeverageExecutorMorpho.
 *
 * The API only lists and ranks markets. Before anything is shown as a position or signed, the market is read again
 * on-chain: its parameters must hash to its id (so the API cannot swap the oracle or the LLTV), and prices, totals,
 * rates and the user's position come from Morpho, the market's oracle and its IRM.
 */
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from 'viem'
import { readContracts } from '@wagmi/core'
import { wagmiConfig } from '../wagmi'
import { erc20Abi, morphoAbi, morphoIrmAbi, morphoOracleAbi } from '../abi'
import type { Token } from '../config'
import type { Side } from './math'
import { gql } from './morphoApi'
import type { NativeYield } from './nativeYield'
import { aprToApy, plausible, readTokenYields } from './tokenYield'

const WAD = 10n ** 18n
const ORACLE_SCALE = 10n ** 36n
const VIRTUAL_SHARES = 10n ** 6n
const VIRTUAL_ASSETS = 1n
const YEAR = 365 * 86_400

export type MarketParams = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }

/** Morpho's market id: keccak256 of the ABI-encoded parameters. */
export function marketId(p: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv],
    ),
  )
}

/** A market as listed by the API (rates and sizes are the API's, refreshed on-chain once it is selected). */
export type MorphoMarket = {
  id: Hex
  chainId: number
  params: MarketParams
  listed: boolean
  collateral: Token
  loan: Token
  /** USD prices from the API (0 when it has none) */
  collateralUsd: number
  loanUsd: number
  /** the collateral's own yield (staking, savings rate): see tokenYield.ts; PTs get theirs from Pendle */
  collateralYield?: NativeYield
  lltv: number
  oracleType?: string
  borrowApy: number
  /** borrow-side rewards (APR) the API counts in netBorrowApy */
  borrowRewardsApr: number
  liquidity: bigint
  liquidityUsd: number
  collateralTotalUsd: number
  borrowUsd: number
  utilization: number
  /** API warnings (bad debt, unrecognised oracle, …) */
  warnings: { type: string; level: string }[]
}

type ApiAsset = { address: string; symbol: string; decimals: number; price?: { usd?: number | null } | null; yield?: { apr?: number | null } | null }
type ApiMarket = {
  marketId: string
  listed: boolean
  lltv: string
  irmAddress: string
  oracle?: { address: string; type?: string | null } | null
  collateralAsset?: ApiAsset | null
  loanAsset: ApiAsset
  warnings?: { type: string; level: string }[] | null
  state?: {
    borrowApy?: number | null
    rewards?: { borrowApr?: number | null }[] | null
    liquidityAssets?: number | string | null
    liquidityAssetsUsd?: number | null
    collateralAssetsUsd?: number | null
    borrowAssetsUsd?: number | null
    utilization?: number | null
  } | null
}

const token = (a: ApiAsset): Token => ({ address: getAddress(a.address), symbol: a.symbol, name: a.symbol, decimals: a.decimals })

/** API markets → MorphoMarket; idle markets (no collateral or oracle) and any whose parameters do not hash to the id are dropped. */
export function parseMarkets(chainId: number, items: ApiMarket[]): MorphoMarket[] {
  const out: MorphoMarket[] = []
  for (const m of items) {
    if (!m.collateralAsset || !m.oracle?.address || !m.loanAsset) continue
    const params: MarketParams = {
      loanToken: getAddress(m.loanAsset.address),
      collateralToken: getAddress(m.collateralAsset.address),
      oracle: getAddress(m.oracle.address),
      irm: getAddress(m.irmAddress),
      lltv: BigInt(m.lltv),
    }
    const id = marketId(params)
    if (id.toLowerCase() !== m.marketId.toLowerCase()) continue
    const st = m.state ?? {}
    out.push({
      id,
      chainId,
      params,
      listed: m.listed,
      collateral: token(m.collateralAsset),
      loan: token(m.loanAsset),
      collateralUsd: m.collateralAsset.price?.usd ?? 0,
      loanUsd: m.loanAsset.price?.usd ?? 0,
      collateralYield: plausible(m.collateralAsset.yield?.apr ?? undefined) ? { apy: aprToApy(m.collateralAsset.yield!.apr!), source: 'morpho' } : undefined,
      lltv: Number(params.lltv) / 1e18,
      oracleType: m.oracle.type ?? undefined,
      borrowApy: st.borrowApy ?? 0,
      borrowRewardsApr: (st.rewards ?? []).reduce((s, r) => s + (r.borrowApr ?? 0), 0),
      liquidity: BigInt(Math.floor(Number(st.liquidityAssets ?? 0))),
      liquidityUsd: st.liquidityAssetsUsd ?? 0,
      collateralTotalUsd: st.collateralAssetsUsd ?? 0,
      borrowUsd: st.borrowAssetsUsd ?? 0,
      utilization: st.utilization ?? 0,
      warnings: m.warnings ?? [],
    })
  }
  return out
}

const MARKET_FIELDS = `marketId listed lltv irmAddress oracle { address type }
  collateralAsset { address symbol decimals price { usd } yield { apr } }
  loanAsset { address symbol decimals price { usd } }
  warnings { type level }
  state { borrowApy rewards { borrowApr } liquidityAssets liquidityAssetsUsd collateralAssetsUsd borrowAssetsUsd utilization }`

/** Unlisted markets are only fetched with at least this much supplied (most are empty or tests). */
export const UNLISTED_MIN_SUPPLY_USD = 10_000

/** Every market of the chain the API lists (listed ones; unlisted ones with some supply when asked), 1 000 per page. */
export async function fetchMorphoMarkets(chainId: number, unlisted = false, signal?: AbortSignal): Promise<MorphoMarket[]> {
  const where = unlisted
    ? `{ chainId_in: [${chainId}], listed: false, supplyAssetsUsd_gte: ${UNLISTED_MIN_SUPPLY_USD} }`
    : `{ chainId_in: [${chainId}], listed: true }`
  const items: ApiMarket[] = []
  for (let skip = 0; skip < 10_000; skip += 1000) {
    const data = await gql<{ markets: { items: ApiMarket[]; pageInfo: { countTotal: number } } }>(
      `query($skip: Int!) { markets(first: 1000, skip: $skip, where: ${where}) { pageInfo { countTotal } items { ${MARKET_FIELDS} } } }`,
      { skip },
      signal,
    )
    items.push(...data.markets.items)
    if (items.length >= data.markets.pageInfo.countTotal || data.markets.items.length === 0) break
  }
  return withTokenYields(chainId, parseMarkets(chainId, items))
}

/** Collateral yields from the best source that knows the token (tokenYield.ts), else the one the market came with. */
async function withTokenYields(chainId: number, markets: MorphoMarket[]): Promise<MorphoMarket[]> {
  const found = await readTokenYields(chainId, [...new Set(markets.map((m) => m.collateral.address))]).catch(() => new Map<string, NativeYield>())
  return markets.map((m) => ({ ...m, collateralYield: found.get(m.collateral.address.toLowerCase()) ?? m.collateralYield }))
}

export const morphoMarketsQuery = (chainId: number, unlisted = false) => ({
  queryKey: ['morpho-markets', chainId, unlisted],
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchMorphoMarkets(chainId, unlisted, signal),
  staleTime: 120_000,
  refetchInterval: 300_000,
  retry: 2,
})

/** Markets where the user has collateral on these chains (API, unlisted markets included), to be read on-chain one by one. */
export async function fetchPositionMarkets(user: Address, chainIds: number[], signal?: AbortSignal): Promise<MorphoMarket[]> {
  const data = await gql<{ marketPositions: { items: { market: ApiMarket & { chain: { id: number } } }[] } }>(
    `query($user: [String!], $chains: [Int!]) { marketPositions(first: 200, where: { userAddress_in: $user, chainId_in: $chains, collateral_gte: 1 }) {
      items { market { chain { id } ${MARKET_FIELDS} } } } }`,
    { user: [user], chains: chainIds },
    signal,
  )
  const markets = data.marketPositions.items.flatMap((p) => parseMarkets(p.market.chain.id, [p.market]))
  const chains = [...new Set(markets.map((m) => m.chainId))]
  return (
    await Promise.all(
      chains.map((c) =>
        withTokenYields(
          c,
          markets.filter((m) => m.chainId === c),
        ),
      ),
    )
  ).flat()
}

/**
 * Markets of `candidates` where the user has collateral or debt, read on-chain in one multicall: finds a position the
 * API has not indexed yet (just opened) and does not depend on the API for the listed markets.
 */
export async function readHeldMarkets(chainId: number, morpho: Address, candidates: MorphoMarket[], user: Address): Promise<MorphoMarket[]> {
  if (candidates.length === 0) return []
  const r = await readContracts(wagmiConfig, {
    contracts: candidates.map((m) => ({ chainId, address: morpho, abi: morphoAbi, functionName: 'position', args: [m.id, user] }) as const),
    allowFailure: true,
  })
  return candidates.filter((_, i) => {
    const p = r[i].result as readonly [bigint, bigint, bigint] | undefined
    return !!p && (p[1] > 0n || p[2] > 0n)
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// On-chain state
// ---------------------------------------------------------------------------------------------------------------------

export type MarketTotals = {
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  lastUpdate: bigint
  fee: bigint
}

export type UserMorpho = {
  borrowShares: bigint
  collateral: bigint
  /** debt in loan token, interest to now included (rounded up, as Morpho does) */
  debt: bigint
  /** the executor is authorized on Morpho outside a transaction (a permanent authorization) */
  authorized: boolean
  nonce: bigint
  collateralBalance: bigint
  loanBalance: bigint
  collateralAllowance: bigint
  loanAllowance: bigint
}

export type MorphoState = {
  totals: MarketTotals
  /** oracle price: loan units per collateral unit x 1e36 (decimals included) */
  price: bigint
  /** borrow rate per second (WAD) from the IRM; undefined when its view cannot be read */
  borrowRate?: bigint
  borrowApy?: number
  /** loan token the market can still lend (supply - borrow) */
  liquidity: bigint
  user?: UserMorpho
}

export const rateToApy = (perSecond: bigint) => Math.exp((Number(perSecond) / 1e18) * YEAR) - 1

/** Morpho's 3-term Taylor expansion of e^(rate x elapsed) - 1, WAD. */
export function wTaylorCompounded(rate: bigint, elapsed: bigint): bigint {
  const first = rate * elapsed
  const second = (first * first) / (2n * WAD)
  const third = (second * first) / (3n * WAD)
  return first + second + third
}

/** Total borrow assets at `now`, interest since the last update included, the way Morpho accrues it. */
export function accruedBorrow(t: MarketTotals, rate: bigint | undefined, now: bigint): bigint {
  if (!rate || now <= t.lastUpdate) return t.totalBorrowAssets
  return t.totalBorrowAssets + (t.totalBorrowAssets * wTaylorCompounded(rate, now - t.lastUpdate)) / WAD
}

export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) =>
  (shares * (totalAssets + VIRTUAL_ASSETS) + (totalShares + VIRTUAL_SHARES) - 1n) / (totalShares + VIRTUAL_SHARES)

/** Loan units the collateral is worth at the oracle price. */
export const collateralInLoan = (collateral: bigint, price: bigint) => (collateral * price) / ORACLE_SCALE
/** Collateral units worth `loan` at the oracle price. */
export const loanInCollateral = (loan: bigint, price: bigint) => (price === 0n ? 0n : (loan * ORACLE_SCALE) / price)

/** Morpho's health factor: collateral value x LLTV / debt (Infinity without debt). */
export function morphoHf(collateral: bigint, debt: bigint, price: bigint, lltv: bigint): number {
  if (debt === 0n) return Infinity
  return Number((collateralInLoan(collateral, price) * lltv * 10n ** 9n) / (WAD * debt)) / 1e9
}

/**
 * USD sides for the shared math (quotes, swap loss, costs): the loan token at its API price (1 USD when the API has
 * none), the collateral at the oracle price times that, so that health factors computed on them match Morpho's.
 */
export function morphoSides(m: Pick<MorphoMarket, 'collateral' | 'loan' | 'loanUsd'>, price: bigint): { collateral: Side; loan: Side } {
  const loanPrice = BigInt(Math.round((m.loanUsd > 0 ? m.loanUsd : 1) * 1e8))
  // USD (1e8) of one whole collateral unit = price / 1e36 x 10^cDec / 10^lDec x loan USD
  const collPrice = (price * 10n ** BigInt(m.collateral.decimals) * loanPrice) / (ORACLE_SCALE * 10n ** BigInt(m.loan.decimals))
  return { collateral: { price: collPrice, decimals: m.collateral.decimals }, loan: { price: loanPrice, decimals: m.loan.decimals } }
}

/** Reads the market and (with `user`) the position, and checks the parameters against Morpho's own record of the id. */
export async function readMorphoState(chainId: number, morpho: Address, m: MorphoMarket, user?: Address, executor?: Address): Promise<MorphoState> {
  const p = m.params
  const base = [
    { chainId, address: morpho, abi: morphoAbi, functionName: 'idToMarketParams', args: [m.id] },
    { chainId, address: morpho, abi: morphoAbi, functionName: 'market', args: [m.id] },
    { chainId, address: p.oracle, abi: morphoOracleAbi, functionName: 'price' },
  ] as const
  const r = await readContracts(wagmiConfig, { contracts: base, allowFailure: false })
  const [loanToken, collateralToken, oracle, irm, lltv] = r[0]
  if (
    loanToken.toLowerCase() !== p.loanToken.toLowerCase() ||
    collateralToken.toLowerCase() !== p.collateralToken.toLowerCase() ||
    oracle.toLowerCase() !== p.oracle.toLowerCase() ||
    irm.toLowerCase() !== p.irm.toLowerCase() ||
    lltv !== p.lltv
  )
    throw new Error('les paramètres du marché lus sur Morpho ne sont pas ceux annoncés')
  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = r[1]
  const totals: MarketTotals = { totalSupplyAssets, totalBorrowAssets, totalBorrowShares, lastUpdate, fee }
  const price = r[2]

  const extra = (await readContracts(wagmiConfig, {
    contracts: [
      {
        chainId,
        address: p.irm,
        abi: morphoIrmAbi,
        functionName: 'borrowRateView',
        args: [p, { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee }],
      },
      ...(user
        ? ([
            { chainId, address: morpho, abi: morphoAbi, functionName: 'position', args: [m.id, user] },
            { chainId, address: morpho, abi: morphoAbi, functionName: 'nonce', args: [user] },
            { chainId, address: p.collateralToken, abi: erc20Abi, functionName: 'balanceOf', args: [user] },
            { chainId, address: p.loanToken, abi: erc20Abi, functionName: 'balanceOf', args: [user] },
            ...(executor
              ? ([
                  { chainId, address: morpho, abi: morphoAbi, functionName: 'isAuthorized', args: [user, executor] },
                  { chainId, address: p.collateralToken, abi: erc20Abi, functionName: 'allowance', args: [user, executor] },
                  { chainId, address: p.loanToken, abi: erc20Abi, functionName: 'allowance', args: [user, executor] },
                ] as const)
              : []),
          ] as const)
        : []),
    ] as never,
    allowFailure: true,
  })) as { result?: unknown }[]
  const borrowRate = extra[0].result as bigint | undefined
  const now = BigInt(Math.floor(Date.now() / 1000))
  const borrowNow = accruedBorrow(totals, borrowRate, now)
  const state: MorphoState = {
    totals,
    price,
    borrowRate,
    borrowApy: borrowRate !== undefined ? rateToApy(borrowRate) : undefined,
    liquidity: totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0n,
  }
  if (user) {
    const pos = extra[1].result as readonly [bigint, bigint, bigint] | undefined
    if (!pos) throw new Error('position illisible sur Morpho')
    const get = (i: number) => (extra[i]?.result as bigint | boolean | undefined) ?? undefined
    state.user = {
      borrowShares: pos[1],
      collateral: pos[2],
      debt: pos[1] === 0n ? 0n : toAssetsUp(pos[1], borrowNow, totalBorrowShares),
      nonce: (get(2) as bigint | undefined) ?? 0n,
      collateralBalance: (get(3) as bigint | undefined) ?? 0n,
      loanBalance: (get(4) as bigint | undefined) ?? 0n,
      authorized: executor ? get(5) === true : false,
      collateralAllowance: executor ? ((get(6) as bigint | undefined) ?? 0n) : 0n,
      loanAllowance: executor ? ((get(7) as bigint | undefined) ?? 0n) : 0n,
    }
  }
  return state
}

// ---------------------------------------------------------------------------------------------------------------------
// Loop math (loan units, oracle price)
// ---------------------------------------------------------------------------------------------------------------------

/** Highest leverage Morpho lets a loop reach: 1 / (1 - LLTV), where the health factor is 1. */
export const maxMorphoLeverage = (lltv: number) => (lltv >= 1 ? Infinity : 1 / (1 - lltv))

/** Leverage of a loop whose health factor is `hf`: HF = LLTV x L / (L - 1), so L = HF / (HF - LLTV). */
export const leverageAtMorphoHf = (lltv: number, hf: number) => (hf > lltv ? hf / (hf - lltv) : Infinity)

/** Leverage of a position: collateral value / (collateral value - debt). */
export function morphoLeverage(collateral: bigint, debt: bigint, price: bigint): number {
  const v = collateralInLoan(collateral, price)
  return v <= debt ? Infinity : Number(v) / Number(v - debt)
}

/**
 * Debt to add so that the position (with `addedLoanValue` of new capital, in loan units) reaches `leverage`:
 * target debt = (L - 1) / L x total collateral value, where total = current value + capital + new debt.
 * Solved for the new debt D: (V + A + D) (L - 1) / L = debt + D → D = (V + A) (L - 1) - L x debt.
 */
export function debtForMorphoLeverage(collateralValue: bigint, debt: bigint, addedLoanValue: bigint, leverageBps: bigint): bigint {
  const d = ((collateralValue + addedLoanValue) * (leverageBps - 10_000n) - leverageBps * debt) / 10_000n
  return d > 0n ? d : 0n
}

/** Debt to repay (by selling collateral) so that the position falls to `leverage`: D_new = (L - 1) x equity. */
export function repayForMorphoLeverage(collateralValue: bigint, debt: bigint, leverageBps: bigint): bigint {
  if (collateralValue <= debt) return debt
  const equity = collateralValue - debt
  const target = (equity * (leverageBps - 10_000n)) / 10_000n
  return debt > target ? debt - target : 0n
}

/** Price drop of the collateral (against the loan token) that brings the health factor to 1. */
export const dropToLiquidation = (hf: number) => (Number.isFinite(hf) && hf > 0 ? Math.max(0, 1 - 1 / hf) : 1)

/** Net APY on equity: collateral yield on L, borrow cost (net of rewards) on L - 1. */
export const morphoNetApy = (leverage: number, collateralApy: number, borrowApy: number) => collateralApy * leverage - borrowApy * (leverage - 1)

// ---------------------------------------------------------------------------------------------------------------------
// Authorization signatures (EIP-712, domain = chain id + Morpho)
// ---------------------------------------------------------------------------------------------------------------------

export const AUTHORIZATION_TYPES = {
  Authorization: [
    { name: 'authorizer', type: 'address' },
    { name: 'authorized', type: 'address' },
    { name: 'isAuthorized', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export function authorizationTypedData(
  chainId: number,
  morpho: Address,
  a: { authorizer: Address; authorized: Address; isAuthorized: boolean; nonce: bigint; deadline: bigint },
) {
  return { domain: { chainId, verifyingContract: morpho }, types: AUTHORIZATION_TYPES, primaryType: 'Authorization' as const, message: a }
}
