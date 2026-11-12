import { describe, expect, it } from 'vitest'
import { signBlocker } from './signing'

describe('signBlocker', () => {
  const ok = { executor: '0x1', account: '0x2', problems: [] }
  it('lets a ready panel sign', () => expect(signBlocker(ok)).toBeUndefined())
  it('names the first thing to fix', () => {
    expect(signBlocker({ ...ok, executor: undefined, simulated: true })).toBe('Contrat pas encore déployé')
    expect(signBlocker({ ...ok, account: undefined })).toBe('Connecter le portefeuille')
    expect(signBlocker({ ...ok, simulated: true, problems: ['x'] })).toBe('Devis simulé')
    expect(signBlocker({ ...ok, problems: ['x'] })).toBe('Bloqué : voir le bandeau rouge')
    expect(signBlocker({ ...ok, checkingExit: true })).toBe('Vérification de la sortie…')
  })
  it('skips the wallet check when the panel does not pass an account', () => {
    expect(signBlocker({ executor: '0x1', problems: [] })).toBeUndefined()
  })
})
