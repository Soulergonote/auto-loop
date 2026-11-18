import { useEffect, useState } from 'react'
import { THEME_LABEL, applyTheme, nextTheme, savedTheme } from './theme'

/** The « carré pâle » mark and the app name. The mark is a button: a click moves to the next theme (charte v3). */
export function AppLogo() {
  const [theme, setTheme] = useState(savedTheme)
  // the favicon follows the saved theme from the first render; the class on <html> is already set by index.html
  useEffect(() => applyTheme(theme, false), [theme])
  return (
    <div className="brand">
      <button
        type="button"
        className="brand-mark"
        aria-label={`Changer de thème, actuel : ${THEME_LABEL[theme]}`}
        title="Changer de thème (bleu, violet, magenta)"
        onClick={() => {
          const t = nextTheme(theme)
          applyTheme(t)
          setTheme(t)
        }}
      >
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect x="1" y="1" width="30" height="30" rx="4" fill="var(--sel)" stroke="var(--ink)" strokeWidth="2" />
          <path d="M11 21a5 5 0 1 1 0-10c3 0 4.5 2.5 5 5s2 5 5 5a5 5 0 1 0 0-10" fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
          <path d="M18.5 8.5 21 11l-2.5 2.5" fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <h1>Auto-loop</h1>
    </div>
  )
}
