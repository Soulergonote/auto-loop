/**
 * Capital in any token (contract v2): the open can take the collateral, the debt asset, or any other token of the
 * market, which the contract swaps to collateral first (`capitalSteps`). This file holds the wallet reads that list
 * those tokens and the pure helpers the open screen uses.
 */
import { useMemo } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { zeroAddress, type Address } from 'viem'
import { erc20Abi, oracleAbi, poolAbi, providerAbi } from '../abi'
import { DEMO, type Market, type Token } from '../config'
import type { Side } from './math'

export type CapitalKind = 'collateral' | 'debt' | 'swap'

/** How the contract uses the capital: deposited as is, sold with the debt in the same swap, or swapped first. */
export function capitalKind(capital: Address, collateral: Address, debt: Address): CapitalKind {
  const c = capital.toLowerCase()
  if (c === collateral.toLowerCase()) return 'collateral'
  if (c === debt.toLowerCase()) return 'debt'
  return 'swap'
}

export type WalletToken = {
  token: Token
  side: Side
  balance: bigint
  /** allowance given to the executor */
  allowance: bigint
}

/**
 * The market's tokens the wallet holds, with their oracle price and the allowance to the executor. The pair's two
 * tokens are always listed (first the collateral, then the debt asset), the others only with a balance.
 */
export function useWalletTokens(market: Market, tokens: Token[] | undefined, collateral: Token, debt: Token, user?: Address, enabled = true) {
  const chainId = market.chain.id
  const on = enabled && !DEMO && !!user && !!tokens?.length
  const provider = useReadContract({ chainId, address: market.pool, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER', query: { enabled: on } })
  const oracle = useReadContract({
    chainId,
    address: provider.data,
    abi: providerAbi,
    functionName: 'getPriceOracle',
    query: { enabled: on && !!provider.data },
  })
  const list = useMemo(() => tokens ?? [], [tokens])
  const spender = market.executor ?? zeroAddress
  const prices = useReadContract({
    chainId,
    address: oracle.data,
    abi: oracleAbi,
    functionName: 'getAssetsPrices',
    args: [list.map((t) => t.address)],
    query: { enabled: on && !!oracle.data, refetchInterval: 30_000 },
  })
  const reads = useReadContracts({
    contracts: list.flatMap((t) => [
      { chainId, address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [user ?? zeroAddress] } as const,
      { chainId, address: t.address, abi: erc20Abi, functionName: 'allowance', args: [user ?? zeroAddress, spender] } as const,
    ]),
    allowFailure: true,
    query: { enabled: on, refetchInterval: 15_000 },
  })
  const data = useMemo((): WalletToken[] | undefined => {
    if (!reads.data || !prices.data) return undefined
    return walletTokens(
      list.map((token, i) => ({
        token,
        side: { price: prices.data[i] ?? 0n, decimals: token.decimals },
        balance: (reads.data[2 * i]?.result as bigint | undefined) ?? 0n,
        allowance: market.executor ? ((reads.data[2 * i + 1]?.result as bigint | undefined) ?? 0n) : 0n,
      })),
      collateral.address,
      debt.address,
    )
  }, [reads.data, prices.data, list, collateral.address, debt.address, market.executor])
  return { data, refetch: reads.refetch }
}

/** Pair tokens first, then the others the wallet holds (with a price), by symbol. */
export function walletTokens(all: WalletToken[], collateral: Address, debt: Address): WalletToken[] {
  const is = (t: WalletToken, a: Address) => t.token.address.toLowerCase() === a.toLowerCase()
  const pair = [all.find((t) => is(t, collateral)), all.find((t) => is(t, debt))].filter((t): t is WalletToken => !!t)
  const others = all
    .filter((t) => !is(t, collateral) && !is(t, debt) && t.balance > 0n && t.side.price > 0n)
    .sort((a, b) => a.token.symbol.localeCompare(b.token.symbol, 'en', { sensitivity: 'base' }))
  return [...pair, ...others]
}

/** Wallet balance of each token (token pickers); nothing is read without a wallet. */
export function useBalances(chainId: number, tokens: Token[] | undefined, user?: Address): Map<Address, bigint> {
  const list = useMemo(() => tokens ?? [], [tokens])
  const reads = useReadContracts({
    contracts: list.map((t) => ({ chainId, address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [user ?? zeroAddress] }) as const),
    query: { enabled: !DEMO && !!user && list.length > 0, refetchInterval: 60_000 },
  })
  return useMemo(() => {
    const m = new Map<Address, bigint>()
    list.forEach((t, i) => {
      const r = reads.data?.[i]
      if (r?.status === 'success') m.set(t.address, r.result as bigint)
    })
    return m
  }, [list, reads.data])
}
