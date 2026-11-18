import { describe, expect, it } from 'vitest'
import { THEMES, isTheme, nextTheme } from './theme'

describe('themes', () => {
  it('cycles blue, violet, magenta, then back to blue', () => {
    expect(THEMES.map(nextTheme)).toEqual(['violet', 'magenta', 'blue'])
  })
  it('only accepts the three themes', () => {
    expect(isTheme('violet')).toBe(true)
    expect(isTheme('dark')).toBe(false)
    expect(isTheme(null)).toBe(false)
  })
})
