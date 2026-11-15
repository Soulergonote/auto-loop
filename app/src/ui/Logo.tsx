import { Fragment } from 'react'
import { LOGOS } from '../generated/logos'

/** The logo of « Aave v3 », « Ethereum (Core) », « BNB Chain »… : the exact name, then without its bracket, then its first word. */
export function logoOf(name: string) {
  const bare = name.replace(/\s*\(.*\)$/, '')
  return LOGOS[name] ?? LOGOS[bare] ?? LOGOS[bare.split(' ')[0]]
}

/** Network or protocol logo (J4): 14 px, monochrome in the colour of the text beside it, decorative (the name follows). Nothing without a logo. */
export function Logo({ name }: { name: string }) {
  const logo = logoOf(name)
  if (!logo) return null
  return <svg className="logo" width="14" height="14" viewBox={logo.viewBox} aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo.body }} />
}

/** « Aave · Arbitrum » with the logo of each part that has one. */
export function Place({ text }: { text: string }) {
  return (
    <>
      {text.split(' · ').map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          <span className="with-logo">
            <Logo name={part} />
            {part}
          </span>
        </Fragment>
      ))}
    </>
  )
}
