import { describe, expect, it } from 'vitest'

/** Every source file of the app, tests apart, as text. */
const SOURCES = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('X5: every wallet request goes through chain/wallet.ts', () => {
  it('no other file signs, sends or deploys by itself', () => {
    const direct = /\b(signTypedData|signMessage|writeContract|sendTransaction|sendCalls|deployContract)\s*\(/
    const files = Object.keys(SOURCES)
    expect(files.length).toBeGreaterThan(100)
    expect(files.filter((p) => p !== './wallet.ts' && direct.test(SOURCES[p]))).toEqual([])
  })
})
