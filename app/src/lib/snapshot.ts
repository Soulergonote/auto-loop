/**
 * Everything one Aave market exposes, read in a few multicalls: reserves with rates, prices, caps and liquidity,
 * plus the eMode categories. Used by the scanner (every pair of every market) and the positions dashboard.
 */
import { readContract, readContracts } from '@wagmi/core'
import { zeroAddress, type Address } from 'viem'
import { wagmiConfig } from '../wagmi'
import { erc20Abi, oracleAbi, poolAbi, providerAbi, rateStrategyAbi } from '../abi'
import { aaveModelMatches, type AaveIrm } from './irm'
import type { Market, Token } from '../config'
import { decodeReserveConfig, rayAprToApy } from './aave'
import { toBase } from './math'
import { readNativeYields } from './nativeYield'
import { ptYield, readPtInfos } from './pendle'
import type { EModeCategory, Reserve } from './useMarket'
import type { Holding } from './positions'

export type SnapReserve = Reserve & {
  /** underlying held by the aToken: what can be borrowed or withdrawn right now (base units) */
  cashBase: bigint
  totalSupplyBase: bigint
  totalDebtBase: bigint
  /** rate curve, when readable and it gives back today's rate (rates after the user's own loop, irm.ts) */
  irm?: AaveIrm
}

export type Snapshot = { market: Market; reserves: SnapReserve[]; emodes: EModeCategory[]; premiumBps: bigint }

const MAX_EMODE_ID = 80
const EMODE_FNS = [
  'getEModeCategoryLabel',
  'getEModeCategoryCollateralConfig',
  'getEModeCategoryCollateralBitmap',
  'getEModeCategoryBorrowableBitmap',
  'getEModeCategoryLtvzeroBitmap',
] as const

export async function loadSnapshot(market: Market): Promise<Snapshot> {
  const chainId = market.chain.id
  const pool = { chainId, address: market.pool, abi: poolAbi } as const
  const [list, provider, premium] = await readContracts(wagmiConfig, {
    contracts: [
      { ...pool, functionName: 'getReservesList' },
      { ...pool, functionName: 'ADDRESSES_PROVIDER' },
      { ...pool, functionName: 'FLASHLOAN_PREMIUM_TOTAL' },
    ],
    allowFailure: false,
  })
  const oracle = await readContract(wagmiConfig, { chainId, address: provider, abi: providerAbi, functionName: 'getPriceOracle' })

  const perReserve = await readContracts(wagmiConfig, {
    contracts: list.flatMap((asset) => [
      { ...pool, functionName: 'getReserveData', args: [asset] } as const,
      { chainId, address: asset, abi: erc20Abi, functionName: 'symbol' } as const,
    ]),
    allowFailure: true,
  })
  const [prices, emodeReads] = await Promise.all([
    readContract(wagmiConfig, { chainId, address: oracle, abi: oracleAbi, functionName: 'getAssetsPrices', args: [list] }),
    readContracts(wagmiConfig, {
      contracts: Array.from({ length: MAX_EMODE_ID }, (_, i) => EMODE_FNS.map((functionName) => ({ ...pool, functionName, args: [i + 1] }) as const)).flat(),
      allowFailure: true,
    }),
  ])

  const base = list.flatMap((asset, i) => {
    const rd = perReserve[2 * i].result as
      | {
          configuration: bigint
          id: number
          aTokenAddress: Address
          variableDebtTokenAddress: Address
          currentLiquidityRate: bigint
          currentVariableBorrowRate: bigint
          interestRateStrategyAddress: Address
        }
      | undefined
    if (!rd || rd.aTokenAddress === zeroAddress) return []
    const config = decodeReserveConfig(rd.configuration)
    const symbol = (perReserve[2 * i + 1].result as string | undefined) ?? `${asset.slice(0, 6)}…`
    const token: Token = { address: asset, symbol, name: symbol, decimals: config.decimals }
    const price = prices[i]
    return [{ token, rd, config, price }]
  })

  const [amounts, native, pts, curves] = await Promise.all([
    readContracts(wagmiConfig, {
      contracts: base.flatMap(({ token, rd }) => [
        { chainId, address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [rd.aTokenAddress] } as const,
        { chainId, address: rd.aTokenAddress, abi: erc20Abi, functionName: 'totalSupply' } as const,
        { chainId, address: rd.variableDebtTokenAddress, abi: erc20Abi, functionName: 'totalSupply' } as const,
      ]),
      allowFailure: true,
    }),
    // a failed read only leaves the intrinsic yield out
    readNativeYields(
      chainId,
      oracle,
      base.map((b) => b.token.address),
    ).catch(() => new Map()),
    // Pendle PTs (maturity, fixed yield); a failed read leaves them as plain tokens
    readPtInfos(
      chainId,
      base.map((b) => b.token.address),
    ).catch(() => new Map()),
    // rate curves (Aave v3.2+ strategy); a failed read only leaves the rates after the user's loop out
    readContracts(wagmiConfig, {
      contracts: base.map(
        ({ token, rd }) =>
          ({ chainId, address: rd.interestRateStrategyAddress, abi: rateStrategyAbi, functionName: 'getInterestRateDataBps', args: [token.address] }) as const,
      ),
      allowFailure: true,
    }).catch(() => []),
  ])

  const reserves: SnapReserve[] = base.map(({ token, rd, config, price }, i) => {
    const side = { price, decimals: config.decimals }
    const amount = (k: number) => toBase((amounts[3 * i + k].result as bigint | undefined) ?? 0n, side)
    const pt = pts.get(token.address.toLowerCase())
    const curve = curves[i]?.result as
      | { optimalUsageRatio: number; baseVariableBorrowRate: number; variableRateSlope1: number; variableRateSlope2: number }
      | undefined
    const irm: AaveIrm | undefined = curve && {
      optimal: curve.optimalUsageRatio / 1e4,
      base: curve.baseVariableBorrowRate / 1e4,
      slope1: curve.variableRateSlope1 / 1e4,
      slope2: curve.variableRateSlope2 / 1e4,
      reserveFactor: Number((rd.configuration >> 64n) & 0xffffn) / 1e4,
    }
    const cashBase = amount(0)
    const totalDebtBase = amount(2)
    const borrowApy = rayAprToApy(rd.currentVariableBorrowRate)
    return {
      token,
      native: pt ? ptYield(pt) : native.get(token.address.toLowerCase()),
      pt,
      id: rd.id,
      config,
      aToken: rd.aTokenAddress,
      variableDebtToken: rd.variableDebtTokenAddress,
      supplyApy: rayAprToApy(rd.currentLiquidityRate),
      borrowApy,
      supplyRewardApr: 0,
      borrowRewardApr: 0,
      price,
      side,
      cashBase,
      totalSupplyBase: amount(1),
      totalDebtBase,
      irm: irm && irm.optimal > 0 && irm.optimal < 1 && aaveModelMatches(irm, Number(cashBase), Number(totalDebtBase), borrowApy) ? irm : undefined,
    }
  })

  const emodes: EModeCategory[] = []
  for (let i = 0; i < MAX_EMODE_ID; i++) {
    const [label, cfg, collat, borrow, ltvZero] = emodeReads.slice(i * EMODE_FNS.length, (i + 1) * EMODE_FNS.length).map((x) => x.result)
    const c = cfg as { ltv: number; liquidationThreshold: number; liquidationBonus: number } | undefined
    if (!c || c.liquidationThreshold === 0) continue
    emodes.push({
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

  return { market, reserves, emodes, premiumBps: BigInt(premium) }
}

/** Snapshot of a market, cached a minute and shared by the scanner and the positions dashboard. */
export const snapshotQuery = (market: Market) => ({
  queryKey: ['snapshot', market.id],
  queryFn: () => loadSnapshot(market),
  staleTime: 60_000,
  retry: 1,
})

export type UserPosition = { holdings: Holding[]; healthFactor: number; eModeCategory: number }

/** An account's balances on every reserve of the market, its health factor and eMode. */
export async function loadUserPosition(snapshot: Snapshot, user: Address): Promise<UserPosition> {
  const chainId = snapshot.market.chain.id
  const pool = { chainId, address: snapshot.market.pool, abi: poolAbi } as const
  const [[account, emode], balances] = await Promise.all([
    readContracts(wagmiConfig, {
      contracts: [
        { ...pool, functionName: 'getUserAccountData', args: [user] },
        { ...pool, functionName: 'getUserEMode', args: [user] },
      ],
      allowFailure: false,
    }),
    readContracts(wagmiConfig, {
      contracts: snapshot.reserves.flatMap((r) => [
        { chainId, address: r.aToken, abi: erc20Abi, functionName: 'balanceOf', args: [user] } as const,
        { chainId, address: r.variableDebtToken, abi: erc20Abi, functionName: 'balanceOf', args: [user] } as const,
      ]),
      allowFailure: false,
    }),
  ])
  const holdings = snapshot.reserves
    .map((reserve, i) => {
      const supplied = balances[2 * i]
      const borrowed = balances[2 * i + 1]
      return { reserve, supplied, borrowed, suppliedBase: toBase(supplied, reserve.side), borrowedBase: toBase(borrowed, reserve.side) }
    })
    .filter((h) => h.supplied > 0n || h.borrowed > 0n)
  return { holdings, healthFactor: account[1] === 0n ? Infinity : Number(account[5]) / 1e18, eModeCategory: Number(emode) }
}

export const userPositionQuery = (snapshot: Snapshot | undefined, user: Address | undefined) => ({
  queryKey: ['position', snapshot?.market.id, user],
  queryFn: () => loadUserPosition(snapshot!, user!),
  enabled: !!snapshot && !!user,
  staleTime: 15_000,
  refetchInterval: 60_000,
  retry: 1,
})
