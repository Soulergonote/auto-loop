/**
 * Aave v4 positions of an address: every reserve of every spoke of a chain (API list) read on chain in one multicall
 * (supplied, debt, collateral flag), plus each spoke's account data (health factor, risk premium). Values in USD use
 * the API's prices; the Boucle screen reads the spoke's oracle before any action.
 */
import type { Address } from 'viem'
import { readContracts } from '@wagmi/core'
import { wagmiConfig } from '../../chain/wagmi'
import { v4SpokeAbi } from '../../chain/abi'
import type { V4Reserve } from './reserves'
import { v4BorrowApy } from './state'

export type V4Holding = {
  reserve: V4Reserve
  supplied: bigint
  debt: bigint
  /** the supply backs the account's debts */
  collateral: boolean
  /** USD, 1e8 = 1 $ */
  suppliedBase: bigint
  debtBase: bigint
}

export type V4SpokePosition = {
  chainId: number
  spoke: { name: string; address: Address }
  holdings: V4Holding[]
  /** Infinity without debt */
  healthFactor: number
  /** share of the base borrow rate added to it */
  riskPremium: number
}

const toBase = (amount: bigint, r: V4Reserve) => (amount * r.price) / 10n ** BigInt(r.token.decimals)
const hfNumber = (x: bigint) => (x >= 2n ** 255n ? Infinity : Number(x / 10n ** 9n) / 1e9)

/** Groups raw reads into one position per spoke; spokes where the address holds nothing are left out. Pure, tested. */
export function buildV4Positions(
  reserves: V4Reserve[],
  reads: { supplied: bigint; debt: bigint; collateral: boolean }[],
  accounts: Map<string, { healthFactor: bigint; riskPremium: bigint }>,
): V4SpokePosition[] {
  const by = new Map<string, V4SpokePosition>()
  reserves.forEach((reserve, i) => {
    const r = reads[i]
    if (!r || (r.supplied === 0n && r.debt === 0n)) return
    const k = reserve.spoke.address.toLowerCase()
    const account = accounts.get(k)
    const p = by.get(k) ?? {
      chainId: reserve.chainId,
      spoke: reserve.spoke,
      holdings: [],
      healthFactor: account ? hfNumber(account.healthFactor) : Infinity,
      riskPremium: account ? Number(account.riskPremium) / 10_000 : 0,
    }
    p.holdings.push({ reserve, ...r, suppliedBase: toBase(r.supplied, reserve), debtBase: toBase(r.debt, reserve) })
    by.set(k, p)
  })
  return [...by.values()]
}

export async function readV4Positions(chainId: number, all: V4Reserve[], user: Address): Promise<V4SpokePosition[]> {
  const reserves = all.filter((r) => r.chainId === chainId)
  if (reserves.length === 0) return []
  const spokes = [...new Set(reserves.map((r) => r.spoke.address))]
  const per = reserves.flatMap((r) => {
    const base = { chainId, address: r.spoke.address, abi: v4SpokeAbi } as const
    const id = BigInt(r.reserveId)
    return [
      { ...base, functionName: 'getUserSuppliedAssets', args: [id, user] } as const,
      { ...base, functionName: 'getUserTotalDebt', args: [id, user] } as const,
      { ...base, functionName: 'getUserReserveStatus', args: [id, user] } as const,
    ]
  })
  const out = (await readContracts(wagmiConfig, { contracts: per, allowFailure: false })) as unknown[]
  const reads = reserves.map((_, i) => ({
    supplied: out[3 * i] as bigint,
    debt: out[3 * i + 1] as bigint,
    collateral: (out[3 * i + 2] as readonly [boolean, boolean])[0],
  }))
  const held = spokes.filter((s) => reserves.some((r, i) => r.spoke.address === s && (reads[i].supplied > 0n || reads[i].debt > 0n)))
  const data = held.length
    ? await readContracts(wagmiConfig, {
        contracts: held.map((address) => ({ chainId, address, abi: v4SpokeAbi, functionName: 'getUserAccountData', args: [user] }) as const),
        allowFailure: false,
      })
    : []
  return buildV4Positions(reserves, reads, new Map(held.map((s, i) => [s.toLowerCase(), data[i]])))
}

export type V4Summary = {
  collateralBase: bigint
  debtBase: bigint
  equityBase: bigint
  leverage: number
  /** liquidation threshold weighted by the collaterals' value */
  threshold: number
  /** yield of the supplies and cost of the debts, weighted by value (risk premium and Merkl included) */
  supplyApy: number
  borrowApy: number
  /** on the net value; undefined without one */
  apy?: number
  /** the biggest collateral and the biggest debt: the pair the Boucle screen opens */
  collateral?: V4Holding
  debt?: V4Holding
}

const big = (list: V4Holding[], key: 'suppliedBase' | 'debtBase') =>
  list.reduce<V4Holding | undefined>((m, h) => (h[key] > (m?.[key] ?? 0n) ? h : m), undefined)

/** A spoke position in figures. Pure, tested. */
export function summarizeV4(p: V4SpokePosition): V4Summary {
  const n = (x: bigint) => Number(x)
  const supplied = p.holdings.reduce((s, h) => s + h.suppliedBase, 0n)
  const debtBase = p.holdings.reduce((s, h) => s + h.debtBase, 0n)
  const backing = p.holdings.filter((h) => h.collateral && h.reserve.collateralFactor > 0)
  const backingBase = backing.reduce((s, h) => s + h.suppliedBase, 0n)
  const equityBase = supplied - debtBase
  const earn = p.holdings.reduce((s, h) => s + n(h.suppliedBase) * (h.reserve.supplyApy + h.reserve.underlyingApy + h.reserve.supplyRewardApy), 0)
  const cost = p.holdings.reduce((s, h) => s + n(h.debtBase) * (v4BorrowApy(h.reserve.borrowApy, p.riskPremium) - h.reserve.borrowRewardApy), 0)
  return {
    collateralBase: supplied,
    debtBase,
    equityBase,
    leverage: equityBase > 0n ? n(supplied) / n(equityBase) : Infinity,
    threshold: backingBase > 0n ? backing.reduce((s, h) => s + n(h.suppliedBase) * h.reserve.collateralFactor, 0) / n(backingBase) : 0,
    supplyApy: supplied > 0n ? earn / n(supplied) : 0,
    borrowApy: debtBase > 0n ? cost / n(debtBase) : 0,
    apy: equityBase > 0n ? (earn - cost) / n(equityBase) : undefined,
    collateral: big(backing.length ? backing : p.holdings, 'suppliedBase'),
    debt: big(p.holdings, 'debtBase'),
  }
}
