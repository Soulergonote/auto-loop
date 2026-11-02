import { useMemo } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { zeroAddress, type Address } from 'viem'
import { poolAbi, providerAbi, oracleAbi, erc20Abi, debtTokenAbi } from '../abi'
import { DEMO, DEMO_TOKENS, type Market, type Token } from '../config'
import { demoReserve, demoUser } from './demo'
import { decodeReserveConfig, rayAprToApy, type ReserveConfig } from './aave'
import type { Account, Side } from './math'
import { headlineRewards, type Campaign } from './merkl'

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
  return { tokens, error: list.error ?? meta.error, loading: list.isLoading || meta.isLoading }
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

  const reserves = useMemo(() => {
    if (DEMO) return { market, collateral: demoReserve(collateral), debt: demoReserve(debt), premiumBps: 5n, nativePrice: undefined }
    if (!reads.data) return undefined
    const [rc, rd, premium, prices] = reads.data
    const build = (token: Token, r: typeof rc, price: bigint): Reserve => {
      const config = decodeReserveConfig(r.configuration)
      return {
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
    if (rc.aTokenAddress === zeroAddress || rd.aTokenAddress === zeroAddress) return null // not listed
    return {
      market,
      collateral: build(collateral, rc, prices[0]),
      debt: build(debt, rd, prices[1]),
      premiumBps: BigInt(premium),
      nativePrice: nativeToken ? prices[2] : undefined,
    }
  }, [reads.data, market, collateral, debt, nativeToken])

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

/** Highest category id probed: markets use far fewer (Base: 11 in Oct. 2026). */
const MAX_EMODE_ID = 40
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
