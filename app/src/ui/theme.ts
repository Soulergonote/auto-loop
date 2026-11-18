/**
 * The three themes of charte v3: an action colour and the pale of the same family. A click on the logo moves to the
 * next one; the choice is kept in this browser. index.html applies the saved theme before the first paint.
 */
export const THEMES = ['blue', 'violet', 'magenta'] as const
export type Theme = (typeof THEMES)[number]

export const THEME_LABEL: Record<Theme, string> = { blue: 'bleu', violet: 'violet', magenta: 'magenta' }
/** the pale of each theme (--sel), for the favicon, which cannot read CSS variables */
export const THEME_SEL: Record<Theme, string> = { blue: '#b8c9ff', violet: '#c9b8ff', magenta: '#ffb8dd' }

export const THEME_KEY = 'auto-loop:theme'

export const nextTheme = (t: Theme): Theme => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]

export const isTheme = (x: unknown): x is Theme => THEMES.includes(x as Theme)

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return isTheme(t) ? t : 'blue'
  } catch {
    return 'blue'
  }
}

/** The « carré pâle » logo: an ink-bordered square filled with the theme's pale, the loop in ink. */
export const logoSvg = (sel: string, ink = '#111111') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="4" fill="${sel}" stroke="${ink}" stroke-width="2"/><path d="M11 21a5 5 0 1 1 0-10c3 0 4.5 2.5 5 5s2 5 5 5a5 5 0 1 0 0-10" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/><path d="M18.5 8.5 21 11l-2.5 2.5" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`

export function applyTheme(t: Theme, save = true) {
  const root = document.documentElement
  if (t === 'blue') delete root.dataset.theme
  else root.dataset.theme = t
  // the favicon follows the theme
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon) icon.href = `data:image/svg+xml,${encodeURIComponent(logoSvg(THEME_SEL[t]))}`
  if (!save) return
  try {
    localStorage.setItem(THEME_KEY, t)
  } catch {
    // private window or blocked storage: the theme still changes for this visit
  }
}
