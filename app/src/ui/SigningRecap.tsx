/**
 * X5: while the wallet asks for a signature, a transaction, a batch or a deployment, this card says in French what it
 * is, decoded from the very bytes sent (chain/wallet.ts). It blocks nothing: the wallet stays where one confirms.
 */
import { useSigningRecap } from '../chain/wallet'
import type { Recap } from '../services/recap/describe'
import { Fold } from './primitives'

function Lines({ recap }: { recap: Recap }) {
  if (!recap.lines.length) return null
  return (
    <dl className="recap-lines">
      {recap.lines.map((l, i) => (
        <div key={i}>
          <dt>{l.label}</dt>
          <dd>{l.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function SigningRecap() {
  const recap = useSigningRecap()
  if (!recap) return null
  return (
    <aside className="signing-recap" role="status" aria-live="polite" aria-label="Ce que ton portefeuille te demande">
      <div className="card-head">
        <h2>Ton portefeuille te demande · {recap.kind}</h2>
      </div>
      <p className="recap-title">{recap.title}</p>
      <p>{recap.sentence}</p>
      {recap.warnings.map((w, i) => (
        <div key={i} className="notice warn">
          {w}
        </div>
      ))}
      {recap.calls ? (
        <ol className="recap-calls">
          {recap.calls.map((c, i) => (
            <li key={i}>
              <strong>{c.title}</strong> : {c.sentence}
            </li>
          ))}
        </ol>
      ) : (
        <Lines recap={recap} />
      )}
      {recap.raw && (
        <Fold title="Données brutes" plain>
          <pre className="recap-raw">{recap.raw}</pre>
        </Fold>
      )}
      <p className="muted small">Le portefeuille doit montrer les mêmes valeurs. Sinon, refuse.</p>
    </aside>
  )
}
