import { getAddress, type Hex } from 'viem'
import type { MorphoMarket } from '../protocols/morpho/markets'

/** Three Ethereum markets as the app builds them (from Morpho's API on 2026-11-09): PT-USD3 / USDC, wstETH / WETH, PT-reUSD / USDC. */
type Raw = Omit<MorphoMarket, 'id' | 'params' | 'liquidity' | 'collateralYield'> & {
  id: string
  params: { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string }
  liquidity: string
  collateralYield: MorphoMarket['collateralYield'] | null
}
const raw: Raw[] = [
  {
    id: '0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89',
    chainId: 1,
    params: {
      loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      collateralToken: '0x7f47c3e6b2c00fC4eB4d5Ae50d0Ab0Ab6888Eb4D',
      oracle: '0xe5E6Ec063E63A9D0c6Ac041d0AD2bd03F7f08d72',
      irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
      lltv: '860000000000000000',
    },
    listed: true,
    collateral: {
      address: '0x7f47c3e6b2c00fC4eB4d5Ae50d0Ab0Ab6888Eb4D',
      symbol: 'PT-USD3-17DEC2026',
      name: 'PT-USD3-17DEC2026',
      decimals: 6,
    },
    loan: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USDC',
      decimals: 6,
    },
    collateralUsd: 0.9850160076541181,
    loanUsd: 0.999739076,
    collateralYield: null,
    lltv: 0.86,
    borrowApy: 0.09008604162199121,
    liquidity: '2361174608110',
    liquidityUsd: 2360558.5209865533,
    borrowUsd: 17318131.017023336,
    utilization: 0.8800449330517118,
  },
  {
    id: '0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e',
    chainId: 1,
    params: {
      loanToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      collateralToken: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
      oracle: '0xbD60A6770b27E084E8617335ddE769241B0e71D8',
      irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
      lltv: '965000000000000000',
    },
    listed: true,
    collateral: {
      address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
      symbol: 'wstETH',
      name: 'wstETH',
      decimals: 18,
    },
    loan: {
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      name: 'WETH',
      decimals: 18,
    },
    collateralUsd: 2654.6409318272513,
    loanUsd: 2121.7666954683964,
    collateralYield: {
      apy: 0.022625040416776043,
      source: 'vault',
    },
    lltv: 0.965,
    borrowApy: 0.019642369000017933,
    liquidity: '5919758488338566074698',
    liquidityUsd: 12560346.405773109,
    borrowUsd: 63834566.38287542,
    utilization: 0.8355866124159063,
  },
  {
    id: '0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64',
    chainId: 1,
    params: {
      loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      collateralToken: '0xeCfaFdC7741323a945A163ed068B5a3C43483957',
      oracle: '0x217d6DdCDB95112C51657F6270e8C079CFDB51f0',
      irm: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
      lltv: '915000000000000000',
    },
    listed: true,
    collateral: {
      address: '0xeCfaFdC7741323a945A163ed068B5a3C43483957',
      symbol: 'PT-reUSD-10DEC2026',
      name: 'PT-reUSD-10DEC2026',
      decimals: 6,
    },
    loan: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USDC',
      decimals: 6,
    },
    collateralUsd: 0.9897623619364122,
    loanUsd: 0.999739076,
    collateralYield: null,
    lltv: 0.915,
    borrowApy: 0.09471498197576218,
    liquidity: '15294592600685',
    liquidityUsd: 15290601.87440526,
    borrowUsd: 133087234.85398573,
    utilization: 0.8969482086304098,
  },
]

export const MORPHO_MARKETS: MorphoMarket[] = raw.map((m) => ({
  ...m,
  id: m.id as Hex,
  params: {
    loanToken: getAddress(m.params.loanToken),
    collateralToken: getAddress(m.params.collateralToken),
    oracle: getAddress(m.params.oracle),
    irm: getAddress(m.params.irm),
    lltv: BigInt(m.params.lltv),
  },
  collateral: { ...m.collateral, address: getAddress(m.collateral.address) },
  loan: { ...m.loan, address: getAddress(m.loan.address) },
  liquidity: BigInt(m.liquidity),
  collateralYield: m.collateralYield ?? undefined,
}))
