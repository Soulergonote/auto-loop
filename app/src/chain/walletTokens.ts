/**
 * Capital in any token (contract v2): the open can take the collateral, the debt asset, or any other token of the
 * market, which the contract swaps to collateral first (`capitalSteps`). This file holds the wallet reads that list
 * those tokens and the pure helpers the open screen uses.
 */
import { useMemo } from 'react'
import { useBalance, useReadContract, useReadContracts } from 'wagmi'
import { zeroAddress, type Address } from 'viem'
import { erc20Abi, oracleAbi, poolAbi, providerAbi } from './abi'
import { DEMO, type Market, type Token } from '../config'
import { toBase, type Side } from '../domain/math'

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
  /**
   * the chain's native token (ETH, XPL, MON…), wrapped into `token` (WETH…) in the same batch before the open:
   * `balance` is then the native balance minus a gas reserve, and `allowance` that of the wrapped token
   */
  native?: { symbol: string }
}

/** Value of a wallet balance, in the oracle's base (1e8 = 1 $). */
export const walletValue = (t: WalletToken) => toBase(t.balance, t.side)

/** Native balance kept for gas when the capital is the native token: 2 %. */
export const spendableNative = (balance: bigint) => balance - balance / 50n

/**
 * The market's tokens the wallet holds, with their oracle price and the allowance to the executor, ordered by
 * `walletTokens`. With `wrapped` (the chain's wrapped native token among the market's assets), the native balance is
 * offered too, to be wrapped in the same batch.
 */
export function useWalletTokens(market: Market, tokens: Token[] | undefined, collateral: Token, debt: Token, user?: Address, enabled = true, wrapped?: Token) {
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
  const nativeBalance = useBalance({ chainId, address: user, query: { enabled: on && !!wrapped, refetchInterval: 15_000 } })
  const data = useMemo((): WalletToken[] | undefined => {
    if (!reads.data || !prices.data) return undefined
    const all: WalletToken[] = list.map((token, i) => ({
      token,
      side: { price: prices.data[i] ?? 0n, decimals: token.decimals },
      balance: (reads.data[2 * i]?.result as bigint | undefined) ?? 0n,
      allowance: market.executor ? ((reads.data[2 * i + 1]?.result as bigint | undefined) ?? 0n) : 0n,
    }))
    const w = wrapped && all.find((t) => t.token.address.toLowerCase() === wrapped.address.toLowerCase())
    const native = nativeBalance.data?.value ?? 0n
    if (w && native > 0n) all.push({ ...w, balance: spendableNative(native), native: { symbol: market.chain.nativeCurrency.symbol } })
    return walletTokens(all, collateral.address, debt.address)
  }, [reads.data, prices.data, list, collateral.address, debt.address, market.executor, market.chain, wrapped, nativeBalance.data?.value])
  return { data, refetch: () => Promise.all([reads.refetch(), nativeBalance.refetch()]) }
}

/**
 * The tokens the wallet holds first, by value (the native token among them), then the pair's tokens it does not hold
 * (collateral, then debt asset), so that the capital is picked in one look.
 */
export function walletTokens(all: WalletToken[], collateral: Address, debt: Address): WalletToken[] {
  const is = (t: WalletToken, a: Address) => !t.native && t.token.address.toLowerCase() === a.toLowerCase()
  const inPair = (t: WalletToken) => is(t, collateral) || is(t, debt)
  const held = all
    .filter((t) => t.balance > 0n && (t.side.price > 0n || inPair(t)))
    .sort((a, b) => {
      const d = walletValue(b) - walletValue(a)
      return d > 0n ? 1 : d < 0n ? -1 : a.token.symbol.localeCompare(b.token.symbol, 'en', { sensitivity: 'base' })
    })
  const pairEmpty = [all.find((t) => is(t, collateral)), all.find((t) => is(t, debt))].filter((t): t is WalletToken => !!t && t.balance === 0n)
  return [...held, ...pairEmpty]
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
