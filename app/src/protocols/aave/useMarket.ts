import { useMemo } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { zeroAddress, type Address } from 'viem'
import { poolAbi, providerAbi, oracleAbi, erc20Abi, debtTokenAbi } from '../../chain/abi'
import { DEMO, DEMO_TOKENS, pendleChain, type Market, type Token } from '../../config'
import { demoReserve, demoUser } from './demo'
import { decodeReserveConfig, rayAprToApy, type ReserveConfig } from './reserveConfig'
import type { Account, Side } from '../../domain/math'
import { headlineRewards, type Campaign } from '../../services/merkl'
import { nativeYieldQuery, type NativeYield } from '../../services/yield/nativeYield'
import { ptInfosQuery, ptYield, readFeedDiscount, type PtInfo } from '../pendle/pt'

export type Reserve = {
  token: Token
  /** index of the reserve in the pool, its bit in eMode bitmaps */
  id: number
  config: ReserveConfig
  aToken: Address
  variableDebtToken: Address
  supplyApy: number
  borrowApy: number
  /** Merkl reward APRs (fractions), 0 when there is no campaign */
  supplyRewardApr: number
  borrowRewardApr: number
  /** exchange-rate yield of a yield-bearing token (wstETH, sUSDe…), from its Aave price adapter */
  native?: NativeYield
  /** a Pendle PT: its SY, maturity and market; `discount` = annual discount of its Aave price feed, when read */
  pt?: PtInfo & { discount?: number }
  price: bigint
  side: Side
}

export type UserState = {
  account: Account
  healthFactor: number
  eModeCategory: number
  collateralBalance: bigint
  collateralAllowance: bigint
  aTokenBalance: bigint
  aTokenAllowance: bigint
  debtBalance: bigint
  borrowAllowance: bigint
}

/** Assets listed on the market's Aave pool, sorted by symbol (read on-chain, so new listings show up by themselves). */
export function useReserveTokens(market: Market) {
  const chainId = market.chain.id
  const list = useReadContract({ chainId, address: market.pool, abi: poolAbi, functionName: 'getReservesList', query: { enabled: !DEMO, staleTime: 600_000 } })
  const addresses = useMemo(() => list.data ?? [], [list.data])
  const meta = useReadContracts({
    contracts: addresses.flatMap((address) => [
      { chainId, address, abi: erc20Abi, functionName: 'symbol' } as const,
      { chainId, address, abi: erc20Abi, functionName: 'decimals' } as const,
    ]),
    allowFailure: true,
    query: { enabled: addresses.length > 0, staleTime: 600_000 },
  })
  const tokens = useMemo((): Token[] | undefined => {
    if (DEMO) return DEMO_TOKENS
    if (!meta.data) return undefined
    return addresses
      .map((address, i) => {
        const symbol = meta.data[2 * i]?.result as string | undefined
        const decimals = meta.data[2 * i + 1]?.result as number | undefined
        // e.g. MKR returns its symbol as bytes32: show a short address instead
        return { address, symbol: symbol ?? `${address.slice(0, 6)}…`, name: symbol ?? address, decimals: Number(decimals ?? 18) }
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol, 'en', { sensitivity: 'base' }))
  }, [addresses, meta.data])
  const refetch = () => {
    void list.refetch()
    void meta.refetch()
  }
  return { tokens, error: list.error ?? meta.error, loading: list.isLoading || meta.isLoading, refetch }
}

type ReserveData = {
  configuration: bigint
  id: number
  aTokenAddress: Address
  variableDebtTokenAddress: Address
  currentLiquidityRate: bigint
  currentVariableBorrowRate: bigint
}

/** A reserve as the app uses it, from the pool's `getReserveData` and the oracle price. */
export function toReserve(token: Token, r: ReserveData, price: bigint, native?: NativeYield, pt?: Reserve['pt']): Reserve {
  const config = decodeReserveConfig(r.configuration)
  return {
    // a PT's yield is the fixed rate of its Pendle market, until maturity
    native: pt ? ptYield(pt) : native,
    pt,
    token: { ...token, decimals: config.decimals },
    config,
    id: r.id,
    aToken: r.aTokenAddress,
    variableDebtToken: r.variableDebtTokenAddress,
    supplyApy: rayAprToApy(r.currentLiquidityRate),
    borrowApy: rayAprToApy(r.currentVariableBorrowRate),
    supplyRewardApr: 0,
    borrowRewardApr: 0,
    price,
    side: { price, decimals: config.decimals },
  }
}

/** Every reserve of the market with its oracle price (intrinsic yields read for those that have one). */
export function useAllReserves(market: Market, tokens: Token[] | undefined, enabled = true) {
  const chainId = market.chain.id
  const list = useMemo(() => tokens ?? [], [tokens])
  const on = enabled && !DEMO && list.length > 0
  const provider = useReadContract({ chainId, address: market.pool, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER', query: { enabled: on } })
  const oracle = useReadContract({
    chainId,
    address: provider.data,
    abi: providerAbi,
    functionName: 'getPriceOracle',
    query: { enabled: on && !!provider.data },
  })
  const prices = useReadContract({
    chainId,
    address: oracle.data,
    abi: oracleAbi,
    functionName: 'getAssetsPrices',
    args: [list.map((t) => t.address)],
    query: { enabled: on && !!oracle.data, refetchInterval: 30_000 },
  })
  const data = useReadContracts({
    contracts: list.map((t) => ({ chainId, address: market.pool, abi: poolAbi, functionName: 'getReserveData', args: [t.address] }) as const),
    allowFailure: true,
    query: { enabled: on, refetchInterval: 60_000 },
  })
  const native = useQuery(
    nativeYieldQuery(
      chainId,
      oracle.data,
      list.map((t) => t.address),
    ),
  )
  const pts = useQuery({
    ...ptInfosQuery(
      chainId,
      list.map((t) => t.address),
    ),
    enabled: on && pendleChain(chainId),
  })
  const reserves = useMemo(() => {
    if (!prices.data || !data.data) return undefined
    return list.flatMap((t, i) => {
      const r = data.data[i]?.result
      const price = prices.data[i] ?? 0n
      const key = t.address.toLowerCase()
      return r && r.aTokenAddress !== zeroAddress && price > 0n ? [toReserve(t, r, price, native.data?.get(key), pts.data?.get(key))] : []
    })
  }, [list, prices.data, data.data, native.data, pts.data])
  return { reserves, error: provider.error ?? oracle.error ?? prices.error ?? data.error }
}

/** Reads both reserves of the pair, oracle prices, the flash loan premium and, when connected, the user's state. */
export function useMarket(market: Market, collateral: Token, debt: Token, user?: Address, nativeToken?: Address) {
  const chainId = market.chain.id
  const pool = { chainId, address: market.pool, abi: poolAbi } as const
  const provider = useReadContract({ ...pool, functionName: 'ADDRESSES_PROVIDER', query: { enabled: !DEMO } })
  const oracle = useReadContract({
    chainId,
    address: provider.data,
    abi: providerAbi,
    functionName: 'getPriceOracle',
    query: { enabled: !!provider.data },
  })

  const reads = useReadContracts({
    contracts: [
      { ...pool, functionName: 'getReserveData', args: [collateral.address] },
      { ...pool, functionName: 'getReserveData', args: [debt.address] },
      { ...pool, functionName: 'FLASHLOAN_PREMIUM_TOTAL' },
      {
        chainId,
        address: oracle.data ?? zeroAddress,
        abi: oracleAbi,
        functionName: 'getAssetsPrices',
        args: [nativeToken ? [collateral.address, debt.address, nativeToken] : [collateral.address, debt.address]],
      },
    ],
    allowFailure: false,
    query: { enabled: !!oracle.data, refetchInterval: 30_000 },
  })
  // a failed read only leaves the intrinsic yield out
  const native = useQuery(nativeYieldQuery(chainId, DEMO ? undefined : oracle.data, [collateral.address, debt.address]))
  // Pendle PTs: maturity, market and fixed yield; the collateral's Aave price discount for the health factor at maturity
  const pts = useQuery({ ...ptInfosQuery(chainId, [collateral.address, debt.address]), enabled: !DEMO && pendleChain(chainId) })
  const collateralPt = pts.data?.get(collateral.address.toLowerCase())
  const discount = useQuery({
    queryKey: ['pt-discount', chainId, oracle.data, collateral.address],
    queryFn: () => readFeedDiscount(chainId, oracle.data!, collateral.address),
    enabled: !!oracle.data && !!collateralPt,
    staleTime: 600_000,
  })

  const reserves = useMemo(() => {
    if (DEMO) return { market, collateral: demoReserve(collateral), debt: demoReserve(debt), premiumBps: 5n, nativePrice: undefined }
    if (!reads.data) return undefined
    const [rc, rd, premium, prices] = reads.data
    const ptOf = (token: Token) => {
      const pt = pts.data?.get(token.address.toLowerCase())
      return pt && token.address === collateral.address ? { ...pt, discount: discount.data } : pt
    }
    const build = (token: Token, r: typeof rc, price: bigint) => toReserve(token, r, price, native.data?.get(token.address.toLowerCase()), ptOf(token))
    if (rc.aTokenAddress === zeroAddress || rd.aTokenAddress === zeroAddress) return null // not listed
    return {
      market,
      collateral: build(collateral, rc, prices[0]),
      debt: build(debt, rd, prices[1]),
      premiumBps: BigInt(premium),
      nativePrice: nativeToken ? prices[2] : undefined,
    }
  }, [reads.data, native.data, pts.data, discount.data, market, collateral, debt, nativeToken])

  const executor = market.executor
  const spender = executor ?? zeroAddress
  const userReads = useReadContracts({
    contracts: [
      { ...pool, functionName: 'getUserAccountData', args: [user ?? zeroAddress] },
      { ...pool, functionName: 'getUserEMode', args: [user ?? zeroAddress] },
      { chainId, address: collateral.address, abi: erc20Abi, functionName: 'balanceOf', args: [user ?? zeroAddress] },
      { chainId, address: collateral.address, abi: erc20Abi, functionName: 'allowance', args: [user ?? zeroAddress, spender] },
      { chainId, address: reserves?.collateral.aToken ?? zeroAddress, abi: erc20Abi, functionName: 'balanceOf', args: [user ?? zeroAddress] },
      { chainId, address: reserves?.collateral.aToken ?? zeroAddress, abi: erc20Abi, functionName: 'allowance', args: [user ?? zeroAddress, spender] },
      { chainId, address: reserves?.debt.variableDebtToken ?? zeroAddress, abi: debtTokenAbi, functionName: 'balanceOf', args: [user ?? zeroAddress] },
      {
        chainId,
        address: reserves?.debt.variableDebtToken ?? zeroAddress,
        abi: debtTokenAbi,
        functionName: 'borrowAllowance',
        args: [user ?? zeroAddress, spender],
      },
    ],
    allowFailure: false,
    query: { enabled: !DEMO && !!user && !!reserves, refetchInterval: 15_000 },
  })

  const userState = useMemo((): UserState | undefined => {
    if (DEMO && reserves) return demoUser(reserves.collateral, reserves.debt)
    if (!userReads.data) return undefined
    const [acc, emode, bal, allow, aBal, aAllow, dBal, bAllow] = userReads.data
    return {
      account: { collateralBase: acc[0], debtBase: acc[1], liquidationThresholdBps: acc[3] },
      healthFactor: acc[1] === 0n ? Infinity : Number(acc[5]) / 1e18,
      eModeCategory: Number(emode),
      collateralBalance: bal,
      collateralAllowance: executor ? allow : 0n,
      aTokenBalance: aBal,
      aTokenAllowance: executor ? aAllow : 0n,
      debtBalance: dBal,
      borrowAllowance: executor ? bAllow : 0n,
    }
  }, [userReads.data, reserves, executor])

  const error = DEMO ? null : (provider.error ?? oracle.error ?? reads.error)
  return {
    reserves,
    user: userState,
    loading: !DEMO && (reads.isLoading || provider.isLoading || oracle.isLoading),
    error,
    refetchUser: userReads.refetch,
  }
}

export type Reserves = {
  market: Market
  emode?: EModeCategory
  campaigns?: Campaign[]
  collateral: Reserve
  debt: Reserve
  premiumBps: bigint
  /** oracle price of the chain's wrapped native token (gas), when Aave lists it */
  nativePrice?: bigint
}

/** Aave eMode category (v3.2+ layout): higher LTV for its collateral assets, borrowing limited to its list. */
export type EModeCategory = {
  id: number
  label: string
  ltvBps: number
  liquidationThresholdBps: number
  liquidationBonusBps: number
  collateralBitmap: bigint
  borrowableBitmap: bigint
  ltvZeroBitmap: bigint
}

/** Highest category id probed: Ethereum Core gives each PT its own categories (up to 48 in Nov. 2026). */
const MAX_EMODE_ID = 80
const EMODE_FNS = [
  'getEModeCategoryLabel',
  'getEModeCategoryCollateralConfig',
  'getEModeCategoryCollateralBitmap',
  'getEModeCategoryBorrowableBitmap',
  'getEModeCategoryLtvzeroBitmap',
] as const

/** All eMode categories of the market. Empty on a pool without the v3.2 eMode getters. */
export function useEModeCategories(market: Market): EModeCategory[] {
  const chainId = market.chain.id
  const reads = useReadContracts({
    contracts: Array.from({ length: MAX_EMODE_ID }, (_, i) =>
      EMODE_FNS.map((functionName) => ({ chainId, address: market.pool, abi: poolAbi, functionName, args: [i + 1] }) as const),
    ).flat(),
    allowFailure: true,
    query: { enabled: !DEMO, staleTime: 600_000 },
  })
  return useMemo(() => {
    const out: EModeCategory[] = []
    if (!reads.data) return out
    for (let i = 0; i < MAX_EMODE_ID; i++) {
      const [label, config, collat, borrow, ltvZero] = reads.data.slice(i * EMODE_FNS.length, (i + 1) * EMODE_FNS.length).map((r) => r.result)
      const c = config as { ltv: number; liquidationThreshold: number; liquidationBonus: number } | undefined
      if (!c || c.liquidationThreshold === 0) continue // unused id
      out.push({
        id: i + 1,
        label: (label as string) || `catégorie ${i + 1}`,
        ltvBps: c.ltv,
        liquidationThresholdBps: c.liquidationThreshold,
        liquidationBonusBps: c.liquidationBonus,
        collateralBitmap: (collat as bigint) ?? 0n,
        borrowableBitmap: (borrow as bigint) ?? 0n,
        ltvZeroBitmap: (ltvZero as bigint) ?? 0n,
      })
    }
    return out
  }, [reads.data])
}

const hasBit = (bitmap: bigint, id: number) => ((bitmap >> BigInt(id)) & 1n) === 1n

/** Categories in which the collateral counts with the category LTV and the debt asset can be borrowed, best LTV first. */
export function eligibleEModes(categories: EModeCategory[], collateral: Reserve, debt: Reserve): EModeCategory[] {
  return categories
    .filter((c) => hasBit(c.collateralBitmap, collateral.id) && !hasBit(c.ltvZeroBitmap, collateral.id) && hasBit(c.borrowableBitmap, debt.id))
    .sort((a, b) => b.ltvBps - a.ltvBps || a.id - b.id)
}

/**
 * Whether `debt` can be borrowed by an account in `emode` (none: outside eMode). Since Aave v3.6 (pool revision 12) a
 * category's borrowable bitmap replaces the reserve's « borrowing enabled » flag inside eMode: WETH on Monad or MegaETH,
 * wstETH on Ethereum, Base or Arbitrum are borrowable only inside their eMode.
 */
export function canBorrow(debt: Reserve, emode?: EModeCategory): boolean {
  const c = debt.config
  return c.active && !c.paused && !c.frozen && (emode ? hasBit(emode.borrowableBitmap, debt.id) : c.borrowingEnabled)
}

/** The pair as Aave sees it inside the category: the collateral's LTV and liquidation threshold are the category's. */
export function withEMode(reserves: Reserves, category?: EModeCategory): Reserves {
  if (!category) return { ...reserves, emode: undefined }
  const C = reserves.collateral
  return {
    ...reserves,
    emode: category,
    collateral: {
      ...C,
      config: {
        ...C.config,
        ltvBps: category.ltvBps,
        liquidationThresholdBps: category.liquidationThresholdBps,
        liquidationBonusBps: category.liquidationBonusBps,
      },
    },
  }
}

/** Adds the headline Merkl reward APRs of each reserve and keeps the campaigns for the pair-level computation. */
export function withIncentives(reserves: Reserves, campaigns: Campaign[] | undefined): Reserves {
  const add = (r: Reserve): Reserve => {
    const rw = headlineRewards(campaigns, r)
    return { ...r, supplyRewardApr: rw.supply, borrowRewardApr: rw.borrow }
  }
  return { ...reserves, campaigns, collateral: add(reserves.collateral), debt: add(reserves.debt) }
}
