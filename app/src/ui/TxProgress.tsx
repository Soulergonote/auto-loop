import type { ReactNode } from 'react'

/** What the summary needs to show a flow's progress in place of its button (useTxAction gives it). */
export type TxState = { busy?: string; trail: string[]; result?: { ok: boolean } }

/** The steps every executor call goes through once its own preparations are done, in order. */
const PHASES = [
  { label: 'Simulation', seen: /^Simulation/ },
  { label: 'Confirmation dans le portefeuille', seen: /dans le portefeuille/ },
  { label: 'Inclusion dans un bloc', seen: /inclusion/i },
] as const

const clean = (s: string) => s.replace(/…$/, '')

/**
 * Transaction progress, in the summary in place of the main button (charte v3): one line per step, a green square with
 * ✓ when done, the pale block (d) sweeping the current one, white for the steps still to come; ✕ on a failed step.
 * `trail`: the steps reported so far, the last one current while `busy`.
 */
export function TxProgress({ trail, busy, failed, children }: { trail: string[]; busy: boolean; failed?: boolean; children?: ReactNode }) {
  const steps = trail.filter((s, i) => s !== trail[i - 1])
  const lastPhase = Math.max(-1, ...steps.map((s) => PHASES.findIndex((p) => p.seen.test(s))))
  const upcoming = busy ? PHASES.slice(lastPhase + 1).map((p) => p.label) : []
  const total = steps.length + upcoming.length
  const current = busy ? steps.length : undefined
  const title = busy ? `Transaction en cours · étape ${steps.length} sur ${total}` : failed ? 'Transaction échouée' : 'Transaction terminée'
  return (
    <div className="tx" aria-live="polite" aria-busy={busy}>
      <div className="tx-head">{title}</div>
      <ol className="tx-steps">
        {steps.map((s, i) => {
          const state = busy && i + 1 === current ? 'on' : failed && i === steps.length - 1 ? 'fail' : 'done'
          return (
            <li key={i} className={`tx-step ${state}`}>
              <span className="tx-dot" aria-hidden="true">
                {state === 'done' ? '✓' : state === 'fail' ? '✕' : ''}
              </span>
              {clean(s)}
            </li>
          )
        })}
        {upcoming.map((s) => (
          <li key={s} className="tx-step todo">
            <span className="tx-dot" aria-hidden="true" />
            {s}
          </li>
        ))}
      </ol>
      {children}
    </div>
  )
}
