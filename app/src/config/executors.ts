import { getAddress, isAddress, keccak256, slice, toBytes, type Address } from 'viem'

/** Address the fork tests deploy the executor at; used as the quote taker until a real deployment exists. */
export const FORK_EXECUTOR: Address = getAddress(slice(keccak256(toBytes('auto-loop.executor.fork')), 12))

/**
 * Deployed LeverageExecutor per market (one per Aave pool): VITE_EXECUTORS='{"base":"0x…","arbitrum":"0x…"}'.
 * VITE_EXECUTOR_ADDRESS is still read as the Base one. Missing = not deployed there: everything is computed and
 * shown, but nothing is offered for signing.
 */
function readExecutors(): Record<string, Address> {
  const out: Record<string, Address> = {}
  try {
    const raw = JSON.parse((import.meta.env.VITE_EXECUTORS as string | undefined) || '{}') as Record<string, string>
    for (const [id, a] of Object.entries(raw)) if (isAddress(a)) out[id] = getAddress(a)
  } catch {
    console.warn('VITE_EXECUTORS illisible, ignoré')
  }
  const legacy = import.meta.env.VITE_EXECUTOR_ADDRESS as string | undefined
  if (legacy && isAddress(legacy) && !out.base) out.base = getAddress(legacy)
  return out
}
export const BUILD_EXECUTORS = readExecutors()

/** Address the fork tests deploy the Morpho executor at; the quote taker until a real deployment exists. */
export const FORK_MORPHO_EXECUTOR: Address = getAddress(slice(keccak256(toBytes('auto-loop.morpho-executor.fork')), 12))

/** Executors the user deployed (or pasted) from this browser, per market id. */
const LOCAL_EXECUTORS_KEY = 'auto-loop.executors'

export function savedExecutors(): Record<string, Address> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_EXECUTORS_KEY) || '{}') as Record<string, string>
    const out: Record<string, Address> = {}
    for (const [id, a] of Object.entries(raw)) if (isAddress(a)) out[id] = getAddress(a)
    return out
  } catch {
    return {}
  }
}

export function storeExecutors(all: Record<string, Address>) {
  try {
    localStorage.setItem(LOCAL_EXECUTORS_KEY, JSON.stringify(all))
  } catch {
    // private window: the address is kept for this visit only
  }
}
