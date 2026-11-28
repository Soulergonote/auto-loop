/**
 * A pair of an Aave v4 spoke as read on chain: oracle prices, the user's position (supplied collateral, debt, health
 * factor, risk premium), what the once-per-spoke setup still lacks, the Taker allowances of the executor, and what
 * Morpho can flash-lend of the debt asset. Rates and caps come from the API reserves (reserves.ts).
 *
 * The shared loop math (protocols/morpho/markets: health factor, leverage, debt for a leverage) works on a price of
 * the collateral in debt units scaled 1e36 and a liquidation threshold in WAD: `v4Price` and `v4Lltv` give both, so
 * a v4 pair computes exactly like an isolated market.
 */
import type { Address } from 'viem'
import { readContracts } from '@wagmi/core'
import { wagmiConfig } from '../../chain/wagmi'
import { erc20Abi, v4OracleAbi, v4SpokeAbi, v4TakerAbi } from '../../chain/abi'
import type { V4NetDef } from '../../config'
import type { Side } from '../../domain/math'
import type { V4Reserve } from './reserves'
import { adjustedRate, type AdjustedRate } from '../../domain/irm'

const WAD = 10n ** 18n
const ORACLE_SCALE = 10n ** 36n

/** A loop on v4: one collateral reserve and one debt reserve of the same spoke. */
export type V4Pair = { collateral: V4Reserve; debt: V4Reserve }
export const v4PairKey = (p: V4Pair) => `${p.collateral.chainId}:${p.collateral.spoke.address.toLowerCase()}:${p.collateral.reserveId}:${p.debt.reserveId}`

export type V4User = {
  /** collateral supplied and debt owed on the pair's two reserves, interest to now included */
  collateral: bigint
  debt: bigint
  /** the account's health factor on the spoke (every reserve counted), Infinity without debt */
  healthFactor: number
  /** risk premium of the account, as a fraction of the base borrow rate */
  riskPremium: number
  /** the account holds other collaterals or debts on this spoke: the pair's figures do not describe it all */
  otherPositions: boolean
  /** once-per-spoke setup */
  giverSet: boolean
  takerSet: boolean
  collateralEnabled: boolean
  /** what the executor may borrow / withdraw for the user through the Taker */
  borrowAllowance: bigint
  withdrawAllowance: bigint
  /** next nonce of the Taker's permits (key 0) */
  permitNonce: bigint
  collateralBalance: bigint
  debtBalance: bigint
  collateralAllowance: bigint
  debtAllowance: bigint
}

export type V4State = {
  /** oracle prices in USD, 8 decimals */
  collateralPrice: bigint
  debtPrice: bigint
  /** debt units per collateral unit x 1e36 (decimals included), as a Morpho oracle would give it */
  price: bigint
  /** liquidation threshold (the collateral factor), WAD */
  lltv: bigint
  /** debt asset Morpho can flash-lend now */
  flashLiquidity: bigint
  /** debt asset the spoke can still lend and collateral it can still take, from the API's caps */
  borrowable: bigint
  suppliable: bigint
  user?: V4User
}

/** Price of the collateral in debt units, 1e36 scale with both tokens' decimals folded in. Pure, tested. */
export function v4Price(collateralPrice: bigint, collateralDecimals: number, debtPrice: bigint, debtDecimals: number): bigint {
  if (debtPrice === 0n) return 0n
  return (collateralPrice * ORACLE_SCALE * 10n ** BigInt(debtDecimals)) / (debtPrice * 10n ** BigInt(collateralDecimals))
}

export const v4Lltv = (collateralFactor: number) => BigInt(Math.round(collateralFactor * 1e6)) * 10n ** 12n

/** USD amount (API) to token units at an 8-decimal price; 0 when the price is unknown. */
export function usdToUnits(usd: number, price: bigint, decimals: number): bigint {
  if (price <= 0n || !(usd > 0)) return 0n
  return (BigInt(Math.floor(usd * 1e6)) * 10n ** BigInt(decimals) * 100n) / price
}

export const v4Sides = (p: V4Pair, s: Pick<V4State, 'collateralPrice' | 'debtPrice'>): { collateral: Side; loan: Side } => ({
  collateral: { price: s.collateralPrice, decimals: p.collateral.token.decimals },
  loan: { price: s.debtPrice, decimals: p.debt.token.decimals },
})

/** Borrow cost on v4: the reserve's base rate plus the risk premium the collateral adds, a share of that rate. */
export const v4BorrowApy = (baseApy: number, riskPremium: number) => baseApy * (1 + riskPremium)

/**
 * Lending rate of a v4 reserve and borrow rate of another (risk premium included), today and right after `change`
 * (USD) lands on their hub assets: the hub's curve (reserves.ts), the premium applied on top of the base rate after.
 */
export function v4AdjustedRates(
  collateral: V4Reserve,
  debt: V4Reserve,
  riskPremium: number,
  change: { supply?: number; borrow?: number },
): { supply: AdjustedRate; borrow: AdjustedRate } {
  const supply = adjustedRate(collateral.supplyApy, collateral.curve, { supply: change.supply }, 'supply')
  const base = adjustedRate(debt.borrowApy, debt.curve, { borrow: change.borrow }, 'borrow')
  const borrow: AdjustedRate = { now: v4BorrowApy(base.now, riskPremium) }
  if (base.after !== undefined) borrow.after = v4BorrowApy(base.after, riskPremium)
  return { supply, borrow }
}

const hfNumber = (x: bigint) => (x >= 2n ** 255n ? Infinity : Number(x / 10n ** 9n) / 1e9)

export async function readV4State(net: V4NetDef, pair: V4Pair, user?: Address, executor?: Address): Promise<V4State> {
  const chainId = net.chain.id
  const spoke = pair.collateral.spoke.address
  const C = pair.collateral
  const D = pair.debt
  const [oracle] = await readContracts(wagmiConfig, {
    contracts: [{ chainId, address: spoke, abi: v4SpokeAbi, functionName: 'ORACLE' }],
    allowFailure: false,
  })
  const base = [
    { chainId, address: oracle, abi: v4OracleAbi, functionName: 'getReservePrice', args: [BigInt(C.reserveId)] },
    { chainId, address: oracle, abi: v4OracleAbi, functionName: 'getReservePrice', args: [BigInt(D.reserveId)] },
    { chainId, address: D.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [net.morpho] },
  ] as const
  const [collateralPrice, debtPrice, flashLiquidity] = await readContracts(wagmiConfig, { contracts: base, allowFailure: false })
  const state: V4State = {
    collateralPrice,
    debtPrice,
    price: v4Price(collateralPrice, C.token.decimals, debtPrice, D.token.decimals),
    lltv: v4Lltv(C.collateralFactor),
    flashLiquidity,
    borrowable: usdToUnits(D.borrowableUsd, debtPrice, D.token.decimals),
    suppliable: usdToUnits(C.suppliableUsd, collateralPrice, C.token.decimals),
  }
  if (!user) return state
  const ex = executor ?? user
  const cId = BigInt(C.reserveId)
  const dId = BigInt(D.reserveId)
  const u = await readContracts(wagmiConfig, {
    allowFailure: false,
    contracts: [
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'getUserSuppliedAssets', args: [cId, user] },
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'getUserTotalDebt', args: [dId, user] },
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'getUserAccountData', args: [user] },
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'getUserReserveStatus', args: [cId, user] },
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'isPositionManager', args: [user, net.giver] },
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'isPositionManager', args: [user, net.taker] },
      { chainId, address: net.taker, abi: v4TakerAbi, functionName: 'borrowAllowance', args: [spoke, dId, user, ex] },
      { chainId, address: net.taker, abi: v4TakerAbi, functionName: 'withdrawAllowance', args: [spoke, cId, user, ex] },
      { chainId, address: net.taker, abi: v4TakerAbi, functionName: 'nonces', args: [user, 0n] },
      { chainId, address: C.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [user] },
      { chainId, address: D.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [user] },
      { chainId, address: C.token.address, abi: erc20Abi, functionName: 'allowance', args: [user, ex] },
      { chainId, address: D.token.address, abi: erc20Abi, functionName: 'allowance', args: [user, ex] },
    ],
  })
  const account = u[2]
  const collateral = u[0]
  const debt = u[1]
  // the pair alone accounts for the account when it is its only active collateral and its only debt
  const pairCollaterals = collateral > 0n && u[3][0] && C.collateralFactor > 0 ? 1n : 0n
  const pairDebts = debt > 0n ? 1n : 0n
  state.user = {
    collateral,
    debt,
    healthFactor: hfNumber(account.healthFactor),
    riskPremium: Number(account.riskPremium) / 10_000,
    otherPositions: account.activeCollateralCount > pairCollaterals || account.borrowCount > pairDebts,
    giverSet: u[4],
    takerSet: u[5],
    collateralEnabled: u[3][0],
    borrowAllowance: u[6],
    withdrawAllowance: u[7],
    permitNonce: u[8],
    collateralBalance: u[9],
    debtBalance: u[10],
    collateralAllowance: u[11],
    debtAllowance: u[12],
  }
  return state
}

export { WAD as V4_WAD }

/** One more reserve of a spoke, for a switch to it: oracle price, the user's position there, its flag and allowances. */
export type V4ReserveUser = {
  /** USD, 8 decimals */
  price: bigint
  supplied: bigint
  debt: bigint
  collateralEnabled: boolean
  /** what the executor may borrow / withdraw on this reserve for the user through the Taker */
  borrowAllowance: bigint
  withdrawAllowance: bigint
  /** of this reserve's token, what Morpho can flash-lend now */
  flashLiquidity: bigint
}

export async function readV4ReserveUser(net: V4NetDef, reserve: V4Reserve, user: Address, executor?: Address): Promise<V4ReserveUser> {
  const chainId = net.chain.id
  const spoke = reserve.spoke.address
  const id = BigInt(reserve.reserveId)
  const ex = executor ?? user
  const [oracle] = await readContracts(wagmiConfig, {
    contracts: [{ chainId, address: spoke, abi: v4SpokeAbi, functionName: 'ORACLE' }],
    allowFailure: false,
  })
  const r = await readContracts(wagmiConfig, {
    allowFailure: false,
    contracts: [
      { chainId, address: oracle, abi: v4OracleAbi, functionName: 'getReservePrice', args: [id] },
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'getUserSuppliedAssets', args: [id, user] },
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'getUserTotalDebt', args: [id, user] },
      { chainId, address: spoke, abi: v4SpokeAbi, functionName: 'getUserReserveStatus', args: [id, user] },
      { chainId, address: net.taker, abi: v4TakerAbi, functionName: 'borrowAllowance', args: [spoke, id, user, ex] },
      { chainId, address: net.taker, abi: v4TakerAbi, functionName: 'withdrawAllowance', args: [spoke, id, user, ex] },
      { chainId, address: reserve.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [net.morpho] },
    ],
  })
  return {
    price: r[0],
    supplied: r[1],
    debt: r[2],
    collateralEnabled: r[3][0],
    borrowAllowance: executor ? r[4] : 0n,
    withdrawAllowance: executor ? r[5] : 0n,
    flashLiquidity: r[6],
  }
}
