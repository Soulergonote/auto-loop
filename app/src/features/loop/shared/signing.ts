/** What a panel's sign button waits for, in the order the user can fix it; undefined when it can sign. */
export function signBlocker(s: {
  executor?: string
  /** checked only when given: panels shown without a wallet pass it */
  account?: string
  simulated?: boolean
  problems: unknown[]
  /** the exit route is still being quoted (opens) */
  checkingExit?: boolean
}): string | undefined {
  if (!s.executor) return 'Contrat pas encore déployé'
  if ('account' in s && !s.account) return 'Connecter le portefeuille'
  if (s.simulated) return 'Devis simulé'
  if (s.problems.length) return 'Bloqué : voir le bandeau rouge'
  if (s.checkingExit) return 'Vérification de la sortie…'
  return undefined
}
