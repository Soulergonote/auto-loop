/** Atomic batches of calls (EIP-5792 `wallet_sendCalls` with `forceAtomic`), sent from the user's own account. */
import { encodeFunctionData, type Address, type Hash, type Hex } from 'viem'
import { getPublicClient, sendCalls, waitForCallsStatus } from '@wagmi/core'
import { useCapabilities } from 'wagmi'
import { wagmiConfig } from './wagmi'
import { debtTokenAbi, erc20Abi } from './abi'
import { type Progress } from './tx'

/** `value`: native token sent with the call (wrapping the native capital) */
export type BatchCall = { to: Address; data: Hex; label: string; value?: bigint }

/** Exact approval before a use and the previous value back after it; nothing when the allowance already covers it. */
export function allowanceCalls(
  kind: 'erc20' | 'delegation',
  token: Address,
  spender: Address,
  need: bigint,
  current: bigint,
  label: { set: string; reset: string },
): { before: BatchCall[]; after: BatchCall[] } {
  if (need === 0n || current >= need) return { before: [], after: [] }
  const call = (amount: bigint, text: string): BatchCall => ({
    to: token,
    data:
      kind === 'erc20'
        ? encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
        : encodeFunctionData({ abi: debtTokenAbi, functionName: 'approveDelegation', args: [spender, amount] }),
    label: text,
  })
  // tokens like USDT refuse to change a non-zero allowance to another non-zero value
  const before = kind === 'erc20' && current > 0n ? [call(0n, label.reset), call(need, label.set)] : [call(need, label.set)]
  return { before, after: [call(current, label.reset)] }
}

/** Whether the connected wallet can send this chain's calls as one atomic batch. */
export function useAtomicBatch(chainId: number, account: Address | undefined): boolean | undefined {
  const caps = useCapabilities({ account, chainId, query: { enabled: !!account, retry: false } })
  if (!account) return false
  if (caps.isPending) return undefined
  if (caps.isError) return false
  const c = caps.data as { atomic?: { status?: string } } | Record<number, { atomic?: { status?: string } }> | undefined
  const atomic = (c && 'atomic' in c ? c.atomic : (c as Record<number, { atomic?: { status?: string } }> | undefined)?.[chainId]?.atomic)?.status
  return atomic === 'supported' || atomic === 'ready'
}

/**
 * Sends the batch: a simulation of all the calls first when the RPC can (a failing call stops here), then one
 * confirmation in the wallet. Returns the transaction hash once included.
 */
export async function sendBatch(chainId: number, user: Address, calls: BatchCall[], onStep: Progress, main?: Address): Promise<Hash | undefined> {
  onStep('Simulation du lot…')
  const failure = await simulate(chainId, user, calls)
  if (failure) throw new Error(failure)
  onStep('Confirmation dans le portefeuille…')
  const { id } = await sendCalls(wagmiConfig, {
    chainId,
    account: user,
    forceAtomic: true,
    calls: calls.map(({ to, data, value }) => ({ to, data, ...(value ? { value } : {}) })),
  })
  onStep('En attente d’inclusion…')
  const status = await waitForCallsStatus(wagmiConfig, { id, timeout: 10 * 60_000 })
  if (status.status !== 'success')
    throw new Error(
      // forceAtomic: a wallet that cannot keep the batch atomic must refuse it; say so if one ran part of it anyway
      status.atomic === false
        ? 'Le lot a échoué en partie : vérifier les transactions dans le portefeuille.'
        : 'Le lot a échoué : aucune de ses opérations n’a eu lieu.',
    )
  // one transaction for a wallet that bundles the calls; otherwise the one where `main` (the executor) acted
  const receipts = status.receipts ?? []
  const own = main ? receipts.find((r) => r.logs.some((l) => l.address.toLowerCase() === main.toLowerCase())) : undefined
  return (own ?? receipts.at(-1))?.transactionHash
}

/** First failing call of the batch, or undefined (also when the RPC cannot simulate a batch: the wallet still does). */
async function simulate(chainId: number, user: Address, calls: BatchCall[]): Promise<string | undefined> {
  let results: readonly { status: string; error?: Error }[]
  try {
    const client = getPublicClient(wagmiConfig, { chainId })!
    results = (await client.simulateCalls({ account: user, calls: calls.map(({ to, data, value }) => ({ to, data, ...(value ? { value } : {}) })) })).results
  } catch {
    return undefined
  }
  const i = results.findIndex((r) => r.status !== 'success')
  return i < 0 ? undefined : `La simulation échoue à l’étape « ${calls[i].label} » : rien n’a été envoyé.`
}
