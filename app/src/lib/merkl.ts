import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { DEMO, type Market } from '../config'

/**
 * Merkl incentive campaigns on Aave (public API, no key). An opportunity is tied to a reserve by the aToken
 * (LEND) or variable debt token (BORROW) address, found in its identifier, explorer address or token list; one
 * that names neither is ignored rather than guessed from the underlying asset (Ethereum has two Aave markets on
 * the same assets). `apr` comes in percent; rewards on the same token add up.
 */
const MERKL_API = 'https://api.merkl.xyz/v4/opportunities'
const PAGE = 100

type Opportunity = {
  action: string
  identifier?: string
  explorerAddress?: string
  apr?: number
  tokens?: { address?: string }[]
}

export type Incentives = { lend: Map<string, number>; borrow: Map<string, number> }

export async function fetchIncentives(chainId: number, signal: AbortSignal): Promise<Incentives> {
  const lend = new Map<string, number>()
  const borrow = new Map<string, number>()
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({ chainId: String(chainId), mainProtocolId: 'aave', status: 'LIVE', items: String(PAGE), page: String(page) })
    const res = await fetch(`${MERKL_API}?${q}`, { signal })
    if (!res.ok) throw new Error(`Merkl : HTTP ${res.status}`)
    const list = (await res.json()) as Opportunity[]
    for (const o of list) {
      const target = o.action === 'LEND' ? lend : o.action === 'BORROW' ? borrow : undefined
      if (!target || !o.apr || o.apr <= 0) continue
      const addresses = new Set([o.identifier, o.explorerAddress, ...(o.tokens ?? []).map((t) => t.address)].filter(Boolean).map((a) => a!.toLowerCase()))
      for (const a of addresses) target.set(a, (target.get(a) ?? 0) + o.apr / 100)
    }
    if (list.length < PAGE) break
  }
  return { lend, borrow }
}

export function useIncentives(market: Market) {
  return useQuery({
    queryKey: ['merkl', market.chain.id],
    queryFn: ({ signal }) => fetchIncentives(market.chain.id, signal),
    enabled: !DEMO,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

/** Reward APR (fraction) on supplying through this aToken, and on borrowing through this debt token. */
export function rewardsFor(incentives: Incentives | undefined, aToken: Address, variableDebtToken: Address) {
  return {
    supply: incentives?.lend.get(aToken.toLowerCase()) ?? 0,
    borrow: incentives?.borrow.get(variableDebtToken.toLowerCase()) ?? 0,
  }
}
