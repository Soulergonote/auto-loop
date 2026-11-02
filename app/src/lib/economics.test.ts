import { describe, expect, it } from 'vitest'
import { breakEvenDays, horizonApy, loopCosts, swapCostBase } from './economics'

const usd = (x: number) => BigInt(Math.round(x * 1e8))
const USDC = { price: usd(1), decimals: 6 }
const WETH = { price: usd(3000), decimals: 18 }

describe('loop economics', () => {
  it('measures the value lost in the swap', () => {
    // sell 3000 USDC, receive 0.997 WETH: 9 $ lost
    expect(swapCostBase(3000n * 10n ** 6n, USDC, 997n * 10n ** 15n, WETH)).toBe(usd(9))
    expect(swapCostBase(3000n * 10n ** 6n, USDC, 2n * 10n ** 18n, WETH)).toBe(0n)
  })

  it('adds exit premium, exit swap at the entry cost share and gas', () => {
    const c = loopCosts({ entrySoldBase: usd(6000), entrySwapBase: usd(6), debtBase: usd(6000), premiumBps: 5n, gasPriceWei: 10n ** 9n, nativePriceBase: usd(3000) })
    expect(c.exitPremium).toBe(usd(3))
    expect(c.exitSwap).toBe(usd(6))
    // 2.5M gas x 1 gwei x 3000 $ = 7.5 $
    expect(c.gas).toBe(usd(7.5))
    expect(c.total).toBe(usd(22.5))
  })

  it('annualises the yield over the horizon, net of costs, rewards only until the campaign ends', () => {
    // 1000 $ equity, 5 % rates + 10 % rewards ending in 30 days, 10 $ of costs, held 365 days
    const apy = horizonApy({ equityBase: usd(1000), ratesApy: 0.05, rewardsApy: 0.1, rewardDaysLeft: 30, costsBase: usd(10), days: 365 })
    expect(apy).toBeCloseTo(0.05 + (0.1 * 30) / 365 - 0.01)
    // held 30 days: costs weigh 12x more once annualised
    expect(horizonApy({ equityBase: usd(1000), ratesApy: 0.05, rewardsApy: 0, costsBase: usd(10), days: 30 })).toBeCloseTo(0.05 - 0.01 * (365 / 30))
  })

  it('finds the break-even holding time', () => {
    expect(breakEvenDays(usd(1000), 0.1, usd(10))).toBeCloseTo(36.5)
    expect(breakEvenDays(usd(1000), -0.01, usd(10))).toBe(Infinity)
    expect(breakEvenDays(usd(1000), 0.1, 0n)).toBe(0)
  })
})
