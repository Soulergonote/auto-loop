/** What the executor calls of every protocol share: swap steps, the guard (health factor floor, deadline), live quotes. */
import { maxUint256, type Address, type Hex } from 'viem'
import type { Quote } from '../services/quotes/quotes'

/** How long a call, a signature or a permit stays valid. */
export const DEADLINE_SECONDS = 20 * 60

export type Step = { router: Address; tokenOut: Address; data: Hex; minOut: bigint }
export type Guard = { minHealthFactor: bigint; deadline: bigint }

export const deadlineFromNow = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)
export const guardOf = (minHealthFactor: bigint): Guard => ({ minHealthFactor, deadline: deadlineFromNow() })
export const sameAddress = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

/** The quote of a plan, refused when missing or simulated. */
export function liveQuote(q: Quote | undefined, what: string): Quote {
  if (!q) throw new Error(`Devis ${what} manquant`)
  if (q.simulated) throw new Error('Devis simulé : impossible à exécuter')
  return q
}

/** A health factor in wad as the contracts emit it (max uint256 without debt). */
export const hfText = (x: bigint) => (x >= maxUint256 / 2n ? '∞' : (Number(x / 10n ** 14n) / 10_000).toFixed(2))
