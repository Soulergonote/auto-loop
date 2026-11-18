import { useState, type ReactNode } from 'react'
import { HfRing } from '../../ui/HfRing'
import { fmtHf } from '../../ui/format'
import type { Tone } from '../../ui/tone'

/**
 * A position card (charte v3), the same for Aave v3, Aave v4 and Morpho: the mini ring, the pair and its place with
 * logos, its pills, then « Détails ▾ » and the actions. Collapsed by default, it keeps the net value, the net APY and
 * the number of its banners; a card whose health factor is red opens by itself. The details stay mounted while
 * collapsed (they report the real gain to the overview).
 */
export function PositionCard({
  title,
  place,
  hf,
  tone,
  levered,
  tags,
  warnings = 0,
  equity,
  apy,
  apyTone,
  actions,
  children,
}: {
  title: ReactNode
  /** « Aave · Arbitrum » with its logos, and what tells the market apart */
  place: ReactNode
  hf: number
  tone?: Tone
  levered: boolean
  tags?: ReactNode
  /** banners inside the card, counted on the collapsed card */
  warnings?: number
  equity: string
  apy?: string
  apyTone?: Tone
  actions?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(levered && tone === 'bad')
  return (
    <section className={`card pos-card ${open ? 'open' : ''}`}>
      <div className="pos-head">
        <HfRing size="mini" value={levered ? fmtHf(hf) : '∞'} hf={levered ? hf : Infinity} tone={levered ? tone : 'good'} />
        <div className="pos-title">
          <h2>{title}</h2>
          <div className="pos-place">{place}</div>
          {(tags || (!open && warnings > 0)) && (
            <div className="tags">
              {tags}
              {!open && warnings > 0 && (
                <span className="tag warn">
                  {warnings} avertissement{warnings > 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}
        </div>
        {!open && (
          <div className="pos-sum">
            <div>
              <span className="pos-sum-label">Valeur nette</span>
              <b>{equity}</b>
            </div>
            <div>
              <span className="pos-sum-label">APY net</span>
              <b className={apyTone}>{apy ?? '—'}</b>
            </div>
          </div>
        )}
        <div className="pos-actions">
          <button type="button" className="btn small pos-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Replier ▴' : 'Détails ▾'}
          </button>
          {actions}
        </div>
      </div>
      <div className="pos-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
