/**
 * The small ↗ next to a name (drawn by the CSS of every new-tab link): opens the protocol's own page (reserve,
 * market) or the Merkl page of a bonus in a new tab. Nothing without a link. It stops the click so a clickable row
 * (Scanner) does not open as well.
 */
export function ExtLink({ href, title }: { href?: string; title: string }) {
  if (!href) return null
  return <a className="ext" href={href} target="_blank" rel="noreferrer" title={title} aria-label={title} onClick={(e) => e.stopPropagation()} />
}
