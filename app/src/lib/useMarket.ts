import { useMemo } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { zeroAddress, type Address } from 'viem'
import { poolAbi, providerAbi, oracleAbi, erc20Abi, debtTokenAbi } from '../abi'
import { AAVE_V3_BASE, DEMO, EXECUTOR, type Token } from '../config'
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

const pool = { address: AAVE_V3_BASE.pool, abi: poolAbi } as const

/** Reads both reserves of the pair, oracle prices, the flash loan premium and, when connected, the user's state. */
export function useMarket(collateral: Token, debt: Token, user?: Address) {
  const provider = useReadContract({ ...pool, functionName: 'ADDRESSES_PROVIDER', query: { enabled: !DEMO } })
  const oracle = useReadContract({
    address: provider.data,
    abi: providerAbi,
    functionName: 'getPriceOracle',
    query: { enabled: !!provider.data },
  })

  const market = useReadContracts({
    contracts: [
      { ...pool, functionName: 'getReserveData', args: [collateral.address] },
      { ...pool, functionName: 'getReserveData', args: [debt.address] },
      { ...pool, functionName: 'FLASHLOAN_PREMIUM_TOTAL' },
      {
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
    if (DEMO) return { collateral: demoReserve(collateral), debt: demoReserve(debt), premiumBps: 5n }
    if (!market.data) return undefined
    const [rc, rd, premium, prices] = market.data
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
    return { collateral: build(collateral, rc, prices[0]), debt: build(debt, rd, prices[1]), premiumBps: BigInt(premium) }
  }, [market.data, collateral, debt])

  const spender = EXECUTOR ?? zeroAddress
  const userReads = useReadContracts({
    contracts: [
      { ...pool, functionName: 'getUserAccountData', args: [user ?? zeroAddress] },
      { ...pool, functionName: 'getUserEMode', args: [user ?? zeroAddress] },
      { address: collateral.address, abi: erc20Abi, functionName: 'balanceOf', args: [user ?? zeroAddress] },
      { address: collateral.address, abi: erc20Abi, functionName: 'allowance', args: [user ?? zeroAddress, spender] },
      { address: reserves?.collateral.aToken ?? zeroAddress, abi: erc20Abi, functionName: 'balanceOf', args: [user ?? zeroAddress] },
      { address: reserves?.collateral.aToken ?? zeroAddress, abi: erc20Abi, functionName: 'allowance', args: [user ?? zeroAddress, spender] },
      { address: reserves?.debt.variableDebtToken ?? zeroAddress, abi: debtTokenAbi, functionName: 'balanceOf', args: [user ?? zeroAddress] },
      {
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
      collateralAllowance: EXECUTOR ? allow : 0n,
      aTokenBalance: aBal,
      aTokenAllowance: EXECUTOR ? aAllow : 0n,
      debtBalance: dBal,
      borrowAllowance: EXECUTOR ? bAllow : 0n,
    }
  }, [userReads.data, reserves])

  const error = DEMO ? null : (provider.error ?? oracle.error ?? market.error)
  return {
    reserves,
    user: userState,
    loading: !DEMO && (market.isLoading || provider.isLoading || oracle.isLoading),
    error,
    refetchUser: userReads.refetch,
  }
}

export type Reserves = { collateral: Reserve; debt: Reserve; premiumBps: bigint }
