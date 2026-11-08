/**
 * "Changer de collatéral" (contract v2, `swapCollateral`): the new collateral is flash-borrowed and supplied first,
 * then the old one is withdrawn and swapped to repay the loan. The debt does not move. Pure helpers here; the
 * execution lives in execute.ts (step by step) and oneClick.ts (one batch).
 */
import { maxUint256, zeroAddress, type Address } from 'viem'
import { quoteSteps, type Quote } from './quotes'
import type { Account } from './math'
import type { EModeCategory, Reserve } from './useMarket'

const BPS = 10_000n

export type SwapCollateralPlan = {
  chainId: number
  executor: Address
  user: Address
  from: Address
  to: Address
  /** aToken of `from` */
  fromAToken: Address
  /** all the old collateral (the contract then pulls the balance at inclusion) */
  full: boolean
  /** aTokens to pull; for a full switch, the balance when quoted */
  fromAmount: bigint
  /** old -> new collateral, selling `fromAmount` */
  quote: Quote
  /** new collateral flash-borrowed and supplied first */
  toAmount: bigint
  flashLender: Address
  /** the call reverts if the account's health factor ends below this (1e18 = 1.00) */
  minHealthFactor: bigint
  aTokenAllowance: bigint
}

/**
 * New collateral to flash-borrow: the most the swap's guaranteed minimum can repay with the premium on top
 * (Aave rounds the premium half up: one unit of margin covers it). What the swap gives above is supplied too.
 */
export function flashAmountFor(minOut: bigint, premiumBps: bigint): bigint {
  if (premiumBps === 0n) return minOut
  const x = (minOut * BPS) / (BPS + premiumBps)
  return x > 1n ? x - 1n : 0n
}

const callDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

export function swapCollateralArgs(
  p: Pick<SwapCollateralPlan, 'from' | 'to' | 'full' | 'fromAmount' | 'quote' | 'toAmount' | 'flashLender' | 'minHealthFactor'>,
) {
  if (p.quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
  if (p.quote.sellAmount !== p.fromAmount) throw new Error('Devis pour un autre montant que le collatéral retiré')
  if (p.toAmount === 0n || p.toAmount > p.quote.minOut) throw new Error('Montant du flash loan incohérent avec le devis')
  if (!p.flashLender || p.flashLender === zeroAddress) throw new Error('Prêteur du flash loan non choisi')
  return {
    fromAsset: p.from,
    toAsset: p.to,
    fromAmount: p.full ? maxUint256 : p.fromAmount,
    toAmount: p.toAmount,
    steps: quoteSteps(p.quote, p.to),
    flashLender: p.flashLender,
    guard: { minHealthFactor: p.minHealthFactor, deadline: callDeadline() },
  } as const
}

/** aTokens the executor needs the right to pull: a full switch pulls the balance at inclusion, which keeps growing. */
export const aTokensToApprove = (p: Pick<SwapCollateralPlan, 'full' | 'fromAmount'>) => (p.full ? (p.fromAmount * 1001n) / 1000n : p.fromAmount)

const hasBit = (bitmap: bigint, id: number) => ((bitmap >> BigInt(id)) & 1n) === 1n

/**
 * Collaterals the position can move to: accepted as collateral (LTV > 0, active, not frozen or paused, not isolated),
 * neither the current collateral nor the debt asset, and, for an account in eMode, part of its category.
 */
export function swapTargets(reserves: Reserve[], from: Address, debt: Address, emode?: EModeCategory): Reserve[] {
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()
  return reserves.filter(
    (r) =>
      !same(r.token.address, from) &&
      !same(r.token.address, debt) &&
      r.config.ltvBps > 0 &&
      r.config.active &&
      !r.config.frozen &&
      !r.config.paused &&
      !r.config.isolated &&
      (!emode || (hasBit(emode.collateralBitmap, r.id) && !hasBit(emode.ltvZeroBitmap, r.id))),
  )
}

/** Liquidation threshold that applies to the account's new collateral (its eMode category's when in one). */
export const thresholdIn = (r: Reserve, emode?: EModeCategory) => (emode ? emode.liquidationThresholdBps : r.config.liquidationThresholdBps)

/**
 * Account after `removedBase` of collateral (threshold `removedLtBps`) is replaced by `addedBase` of another
 * (threshold `addedLtBps`), the debt unchanged.
 */
export function projectSwap(account: Account, removedBase: bigint, removedLtBps: number, addedBase: bigint, addedLtBps: number) {
  const collateralBase = account.collateralBase - removedBase + addedBase
  const weighted = account.collateralBase * account.liquidationThresholdBps - removedBase * BigInt(removedLtBps) + addedBase * BigInt(addedLtBps)
  const healthFactor = account.debtBase === 0n ? Infinity : Math.max(0, Number(weighted)) / Number(BPS) / Number(account.debtBase)
  return {
    collateralBase,
    healthFactor,
    /** drop of all collaterals together, against the debt, that triggers liquidation */
    dropToLiquidation: Number.isFinite(healthFactor) ? Math.max(0, 1 - 1 / healthFactor) : 1,
  }
}

/**
 * PTs a PT collateral can be rolled into: a later maturity, still trading on Pendle. Same underlying (same SY)
 * first, then the nearest maturity.
 */
export function rollTargets(targets: Reserve[], from: Reserve, nowSec = Date.now() / 1000): Reserve[] {
  const pt = from.pt
  if (!pt) return []
  const sameSy = (r: Reserve) => r.pt!.sy.toLowerCase() === pt.sy.toLowerCase()
  return targets
    .filter((r) => r.pt && r.pt.market && !r.pt.expired && r.pt.expiry > nowSec && r.pt.expiry > pt.expiry)
    .sort((a, b) => Number(sameSy(b)) - Number(sameSy(a)) || a.pt!.expiry - b.pt!.expiry)
}
