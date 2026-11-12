import { useState } from 'react'
import type { Hash } from 'viem'
import { explainError, type Progress } from '../../../chain/tx'

/** What a panel shows under its button once a signing flow ends. */
export type TxResultData = { ok: boolean; text: string; hash?: Hash; details?: string[] }

/**
 * State of a panel's signing flow: the current step (`busy`), the last result, and `run`, which clears the last
 * result, lets the flow report its steps, and ends with the flow's own result or a readable error.
 */
export function useTxAction<R extends TxResultData = TxResultData>() {
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<R>()
  async function run(flow: (step: Progress) => Promise<void>) {
    setResult(undefined)
    try {
      await flow(setBusy)
    } catch (e) {
      setResult({ ok: false, text: explainError(e) } as R)
    } finally {
      setBusy(undefined)
    }
  }
  return { busy, setBusy, result, setResult, run }
}
