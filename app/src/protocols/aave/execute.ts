import { encodeFunctionData, maxUint256, zeroAddress, type Address, type Hash, type Hex } from 'viem'
import { simulateContract, waitForTransactionReceipt, writeContract } from '@wagmi/core'
import { wagmiConfig } from '../../chain/wagmi'
import { erc20Abi, executorAbi, executorAbiV1, poolAbi } from '../../chain/abi'
import { quoteSteps, type Quote } from '../../services/quotes/quotes'
import { signATokenPermit, signDelegation, type ExecutorSignature } from './signatures'
import { aTokensToApprove, swapCollateralArgs, type SwapCollateralPlan } from './swapCollateral'

import type { Progress } from '../../chain/tx'

export type OpenPlan = {
  chainId: number
  executor: Address
  /** contract version of `executor` (2 for every new deployment) */
  version?: 1 | 2
  /** v2: the call reverts if the account's health factor ends below this (1e18 = 1.00; 0 = no check) */
  minHealthFactor?: bigint
  user: Address
  collateral: Address
  debt: Address
  variableDebtToken: Address
  /** capital pulled from the wallet, in `capitalToken` (the collateral when not set) */
  initialCollateral: bigint
  /** v2: token of the capital; the debt asset is sold with the borrowed amount, any other token is swapped first */
  capitalToken?: Address
  /** v2: swap of the capital to the collateral, when the capital is neither the collateral nor the debt asset */
  capitalQuote?: Quote
  debtAmount: bigint
  /** debt asset -> collateral; sells debtAmount (+ the capital when it is the debt asset) */
  quote: Quote
  /** allowance of the capital token to the executor */
  collateralAllowance: bigint
  borrowAllowance: bigint
  /** Aave pool, for the eMode switch */
  pool: Address
  /** eMode category to put the account in before opening (0 = leave eMode); undefined = already right */
  eModeTarget?: number
}

export type ClosePlan = {
  chainId: number
  executor: Address
  version?: 1 | 2
  /** v2: Morpho (no premium) or the Aave pool (premium); v1 always borrows from Aave */
  flashLender?: Address
  minHealthFactor?: bigint
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

/** Each call's deadline: the signatures used with it expire after 20 minutes too. */
const callDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

/** v1 parameters (executors deployed before v2). */
export function openArgsV1(p: OpenPlan) {
  if (p.quote.route) throw new Error('Le contrat v1 ne fait qu’un swap : route Pendle impossible')
  return {
    collateralAsset: p.collateral,
    debtAsset: p.debt,
    initialCollateral: p.initialCollateral,
    debtAmount: p.debtAmount,
    swap: { router: p.quote.router, data: p.quote.data, minOut: p.quote.minOut },
  } as const
}

/** Token of the capital: the collateral unless the plan names another one. */
export const capitalTokenOf = (p: Pick<OpenPlan, 'capitalToken' | 'collateral'>): Address => p.capitalToken ?? p.collateral

/**
 * v2 parameters. The capital is the collateral, the debt asset (sold in the same swap as the borrowed amount) or
 * another token swapped to the collateral first; then one swap step from the debt asset to the collateral.
 */
export function openArgs(p: OpenPlan) {
  const capital = capitalTokenOf(p)
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()
  const swapped = p.initialCollateral > 0n && !same(capital, p.collateral) && !same(capital, p.debt)
  if (swapped && !p.capitalQuote) throw new Error('Devis du capital manquant')
  if (swapped && p.capitalQuote!.sellAmount !== p.initialCollateral) throw new Error('Devis du capital pour un autre montant')
  const sold = p.debtAmount + (same(capital, p.debt) ? p.initialCollateral : 0n)
  if (p.quote.sellAmount !== sold) throw new Error('Devis pour un autre montant que l’emprunt')
  const cq = p.capitalQuote
  return {
    collateralAsset: p.collateral,
    debtAsset: p.debt,
    capitalToken: capital,
    capitalAmount: p.initialCollateral,
    capitalSteps: swapped ? quoteSteps(cq!, p.collateral) : [],
    debtAmount: p.debtAmount,
    steps: quoteSteps(p.quote, p.collateral),
    guard: { minHealthFactor: p.minHealthFactor ?? 0n, deadline: callDeadline() },
  } as const
}

export function closeArgsV1(p: ClosePlan) {
  if (p.quote.route) throw new Error('Le contrat v1 ne fait qu’un swap : route Pendle impossible')
  return {
    collateralAsset: p.collateral,
    debtAsset: p.debt,
    repayAmount: p.full ? maxUint256 : p.repayAmount,
    collateralToWithdraw: p.full ? maxUint256 : p.collateralToWithdraw,
    collateralToSell: p.collateralToSell,
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
    steps: quoteSteps(p.quote, p.debt),
    flashLender: p.flashLender ?? zeroAddress,
    guard: { minHealthFactor: p.full ? 0n : (p.minHealthFactor ?? 0n), deadline: callDeadline() },
  } as const
}

type Call = { abi: typeof executorAbi | typeof executorAbiV1; functionName: string; args: readonly unknown[] }

/** The executor call of an open, for the plan's contract version, with or without the delegation signature. */
export function openCall(p: OpenPlan, sig?: ExecutorSignature): Call {
  const v1 = p.version === 1
  if (v1 && capitalTokenOf(p).toLowerCase() !== p.collateral.toLowerCase()) throw new Error('Le contrat v1 ne prend que le collatéral comme capital')
  const args = v1 ? openArgsV1(p) : openArgs(p)
  return { abi: v1 ? executorAbiV1 : executorAbi, functionName: sig ? 'openWithSig' : 'open', args: sig ? [args, sig] : [args] }
}

export function closeCall(p: ClosePlan, sig?: ExecutorSignature): Call {
  if (p.version !== 1 && !p.flashLender) throw new Error('Prêteur du flash loan non choisi')
  const v1 = p.version === 1
  const args = v1 ? closeArgsV1(p) : closeArgs(p)
  return { abi: v1 ? executorAbiV1 : executorAbi, functionName: sig ? 'closeWithSig' : 'close', args: sig ? [args, sig] : [args] }
}

export const encodeCall = (c: Call): Hex => encodeFunctionData(c as never)

/** Simulates then sends one executor call from the user's account. */
async function send(chainId: number, user: Address, executor: Address, c: Call, onStep: Progress, what: string): Promise<Hash> {
  onStep(`Simulation de ${what}…`)
  const { request } = await simulateContract(wagmiConfig, { chainId, account: user, address: executor, ...(c as object) } as never)
  onStep('Confirmation de la transaction dans le portefeuille…')
  return writeContract(wagmiConfig, request as never)
}

async function approve(chainId: number, token: Address, spender: Address, amount: bigint, account: Address, onStep: Progress) {
  onStep('Approbation du capital (transaction)…')
  const { request } = await simulateContract(wagmiConfig, {
    chainId,
    account,
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  })
  const hash = await writeContract(wagmiConfig, request)
  await waitForTransactionReceipt(wagmiConfig, { chainId, hash })
}

/** eMode is a setting of the user's own Aave account: only the user can change it, the executor cannot. */
async function setEMode(p: OpenPlan, categoryId: number, onStep: Progress) {
  onStep(categoryId === 0 ? 'Sortie de l’eMode (transaction)…' : 'Activation de l’eMode (transaction)…')
  const { request } = await simulateContract(wagmiConfig, {
    chainId: p.chainId,
    account: p.user,
    address: p.pool,
    abi: poolAbi,
    functionName: 'setUserEMode',
    args: [categoryId],
  })
  const hash = await writeContract(wagmiConfig, request)
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: p.chainId, hash })
  if (receipt.status !== 'success') throw new Error('Le changement d’eMode a échoué')
}

/** Opens the position: eMode switch if needed, approval if needed, credit delegation by signature if needed, then one transaction. */
export async function executeOpen(p: OpenPlan, onStep: Progress): Promise<Hash> {
  if (p.quote.simulated || p.capitalQuote?.simulated) throw new Error('Devis simulé : impossible à exécuter')
  openCall(p) // checks the plan before anything is signed
  if (p.eModeTarget !== undefined) await setEMode(p, p.eModeTarget, onStep)
  if (p.initialCollateral > 0n && p.collateralAllowance < p.initialCollateral) {
    await approve(p.chainId, capitalTokenOf(p), p.executor, p.initialCollateral, p.user, onStep)
  }

  let hash: Hash
  if (p.borrowAllowance >= p.debtAmount) {
    hash = await send(p.chainId, p.user, p.executor, openCall(p), onStep, 'l’ouverture')
  } else {
    onStep('Signature de la délégation de crédit…')
    const sig = await signDelegation(p.chainId, p.user, p.variableDebtToken, p.executor, p.debtAmount)
    hash = await send(p.chainId, p.user, p.executor, openCall(p, sig), onStep, 'l’ouverture')
  }
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: p.chainId, hash })
  if (receipt.status !== 'success') throw new Error('La transaction a échoué')
  return hash
}

/** Closes (fully or partially): aToken permit by signature if needed, then one transaction. */
export async function executeClose(p: ClosePlan, onStep: Progress): Promise<Hash> {
  if (p.quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
  let hash: Hash
  if (p.aTokenAllowance >= p.aTokensNeeded) {
    hash = await send(p.chainId, p.user, p.executor, closeCall(p), onStep, 'la fermeture')
  } else {
    onStep('Signature de l’autorisation sur les aTokens…')
    // a little headroom: aToken balances grow every block
    const value = p.full ? (p.aTokensNeeded * 1001n) / 1000n : p.aTokensNeeded
    const sig = await signATokenPermit(p.chainId, p.user, p.aToken, p.executor, value)
    hash = await send(p.chainId, p.user, p.executor, closeCall(p, sig), onStep, 'la fermeture')
  }
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: p.chainId, hash })
  if (receipt.status !== 'success') throw new Error('La transaction a échoué')
  return hash
}

export function swapCollateralCall(p: SwapCollateralPlan, sig?: ExecutorSignature): Call {
  const args = swapCollateralArgs(p)
  return { abi: executorAbi, functionName: sig ? 'swapCollateralWithSig' : 'swapCollateral', args: sig ? [args, sig] : [args] }
}

/** Changes the collateral: aToken permit by signature if needed, then one transaction. */
export async function executeSwapCollateral(p: SwapCollateralPlan, onStep: Progress): Promise<Hash> {
  const need = aTokensToApprove(p)
  let call = swapCollateralCall(p) // checks the plan before anything is signed
  if (p.aTokenAllowance < need) {
    onStep('Signature de l’autorisation sur les aTokens…')
    call = swapCollateralCall(p, await signATokenPermit(p.chainId, p.user, p.fromAToken, p.executor, need))
  }
  const hash = await send(p.chainId, p.user, p.executor, call, onStep, 'du changement de collatéral')
  onStep('En attente d’inclusion…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: p.chainId, hash })
  if (receipt.status !== 'success') throw new Error('La transaction a échoué')
  return hash
}
