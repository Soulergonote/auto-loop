import { useMemo } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { zeroAddress, type Address } from 'viem'
import { poolAbi, providerAbi, oracleAbi, erc20Abi, debtTokenAbi } from '../abi'
import { DEMO, DEMO_TOKENS, type Market, type Token } from '../config'
import { demoReserve, demoUser } from './demo'
import { decodeReserveConfig, rayAprToApy, type ReserveConfig } from './aave'
import type { Account, Side } from './math'

export type Reserve = {
  token: Token
  config: ReserveConfig
  aToken: Address
  variableDebtToken: Address
  supplyApy: number
  borrowApy: number
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
export function useMarket(market: Market, collateral: Token, debt: Token, user?: Address) {
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
        args: [[collateral.address, debt.address]],
      },
    ],
    allowFailure: false,
    query: { enabled: !!oracle.data, refetchInterval: 30_000 },
  })

  const reserves = useMemo(() => {
    if (DEMO) return { market, collateral: demoReserve(collateral), debt: demoReserve(debt), premiumBps: 5n }
    if (!reads.data) return undefined
    const [rc, rd, premium, prices] = reads.data
    const build = (token: Token, r: typeof rc, price: bigint): Reserve => {
      const config = decodeReserveConfig(r.configuration)
      return {
        token: { ...token, decimals: config.decimals },
        config,
        aToken: r.aTokenAddress,
        variableDebtToken: r.variableDebtTokenAddress,
        supplyApy: rayAprToApy(r.currentLiquidityRate),
        borrowApy: rayAprToApy(r.currentVariableBorrowRate),
        price,
        side: { price, decimals: config.decimals },
      }
    }
    if (rc.aTokenAddress === zeroAddress || rd.aTokenAddress === zeroAddress) return null // not listed
    return { market, collateral: build(collateral, rc, prices[0]), debt: build(debt, rd, prices[1]), premiumBps: BigInt(premium) }
  }, [reads.data, market, collateral, debt])

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

export type Reserves = { market: Market; collateral: Reserve; debt: Reserve; premiumBps: bigint }
