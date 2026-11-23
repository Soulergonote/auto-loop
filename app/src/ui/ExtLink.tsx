import type { ReactNode } from 'react'

/**
 * A ↗ link (drawn by the CSS of every new-tab link) to the protocol's own page (market, spoke) or the Merkl page of a
 * bonus, in a new tab. Alone it is the small ↗ next to a name (Scanner, Positions); with `children` the text itself
 * is the link, bold and underlined (Boucle). Without a link: nothing, or the text alone. It stops the click so a
 * clickable row (Scanner) does not open as well.
 */
export function ExtLink({ href, title, children }: { href?: string; title: string; children?: ReactNode }) {
  if (!href) return children ?? null
  return (
    <a
      className={children ? 'ext-text' : 'ext'}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={children ? undefined : title}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  )
}
