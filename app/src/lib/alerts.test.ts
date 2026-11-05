import { describe, expect, it } from 'vitest'
import { alertReport, positionAlerts } from './alerts'
import { toCampaign } from './merkl'
import { summarizePosition, type Holding } from './positions'
import { USD, reserve } from './testReserves'
import type { SnapReserve } from './snapshot'

const NOW = Date.UTC(2026, 10, 5)
const hold = (r: SnapReserve, suppliedUsd: number, borrowedUsd: number): Holding => ({
  reserve: r,
  supplied: 0n,
  borrowed: 0n,
  suppliedBase: BigInt(suppliedUsd) * USD,
  borrowedBase: BigInt(borrowedUsd) * USD,
})
const usde = reserve(0, 'USDe', { supplyApy: 0.03 })
const gho = reserve(1, 'GHO', { borrowApy: 0.05 })
// a 7x USDe / GHO loop on 1 000 $ of equity
const loop = [hold(usde, 7000, 0), hold(gho, 0, 6000)]

describe('alerts', () => {
  it('says nothing about a healthy, profitable position', () => {
    const summary = summarizePosition(loop, [], 1.2, NOW)
    const ok = { ...summary, apy: 0.04 }
    expect(positionAlerts({ market: 'Plasma', summary: ok, healthFactor: 1.2, correlated: true }, NOW)).toEqual([])
    expect(alertReport([], [])).toBe('Aucune alerte.')
  })

  it('uses the colour thresholds of the screen, correlated or not', () => {
    const summary = { ...summarizePosition(loop, [], 1.05, NOW), apy: 0.04 }
    const [warn] = positionAlerts({ market: 'Plasma', summary, healthFactor: 1.05, correlated: true }, NOW)
    expect(warn).toMatchObject({ kind: 'hf', level: 'warn' })
    expect(warn.text).toContain('sous 1,08')
    const [bad] = positionAlerts({ market: 'Base', summary, healthFactor: 1.05, correlated: false }, NOW)
    expect(bad).toMatchObject({ kind: 'hf', level: 'bad' })
    expect(bad.text).toContain('sous 1,1')
  })

  it('flags a negative net APY', () => {
    const summary = summarizePosition(loop, [], 1.2, NOW)
    expect(summary.apy).toBeLessThan(0)
    const alerts = positionAlerts({ market: 'Plasma', summary, healthFactor: 1.2, correlated: true }, NOW)
    expect(alerts.map((a) => a.kind)).toEqual(['apy'])
    expect(alerts[0].text).toMatch(/^APY net −/)
  })

  it('warns about a counted Merkl campaign ending within 7 days, not one ending later', () => {
    const campaign = (days: number) =>
      toCampaign({
        type: 'AAVE_SUPPLY',
        action: 'LEND',
        name: `Ethena ${days}`,
        identifier: usde.aToken,
        explorerAddress: usde.aToken,
        tokens: [],
        apr: 5,
        latestCampaignEnd: Math.floor(NOW / 1000) + days * 86_400,
      } as never)!
    const summary = summarizePosition(loop, [campaign(1.5), campaign(20)], 1.2, NOW)
    const merkl = positionAlerts({ market: 'Plasma', summary, healthFactor: 1.2, correlated: true }, NOW).filter((a) => a.kind === 'merkl')
    expect(merkl).toHaveLength(1)
    expect(merkl[0].text).toContain('« Ethena 1.5 » : fin le 6 nov. (1 j)')
    expect(alertReport(merkl, ['Monad'])).toBe(`🟠 Plasma : ${merkl[0].text}\nNon lus : Monad (RPC qui ne répond pas).`)
  })
})
