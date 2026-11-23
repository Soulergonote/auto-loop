import { describe, expect, it } from 'vitest'
import { aaveMarketUrl, aaveV4SpokeUrl, merklOpportunityUrl, morphoMarketUrl, pendleMarketUrl } from './links'
import { MARKETS } from '../config'

describe('protocol links', () => {
  it('links every Aave v3 market to app.aave.com, not the SparkLend fork', () => {
    for (const m of MARKETS) expect(!!aaveMarketUrl(m), m.id).toBe(!m.fork)
    expect(aaveMarketUrl(MARKETS.find((m) => m.id === 'ethereum-prime')!)).toBe('https://app.aave.com/markets/?marketName=proto_lido_v3')
  })
  it('builds the Aave v4, Morpho, Pendle and Merkl pages', () => {
    expect(morphoMarketUrl(8453, '0x12')).toBe('https://app.morpho.org/base/market/0x12')
    expect(morphoMarketUrl(31337, '0x12')).toBeUndefined()
    expect(pendleMarketUrl(9745, '0xAB')).toBe('https://app.pendle.finance/trade/markets/0xab/swap?view=pt&chain=plasma')
    expect(pendleMarketUrl(9745, undefined)).toBeUndefined()
    // Spoke.id of « Ethena Correlated » in api.v4.aave.com
    expect(aaveV4SpokeUrl(1, '0x58131e79531cab1d52301228d1f7b842f26b9649')).toBe(
      'https://pro.aave.com/explore/market/MTo6MHg1ODEzMUU3OTUzMWNhQjFkNTIzMDEyMjhkMWY3Yjg0MkYyNkI5NjQ5',
    )
    expect(merklOpportunityUrl('42')).toBe('https://app.merkl.xyz/opportunities/42')
  })
})
