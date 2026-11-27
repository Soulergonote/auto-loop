/**
 * Sending transactions from the connected wallet, the same way for every protocol: a transaction of the user's own
 * (approval, account setting), the executor call (simulated first), an atomic batch, and the logs of what was mined.
 */
import type { Address, Hash, Log } from 'viem'
import { getPublicClient, simulateContract, waitForTransactionReceipt } from '@wagmi/core'
import { walletWriteContract } from './wallet'
import { wagmiConfig } from './wagmi'
import { sendBatch, type BatchCall } from './batch'
import type { Progress } from './tx'

export type Sender = { chainId: number; user: Address }
export type ContractCall = { address: Address; abi: unknown; functionName: string; args: readonly unknown[] }

/** A transaction of the user's own, simulated, sent and waited for. */
export async function userTx(from: Sender, call: ContractCall, what: string, onStep: Progress) {
  onStep(`${what} (transaction)…`)
  const sim = await simulateContract(wagmiConfig, { ...call, chainId: from.chainId, account: from.user } as never)
  const hash = await walletWriteContract(sim.request as never)
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: from.chainId, hash })
  if (receipt.status !== 'success') throw new Error(`${what} : la transaction a échoué`)
}

/** Simulates then sends the executor call, waits for it. */
export async function sendExecutorCall(from: Sender, call: ContractCall, onStep: Progress): Promise<Hash> {
  onStep('Simulation…')
  const { request } = await simulateContract(wagmiConfig, { ...call, chainId: from.chainId, account: from.user } as never)
  onStep('Confirmation de la transaction dans le portefeuille…')
  const hash = await walletWriteContract(request as never)
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: from.chainId, hash })
  if (receipt.status !== 'success') throw new Error('La transaction a échoué')
  return hash
}

/** One atomic batch; the hash is that of the transaction where `executor` acted. */
export async function sendBatchTx(from: Sender, calls: BatchCall[], onStep: Progress, executor: Address): Promise<Hash> {
  const hash = await sendBatch(from.chainId, from.user, calls, onStep, executor)
  if (!hash) throw new Error('Lot envoyé, transaction introuvable')
  return hash
}

/** The logs of a mined transaction, undefined when the receipt cannot be read. */
export async function receiptLogs(chainId: number, hash: Hash): Promise<Log[] | undefined> {
  try {
    return (await getPublicClient(wagmiConfig, { chainId })!.getTransactionReceipt({ hash })).logs
  } catch {
    return undefined
  }
}
