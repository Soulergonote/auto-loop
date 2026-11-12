import { BaseError, ContractFunctionRevertedError } from 'viem'

export type Progress = (step: string) => void

const REVERT_MESSAGES: Record<string, string> = {
  InsufficientOutput: 'Le swap a rendu moins que le minimum : le prix a bougé, recote ou augmente le slippage.',
  RouterNotAllowed: 'Ce routeur n’est pas dans la liste blanche du contrat.',
  InsufficientToRepayFlashLoan: 'Le collatéral vendu ne suffit pas à rembourser le flash loan.',
  SellExceedsWithdrawn: 'Le montant à vendre dépasse le collatéral retiré.',
  ExcessiveInput: 'Le routeur a pris plus que prévu.',
  InvalidFlashLoan: 'Flash loan incohérent avec les paramètres.',
  ZeroAmount: 'Montant nul.',
  SameAsset: 'Le collatéral et la dette doivent être différents.',
  HealthFactorTooLow: 'Le health factor finirait sous le minimum prévu : le prix a bougé, recoter.',
  Expired: 'Délai dépassé : recoter et signer à nouveau.',
  FlashLenderNotAllowed: 'Ce prêteur de flash loan n’est pas enregistré dans le contrat.',
  WrongFinalToken: 'Le swap ne finit pas dans le bon token.',
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
