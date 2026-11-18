import { useState } from 'react'
import type { Hash } from 'viem'
import { explainError, type Progress } from '../../../chain/tx'

/** What a panel shows under its button once a signing flow ends. */
export type TxResultData = { ok: boolean; text: string; hash?: Hash; details?: string[] }

/**
 * State of a panel's signing flow: the current step (`busy`) and those before it (`trail`), the last result, and `run`, which clears the last
 * result, lets the flow report its steps, and ends with the flow's own result or a readable error.
 */
export function useTxAction<R extends TxResultData = TxResultData>() {
  const [busy, setBusyState] = useState<string>()
  const [trail, setTrail] = useState<string[]>([])
  const [result, setResult] = useState<R>()
  /** the current step; each one is kept in `trail` for the progress shown in the summary */
  const setBusy = (s?: string) => {
    setBusyState(s)
    if (s) setTrail((t) => (t[t.length - 1] === s ? t : [...t, s]))
  }
  /** a new flow: no result, no steps yet (`run` does it; a panel driving its own flow calls it first) */
  const start = () => {
    setResult(undefined)
    setTrail([])
  }
  async function run(flow: (step: Progress) => Promise<void>) {
    start()
    try {
      await flow(setBusy)
    } catch (e) {
      setResult({ ok: false, text: explainError(e) } as R)
    } finally {
      setBusyState(undefined)
    }
  }
  return { busy, setBusy, result, setResult, run, trail, start }
}
