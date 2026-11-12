/**
 * Colour of a value, the same on every screen (UI charter): health factor by pair type, APY by sign.
 * A correlated loop (two USD stablecoins, an ETH derivative against ETH…) is meant to run close to 1, so its
 * thresholds are lower.
 */
export type Tone = 'good' | 'warn' | 'bad' | undefined

export const HF_THRESHOLDS = {
  /** under `bad` red, under `ok` amber, from `ok` green */
  uncorrelated: { bad: 1.1, ok: 1.3 },
  correlated: { bad: 1.03, ok: 1.08 },
} as const

export const hfThresholds = (correlated: boolean) => HF_THRESHOLDS[correlated ? 'correlated' : 'uncorrelated']

/** No colour without debt (infinite health factor). */
export function hfTone(hf: number, correlated: boolean): Tone {
  if (!Number.isFinite(hf)) return undefined
  const t = hfThresholds(correlated)
  return hf < t.bad ? 'bad' : hf < t.ok ? 'warn' : 'good'
}

export const apyTone = (apy: number | undefined): Tone => (apy === undefined || Number.isNaN(apy) ? undefined : apy < 0 ? 'bad' : 'good')
