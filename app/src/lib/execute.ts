import { BaseError, ContractFunctionRevertedError, maxUint256, type Address, type Hash } from 'viem'
import { simulateContract, waitForTransactionReceipt, writeContract } from '@wagmi/core'
import { wagmiConfig } from '../wagmi'
import { erc20Abi, executorAbi } from '../abi'
import type { Quote } from './quotes'
import { signATokenPermit, signDelegation } from './signatures'

export type Progress = (step: string) => void

export type OpenPlan = {
  executor: Address
  user: Address
  collateral: Address
  debt: Address
  variableDebtToken: Address
  initialCollateral: bigint
  debtAmount: bigint
  quote: Quote
  collateralAllowance: bigint
  borrowAllowance: bigint
}

export type ClosePlan = {
  executor: Address
  user: Address
  collateral: Address
  debt: Address
  aToken: Address
  full: boolean
  repayAmount: bigint
  collateralToWithdraw: bigint
  collateralToSell: bigint
  /** aTokens the executor will pull (current balance for a full close) */
  aTokensNeeded: bigint
  aTokenAllowance: bigint
  quote: Quote
}

export function openArgs(p: OpenPlan) {
  return {
    collateralAsset: p.collateral,
    debtAsset: p.debt,
    initialCollateral: p.initialCollateral,
    debtAmount: p.debtAmount,
    swap: { router: p.quote.router, data: p.quote.data, minOut: p.quote.minOut },
  } as const
}

export function closeArgs(p: ClosePlan) {
  return {
    collateralAsset: p.collateral,
    debtAsset: p.debt,
    repayAmount: p.full ? maxUint256 : p.repayAmount,
    collateralToWithdraw: p.full ? maxUint256 : p.collateralToWithdraw,
    collateralToSell: p.collateralToSell,
    swap: { router: p.quote.router, data: p.quote.data, minOut: p.quote.minOut },
  } as const
}

async function approve(token: Address, spender: Address, amount: bigint, account: Address, onStep: Progress) {
  onStep('Approbation du collatéral (transaction 1)…')
  const { request } = await simulateContract(wagmiConfig, {
    account,
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  })
  const hash = await writeContract(wagmiConfig, request)
  await waitForTransactionReceipt(wagmiConfig, { hash })
}

/** Opens the position: approval if needed, credit delegation by signature if needed, then one transaction. */
export async function executeOpen(p: OpenPlan, onStep: Progress): Promise<Hash> {
  if (p.quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
  if (p.initialCollateral > 0n && p.collateralAllowance < p.initialCollateral) {
    await approve(p.collateral, p.executor, p.initialCollateral, p.user, onStep)
  }

  const args = openArgs(p)
  const confirm = () => onStep('Confirmation de la transaction dans le portefeuille…')
  let hash: Hash
  if (p.borrowAllowance >= p.debtAmount) {
    onStep('Simulation de l’ouverture…')
    const { request } = await simulateContract(wagmiConfig, {
      account: p.user,
      address: p.executor,
      abi: executorAbi,
      functionName: 'open',
      args: [args],
    })
    confirm()
    hash = await writeContract(wagmiConfig, request)
  } else {
    onStep('Signature de la délégation de crédit…')
    const sig = await signDelegation(p.user, p.variableDebtToken, p.executor, p.debtAmount)
    onStep('Simulation de l’ouverture…')
    const { request } = await simulateContract(wagmiConfig, {
      account: p.user,
      address: p.executor,
      abi: executorAbi,
      functionName: 'openWithSig',
      args: [args, sig],
    })
    confirm()
    hash = await writeContract(wagmiConfig, request)
  }
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash })
  if (receipt.status !== 'success') throw new Error('La transaction a échoué')
  return hash
}

/** Closes (fully or partially): aToken permit by signature if needed, then one transaction. */
export async function executeClose(p: ClosePlan, onStep: Progress): Promise<Hash> {
  if (p.quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
  const args = closeArgs(p)
  const confirm = () => onStep('Confirmation de la transaction dans le portefeuille…')
  let hash: Hash
  if (p.aTokenAllowance >= p.aTokensNeeded) {
    onStep('Simulation de la fermeture…')
    const { request } = await simulateContract(wagmiConfig, {
      account: p.user,
      address: p.executor,
      abi: executorAbi,
      functionName: 'close',
      args: [args],
    })
    confirm()
    hash = await writeContract(wagmiConfig, request)
  } else {
    onStep('Signature de l’autorisation sur les aTokens…')
    // a little headroom: aToken balances grow every block
    const value = p.full ? (p.aTokensNeeded * 1001n) / 1000n : p.aTokensNeeded
    const sig = await signATokenPermit(p.user, p.aToken, p.executor, value)
    onStep('Simulation de la fermeture…')
    const { request } = await simulateContract(wagmiConfig, {
      account: p.user,
      address: p.executor,
      abi: executorAbi,
      functionName: 'closeWithSig',
      args: [args, sig],
    })
    confirm()
    hash = await writeContract(wagmiConfig, request)
  }
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash })
  if (receipt.status !== 'success') throw new Error('La transaction a échoué')
  return hash
}

const REVERT_MESSAGES: Record<string, string> = {
  InsufficientOutput: 'Le swap a rendu moins que le minimum : le prix a bougé, recote ou augmente le slippage.',
  RouterNotAllowed: 'Ce routeur n’est pas dans la liste blanche du contrat.',
  InsufficientToRepayFlashLoan: 'Le collatéral vendu ne suffit pas à rembourser le flash loan.',
  SellExceedsWithdrawn: 'Le montant à vendre dépasse le collatéral retiré.',
  ExcessiveInput: 'Le routeur a pris plus que prévu.',
  InvalidFlashLoan: 'Flash loan incohérent avec les paramètres.',
  ZeroAmount: 'Montant nul.',
  SameAsset: 'Le collatéral et la dette doivent être différents.',
}

/** Human-readable error, decoding LeverageExecutor custom errors when present. */
export function explainError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName
      if (name && REVERT_MESSAGES[name]) return REVERT_MESSAGES[name]
      if (revert.reason) return `Revert : ${revert.reason}`
    }
    if (e.walk((x) => (x as { name?: string }).name === 'UserRejectedRequestError')) return 'Refusé dans le portefeuille.'
    return e.shortMessage
  }
  return e instanceof Error ? e.message : String(e)
}
