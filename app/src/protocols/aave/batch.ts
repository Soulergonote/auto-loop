/** Aave executor calls (open, close, change of collateral) as one atomic batch with their exact approvals around them. */
import { encodeFunctionData, type Hash } from 'viem'
import { readContract } from '@wagmi/core'
import { wagmiConfig } from '../../chain/wagmi'
import { debtTokenAbi, erc20Abi, poolAbi } from '../../chain/abi'
import { aTokensToApprove, type SwapCollateralPlan } from './swapCollateral'
import { capitalTokenOf, closeCall, encodeCall, openCall, swapCollateralCall, type ClosePlan, type OpenPlan } from './execute'
import { type Progress } from '../../chain/tx'
import { allowanceCalls, sendBatch, type BatchCall } from '../../chain/batch'

/**
 * "Ouvrir" as one batch: eMode switch if needed, exact collateral approval, exact credit delegation, `open`, then
 * the approval and the delegation back to their previous values. Same contract call as the step flow.
 */
export function openBatchCalls(p: OpenPlan, allowances: { collateral: bigint; borrow: bigint }): BatchCall[] {
  if (p.quote.simulated || p.capitalQuote?.simulated) throw new Error('Devis simulé : impossible à exécuter')
  const open = encodeCall(openCall(p)) // also checks the amounts of the quotes
  const col = allowanceCalls('erc20', capitalTokenOf(p), p.executor, p.initialCollateral, allowances.collateral, {
    set: 'Autoriser le contrat à prendre le capital (montant exact)',
    reset: 'Remettre l’autorisation du capital à sa valeur',
  })
  const del = allowanceCalls('delegation', p.variableDebtToken, p.executor, p.debtAmount, allowances.borrow, {
    set: 'Déléguer l’emprunt au contrat (montant exact)',
    reset: 'Remettre la délégation d’emprunt à sa valeur',
  })
  const emode: BatchCall[] =
    p.eModeTarget === undefined
      ? []
      : [
          {
            to: p.pool,
            data: encodeFunctionData({ abi: poolAbi, functionName: 'setUserEMode', args: [p.eModeTarget] }),
            label: p.eModeTarget === 0 ? 'Sortir de l’eMode sur le compte Aave' : 'Passer le compte Aave en eMode',
          },
        ]
  return [
    ...emode,
    ...col.before,
    ...del.before,
    { to: p.executor, data: open, label: p.capitalQuote ? 'Ouvrir : swap du capital, flash loan, swap et dépôt' : 'Ouvrir : flash loan, swap et dépôt' },
    ...del.after,
    ...col.after,
  ]
}

/** "Fermer" as one batch: exact aToken approval (a little headroom on a full close), `close`, approval back after. */
export function closeBatchCalls(p: ClosePlan, aTokenAllowance: bigint): BatchCall[] {
  if (p.quote.simulated) throw new Error('Devis simulé : impossible à exécuter')
  if (p.quote.sellAmount !== p.collateralToSell) throw new Error('Devis pour un autre montant que le collatéral vendu')
  // aToken balances grow every block: a full close pulls the balance at inclusion
  const need = p.full ? (p.aTokensNeeded * 1001n) / 1000n : p.aTokensNeeded
  const a = allowanceCalls('erc20', p.aToken, p.executor, need, aTokenAllowance, {
    set: 'Autoriser le contrat à prendre ces aTokens (montant exact)',
    reset: 'Remettre l’autorisation des aTokens à sa valeur',
  })
  return [
    ...a.before,
    {
      to: p.executor,
      data: encodeCall(closeCall(p)),
      label: 'Fermer : flash loan, remboursement, retrait et swap',
    },
    ...a.after,
  ]
}

/** "Changer de collatéral" as one batch: exact aToken approval, `swapCollateral`, approval back after. */
export function swapCollateralBatchCalls(p: SwapCollateralPlan, aTokenAllowance: bigint): BatchCall[] {
  const call = encodeCall(swapCollateralCall(p))
  const a = allowanceCalls('erc20', p.fromAToken, p.executor, aTokensToApprove(p), aTokenAllowance, {
    set: 'Autoriser le contrat à prendre ces aTokens (montant exact)',
    reset: 'Remettre l’autorisation des aTokens à sa valeur',
  })
  return [...a.before, { to: p.executor, data: call, label: 'Changer de collatéral : flash loan, dépôt, retrait et swap' }, ...a.after]
}

/** Changes the collateral in one confirmation, with the aToken allowance read now. */
export async function executeSwapCollateralBatch(p: SwapCollateralPlan, onStep: Progress): Promise<Hash | undefined> {
  onStep('Lecture des autorisations…')
  const allowance = await readContract(wagmiConfig, {
    chainId: p.chainId,
    address: p.fromAToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [p.user, p.executor],
  })
  return sendBatch(p.chainId, p.user, swapCollateralBatchCalls(p, allowance), onStep, p.executor)
}

/** Opens in one confirmation, with the allowances read now (not the ones the screen last polled). */
export async function executeOpenBatch(p: OpenPlan, onStep: Progress): Promise<Hash | undefined> {
  onStep('Lecture des autorisations…')
  const [collateral, borrow] = await Promise.all([
    readContract(wagmiConfig, { chainId: p.chainId, address: capitalTokenOf(p), abi: erc20Abi, functionName: 'allowance', args: [p.user, p.executor] }),
    readContract(wagmiConfig, {
      chainId: p.chainId,
      address: p.variableDebtToken,
      abi: debtTokenAbi,
      functionName: 'borrowAllowance',
      args: [p.user, p.executor],
    }),
  ])
  return sendBatch(p.chainId, p.user, openBatchCalls(p, { collateral, borrow }), onStep, p.executor)
}

/** Closes in one confirmation, with the aToken allowance read now. */
export async function executeCloseBatch(p: ClosePlan, onStep: Progress): Promise<Hash | undefined> {
  onStep('Lecture des autorisations…')
  const allowance = await readContract(wagmiConfig, {
    chainId: p.chainId,
    address: p.aToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [p.user, p.executor],
  })
  return sendBatch(p.chainId, p.user, closeBatchCalls(p, allowance), onStep, p.executor)
}
