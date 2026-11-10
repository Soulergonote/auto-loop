import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export type PickerOption = {
  value: string
  label: string
  /** extra columns on the right (balance, LLTV, liquidity…) */
  cells?: ReactNode[]
  /** a second line under the label */
  sub?: ReactNode
  disabled?: boolean
  /** more words the search matches (a full symbol when the label is shortened) */
  keywords?: string
}

/**
 * Choice in a long list (tokens, markets): a button that opens a panel with a search field and extra columns.
 * Arrow keys move, Enter picks, Escape or a click elsewhere closes.
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  columns,
  display,
  wide,
}: {
  label: string
  value: string
  options: PickerOption[]
  onChange: (value: string) => void
  /** headers of the extra columns */
  columns?: string[]
  /** what the closed button shows, when not the option's label */
  display?: ReactNode
  /** the panel may grow wider than the button (market tables) */
  wide?: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const current = options.find((o) => o.value === value)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const list = options.filter((o) => words.every((w) => `${o.label} ${o.keywords ?? ''}`.toLowerCase().includes(w)))
  const cols = Math.max(columns?.length ?? 0, ...options.map((o) => o.cells?.length ?? 0))
  // every row shares the same columns, so the extra values line up
  const grid = { gridTemplateColumns: `minmax(0, 1fr)${cols ? ` repeat(${cols}, minmax(72px, auto))` : ''}` }
  const searchable = options.length > 6

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    )
    search.current?.focus()
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
    // reset on each opening only
  }, [open])

  const pick = (o: PickerOption | undefined) => {
    if (!o || o.disabled) return
    onChange(o.value)
    setOpen(false)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.min(list.length - 1, Math.max(0, a + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(list[active])
    }
  }

  return (
    <div className="field picker" ref={root} onKeyDown={open ? onKey : undefined}>
      <span id={`${id}-l`}>{label}</span>
      <button type="button" className="picker-btn" aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${id}-l`} onClick={() => setOpen(!open)}>
        <span className="picker-value">{display ?? current?.label ?? '—'}</span>
        <span className="picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className={`picker-pop ${wide ? 'wide' : ''}`}>
          {searchable && (
            <input
              ref={search}
              type="search"
              aria-label={`Rechercher : ${label}`}
              placeholder="Rechercher"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
            />
          )}
          {columns && (
            <div className="picker-row head" aria-hidden="true" style={grid}>
              <span />
              {columns.map((c) => (
                <span key={c} className="num">
                  {c}
                </span>
              ))}
            </div>
          )}
          <div role="listbox" aria-labelledby={`${id}-l`} className="picker-list">
            {list.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                className={`picker-row ${i === active ? 'active' : ''}`}
                style={grid}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                <span className="picker-label">
                  <span>
                    {o.label}
                    {o.sub && <span className="muted small picker-sub">{o.sub}</span>}
                  </span>
                </span>
                {o.cells?.map((c, j) => (
                  <span key={j} className="num">
                    {c}
                  </span>
                ))}
              </button>
            ))}
            {list.length === 0 && <p className="muted small picker-empty">Aucun résultat.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
