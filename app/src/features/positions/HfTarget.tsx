/**
 * Health factor target of a position card (« Ramener à HF cible »): the target, kept in this browser per position,
 * and the move back to it when the position drifted out of its band. The move itself is signed on the Boucle
 * screen, prefilled (« Fermer / réduire » to repay, « Ouvrir / augmenter » to borrow more): no standing permission.
 */
import { useState } from 'react'
import { hfTargetsFor, rebalanceFor, safetyTarget, type Rebalance } from '../../domain/rebalance'
import { fmtHf, fmtUsd, fmtX } from '../../ui/format'
import { hfTone } from '../../ui/tone'
import { Fold, Notice } from '../../ui/primitives'

const KEY = 'auto-loop.hf-targets'

function load(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function store(id: string, target: number | undefined) {
  try {
    const all = load()
    if (target === undefined) delete all[id]
    else all[id] = target
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // private window or blocked storage: the target lasts for this page only
  }
}

/** The target chosen for position `id` (protocol, network, pair or market), remembered in this browser. */
export function useHfTarget(id: string) {
  const [target, setTarget] = useState<number | undefined>(() => load()[id])
  return {
    target,
    setTarget: (t: number | undefined) => {
      store(id, t)
      setTarget(t)
    },
  }
}

type Position = { collateralBase: bigint; debtBase: bigint; healthFactor: number; correlated: boolean }

/** Banner with the move back to the target (when out of band) and the fold to choose the target. */
export function HfTargetBlock({ id, position, onRebalance }: { id: string; position: Position; onRebalance: (r: Rebalance) => void }) {
  const { target, setTarget } = useHfTarget(id)
  const r = rebalanceFor(position, target)
  const options = hfTargetsFor(position.correlated)
  // in the red zone the banner is red and says why (it replaces the card's own liquidation warning)
  const danger = hfTone(position.healthFactor, position.correlated) === 'bad'
  const button = r && (
    <button className="btn" onClick={() => onRebalance(r)}>
      Ramener à {fmtHf(r.target)}
    </button>
  )
  return (
    <>
      {r?.direction === 'down' && (
        <Notice tone={danger ? 'bad' : 'warn'}>
          <span>
            {danger
              ? `Health factor ${fmtHf(position.healthFactor)} : une petite baisse du collatéral ou la hausse des intérêts suffit à liquider. Rembourser `
              : `Health factor ${fmtHf(position.healthFactor)} sous ${target !== undefined ? 'la cible' : 'la zone verte'} : rembourser `}
            {fmtUsd(r.debtChangeBase, true)} de dette le ramène à {fmtHf(r.target)} (levier {fmtX(r.leverage)}).
          </span>
          {button}
        </Notice>
      )}
      {r?.direction === 'up' && (
        <div className="rebalance-up">
          <p className="muted small">
            Health factor {fmtHf(position.healthFactor)} au-dessus de la cible : emprunter {fmtUsd(r.debtChangeBase, true)} de plus le ramène à{' '}
            {fmtHf(r.target)} (levier {fmtX(r.leverage)}).
          </p>
          {button}
        </div>
      )}
      <Fold title="Health factor cible" value={target !== undefined ? fmtHf(target) : `aucune · sécurité à ${fmtHf(safetyTarget(position.correlated))}`}>
        <label className="field">
          <span>Cible</span>
          <select value={target ?? ''} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">Aucune</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {fmtHf(o)}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Avec une cible, la carte propose de rembourser quand le health factor passe dessous et d’emprunter plus quand il la dépasse nettement. Sans cible,
          elle ne propose que de rembourser, une fois la position sortie de la zone verte. La transaction se signe sur l’écran Boucle, préremplie ; rien ne se
          fait sans signature. Cible gardée dans ce navigateur.
        </p>
      </Fold>
    </>
  )
}
