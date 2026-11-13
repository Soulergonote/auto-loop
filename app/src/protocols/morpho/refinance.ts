/**
 * Refinancing between Aave v3 and Morpho Blue (LeverageExecutorMorpho.refinance): the same collateral and debt move
 * from one protocol to the other in one transaction, without a swap. What the Aave side looks like before and after,
 * read from the pool's snapshot and the user's account.
 */
import { readContracts } from '@wagmi/core'
import { zeroAddress, type Address } from 'viem'
import { wagmiConfig } from '../../chain/wagmi'
import { debtTokenAbi, erc20Abi, poolAbi } from '../../chain/abi'
import { toBase, type Account, type Side } from '../../domain/math'
import { canBorrow, eligibleEModes, type EModeCategory } from '../aave/useMarket'
import type { Snapshot, SnapReserve } from '../aave/snapshot'

const BPS = 10_000n
/** 1 $ in Aave base units */
const DUST_BASE = 100_000_000n
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

/** The pair on an Aave pool, as the user's account would hold it. */
export type AavePair = {
  collateral: SnapReserve
  debt: SnapReserve
  /** the eMode the collateral and the debt are counted in (the account's, or the one to switch an empty account to) */
  emode?: EModeCategory
  /** collateral LTV and liquidation threshold in that eMode, bps */
  ltvBps: number
  ltBps: number
}

/** The user's Aave account and its holdings of the pair. */
export type AaveSide = {
  account: Account & { ltvBps: bigint }
  healthFactor: number
  eModeCategory: number
  supplied: bigint
  borrowed: bigint
  /** what the executor may take now: aToken allowance and credit delegation */
  aTokenAllowance: bigint
  borrowAllowance: bigint
}

/**
 * The pair on this pool for an account in eMode `accountEMode` (0: none). An account without anything on the pool can
 * be switched to the best eMode of the pair first (`switchTo`). Undefined when the pool does not list both, the
 * collateral cannot be supplied as collateral or the debt cannot be borrowed in that eMode.
 */
export function aavePair(
  snapshot: Snapshot,
  collateral: Address,
  loan: Address,
  accountEMode: number,
  emptyAccount: boolean,
): (AavePair & { switchTo?: number }) | undefined {
  const C = snapshot.reserves.find((r) => same(r.token.address, collateral))
  const D = snapshot.reserves.find((r) => same(r.token.address, loan))
  if (!C || !D) return undefined
  if (!C.config.active || C.config.frozen || C.config.paused) return undefined
  // an empty account takes the pair's best eMode (or none); a used one keeps its own, which only the user can change
  const best = eligibleEModes(snapshot.emodes, C, D)[0]
  const emode = emptyAccount ? best : accountEMode > 0 ? snapshot.emodes.find((e) => e.id === accountEMode) : undefined
  const switchTo = emptyAccount && (best?.id ?? 0) !== accountEMode ? (best?.id ?? 0) : undefined
  // inside an eMode the collateral counts with the category's parameters only when it belongs to it
  const inCategory = emode && eligibleEModes([emode], C, D).length > 0
  const ltvBps = inCategory ? emode.ltvBps : C.config.ltvBps
  const ltBps = inCategory ? emode.liquidationThresholdBps : C.config.liquidationThresholdBps
  if (ltBps === 0 || !canBorrow(D, emode)) return undefined
  return { collateral: C, debt: D, emode, ltvBps, ltBps, switchTo }
}

/** Reads the user's account on the pool and the pair's balances and allowances to the executor. */
export async function readAaveSide(chainId: number, pool: Address, pair: AavePair, user: Address, executor?: Address): Promise<AaveSide> {
  const spender = executor ?? zeroAddress
  const [acc, emode, aBal, aAllow, dBal, dAllow] = await readContracts(wagmiConfig, {
    contracts: [
      { chainId, address: pool, abi: poolAbi, functionName: 'getUserAccountData', args: [user] },
      { chainId, address: pool, abi: poolAbi, functionName: 'getUserEMode', args: [user] },
      { chainId, address: pair.collateral.aToken, abi: erc20Abi, functionName: 'balanceOf', args: [user] },
      { chainId, address: pair.collateral.aToken, abi: erc20Abi, functionName: 'allowance', args: [user, spender] },
      { chainId, address: pair.debt.variableDebtToken, abi: debtTokenAbi, functionName: 'balanceOf', args: [user] },
      { chainId, address: pair.debt.variableDebtToken, abi: debtTokenAbi, functionName: 'borrowAllowance', args: [user, spender] },
    ],
    allowFailure: false,
  })
  return {
    account: { collateralBase: acc[0], debtBase: acc[1], liquidationThresholdBps: acc[3], ltvBps: acc[4] },
    healthFactor: acc[1] === 0n ? Infinity : Number(acc[5]) / 1e18,
    eModeCategory: Number(emode),
    supplied: aBal,
    borrowed: dBal,
    aTokenAllowance: executor ? aAllow : 0n,
    borrowAllowance: executor ? dAllow : 0n,
  }
}

const hfOf = (weightedLt: bigint, debtBase: bigint) => (debtBase <= 0n ? Infinity : Number(weightedLt) / Number(BPS) / Number(debtBase))

/**
 * The Aave account once `coll` of collateral (liquidation threshold `ltBps`, LTV `ltvBps`) and `debt` are added
 * (`sign` 1) or taken out (`sign` -1). `ltvOk`: Aave lets the debt be borrowed (debt within the weighted LTV), checked
 * only when adding.
 */
export function aaveAccountAfter(
  acc: Account & { ltvBps: bigint },
  coll: bigint,
  collSide: Side,
  ltBps: number,
  ltvBps: number,
  debt: bigint,
  debtSide: Side,
  sign: 1 | -1,
): { healthFactor: number; collateralBase: bigint; debtBase: bigint; ltvOk: boolean } {
  const c = toBase(coll, collSide)
  const d = toBase(debt, debtSide)
  const s = BigInt(sign)
  const max0 = (x: bigint) => (x > 0n ? x : 0n)
  // taking out: what is left within 0.1 % (+ 1 $) of what leaves is the rounding between the balances and the account
  // totals (read in different calls, interest in between), not a position
  const dust = (left: bigint, moved: bigint) => (sign < 0 && left <= moved / 1000n + DUST_BASE ? 0n : left)
  const collateralBase = dust(max0(acc.collateralBase + s * c), c)
  const debtBase = dust(max0(acc.debtBase + s * d), d)
  const weightedLt = max0(acc.collateralBase * acc.liquidationThresholdBps + s * c * BigInt(ltBps))
  const weightedLtv = max0(acc.collateralBase * acc.ltvBps + s * c * BigInt(ltvBps))
  return { healthFactor: hfOf(weightedLt, debtBase), collateralBase, debtBase, ltvOk: sign < 0 || debtBase * BPS <= weightedLtv }
}

/** Debt `amount` the pool can lend now: its cash and the room under the borrow cap, in base units. */
export function aaveBorrowRoomBase(D: SnapReserve): bigint {
  if (D.config.borrowCap === 0n) return D.cashBase
  const cap = D.config.borrowCap * D.price
  const left = cap > D.totalDebtBase ? cap - D.totalDebtBase : 0n
  return left < D.cashBase ? left : D.cashBase
}

/** Room under the collateral's supply cap, in base units (none: unlimited). */
export function aaveSupplyRoomBase(C: SnapReserve): bigint | undefined {
  if (C.config.supplyCap === 0n) return undefined
  const cap = C.config.supplyCap * C.price
  return cap > C.totalSupplyBase ? cap - C.totalSupplyBase : 0n
}

/** Yearly cost of borrowing / yield of supplying on Aave, rewards included (the collateral's own yield excluded). */
export const aaveBorrowNet = (D: SnapReserve) => D.borrowApy - D.borrowRewardApr
export const aaveSupplyNet = (C: SnapReserve) => C.supplyApy + C.supplyRewardApr
