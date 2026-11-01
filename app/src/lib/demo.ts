import { zeroAddress } from 'viem'
import type { Token } from '../config'
import type { Reserve, UserState } from './useMarket'

/** Illustrative values only (round numbers), used when VITE_DEMO=true. */
const DEMO_PARAMS: Record<string, { price: number; ltv: number; lt: number; supply: number; borrow: number }> = {
  WETH: { price: 2500, ltv: 8000, lt: 8300, supply: 0.02, borrow: 0.028 },
  USDC: { price: 1, ltv: 7500, lt: 7800, supply: 0.045, borrow: 0.06 },
  cbBTC: { price: 65000, ltv: 7300, lt: 7800, supply: 0.005, borrow: 0.015 },
  cbETH: { price: 2700, ltv: 7500, lt: 7900, supply: 0.01, borrow: 0.02 },
  wstETH: { price: 3000, ltv: 7500, lt: 7900, supply: 0.01, borrow: 0.02 },
  weETH: { price: 2650, ltv: 7250, lt: 7500, supply: 0.012, borrow: 0.02 },
  EURC: { price: 1.08, ltv: 7500, lt: 7800, supply: 0.03, borrow: 0.05 },
}

export function demoReserve(token: Token): Reserve {
  const p = DEMO_PARAMS[token.symbol] ?? DEMO_PARAMS.USDC
  const price = BigInt(Math.round(p.price * 1e8))
  return {
    token,
    id: 0,
    config: {
      ltvBps: p.ltv,
      liquidationThresholdBps: p.lt,
      liquidationBonusBps: 10500,
      decimals: token.decimals,
      active: true,
      frozen: false,
      borrowingEnabled: true,
      paused: false,
      flashLoanEnabled: true,
      isolated: false,
    },
    aToken: zeroAddress,
    variableDebtToken: zeroAddress,
    supplyApy: p.supply,
    borrowApy: p.borrow,
    supplyRewardApr: 0,
    borrowRewardApr: 0,
    price,
    side: { price, decimals: token.decimals },
  }
}

/** A demo position worth $7,500 of collateral against $5,000 of debt. */
export function demoUser(collateral: Reserve, debt: Reserve): UserState {
  const units = (usd: number, r: Reserve) => (BigInt(usd) * 10n ** 8n * 10n ** BigInt(r.config.decimals)) / r.price
  const collateralBase = 7500n * 10n ** 8n
  const debtBase = 5000n * 10n ** 8n
  return {
    account: { collateralBase, debtBase, liquidationThresholdBps: BigInt(collateral.config.liquidationThresholdBps) },
    healthFactor: (7500 * collateral.config.liquidationThresholdBps) / 10_000 / 5000,
    eModeCategory: 0,
    collateralBalance: units(2500, collateral),
    collateralAllowance: 0n,
    aTokenBalance: units(7500, collateral),
    aTokenAllowance: 0n,
    debtBalance: units(5000, debt),
    borrowAllowance: 0n,
  }
}
