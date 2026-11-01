import { describe, expect, it } from 'vitest'
import { parseUnits, toFunctionSelector, toFunctionSignature } from 'viem'
import {
  collateralToSellForRepay,
  debtForLeverage,
  flashLoanOwed,
  maxLeverage,
  oracleSwapOut,
  project,
  EMPTY_ACCOUNT,
} from './math'
import { decodeReserveConfig, rayAprToApy } from './aave'
import { executorAbi } from '../abi'

const WETH = { price: 2500n * 10n ** 8n, decimals: 18 }
const USDC = { price: 1n * 10n ** 8n, decimals: 6 }

describe('leverage maths', () => {
  it('borrows C0 x (L - 1) of debt', () => {
    // 1 WETH at 3x = 5000 USDC of debt
    expect(debtForLeverage(parseUnits('1', 18), 30_000n, WETH, USDC)).toBe(parseUnits('5000', 6))
    expect(debtForLeverage(parseUnits('1', 18), 10_000n, WETH, USDC)).toBe(0n)
  })

  it('max leverage is 1 / (1 - LTV)', () => {
    expect(maxLeverage(8000)).toBeCloseTo(5)
    expect(maxLeverage(9300)).toBeCloseTo(14.2857, 3)
  })

  it('projects HF and liquidation drop like the architecture doc (3x ETH/USDC, LT 83 %)', () => {
    const initial = parseUnits('1', 18)
    const debt = debtForLeverage(initial, 30_000n, WETH, USDC)
    const bought = oracleSwapOut(debt, USDC, WETH)
    const p = project(EMPTY_ACCOUNT, initial + bought, WETH, 8300, debt, USDC)
    expect(p.healthFactor).toBeCloseTo(1.245, 3)
    expect(p.dropToLiquidation).toBeCloseTo(0.197, 3)
    expect(p.leverage).toBeCloseTo(3, 6)
    expect(p.ltv).toBeCloseTo(2 / 3, 6)
  })

  it('merges with an existing account', () => {
    const existing = { collateralBase: 10_000n * 10n ** 8n, debtBase: 0n, liquidationThresholdBps: 8000n }
    const p = project(existing, 0n, WETH, 8300, parseUnits('4000', 6), USDC)
    expect(p.healthFactor).toBeCloseTo(2, 6)
  })

  it('sells enough collateral to cover debt + premium after slippage', () => {
    const debt = parseUnits('5000', 6)
    const sell = collateralToSellForRepay(debt, 5n, 50n, WETH, USDC)
    const worstOut = (oracleSwapOut(sell, WETH, USDC) * 9950n) / 10_000n
    expect(worstOut).toBeGreaterThanOrEqual(flashLoanOwed(debt, 5n))
  })

  it('rounds the flash loan premium like Aave (half up)', () => {
    expect(flashLoanOwed(10_000n, 5n)).toBe(10_005n)
    expect(flashLoanOwed(1_000n, 5n)).toBe(1_001n) // 0.5 rounds up
    expect(flashLoanOwed(999n, 5n)).toBe(999n) // 0.4995 rounds down
  })
})

describe('Aave decoding', () => {
  it('decodes a reserve configuration bitmap', () => {
    const data =
      8000n | (8300n << 16n) | (10500n << 32n) | (18n << 48n) | (1n << 56n) | (1n << 58n) | (1n << 63n)
    const c = decodeReserveConfig(data)
    expect(c).toMatchObject({
      ltvBps: 8000,
      liquidationThresholdBps: 8300,
      liquidationBonusBps: 10500,
      decimals: 18,
      active: true,
      frozen: false,
      borrowingEnabled: true,
      paused: false,
      flashLoanEnabled: true,
      isolated: false,
    })
    expect(decodeReserveConfig(data | (1n << 212n)).isolated).toBe(true)
  })

  it('converts a ray APR to APY', () => {
    expect(rayAprToApy(5n * 10n ** 25n)).toBeCloseTo(Math.exp(0.05) - 1, 6)
  })
})

describe('executor ABI', () => {
  it('matches the Solidity signatures of LeverageExecutor', () => {
    const sigs = executorAbi.filter((x) => x.type === 'function').map((f) => toFunctionSignature(f))
    const S = '(address,bytes,uint256)'
    const G = '(uint256,uint256,uint8,bytes32,bytes32)'
    expect(sigs).toEqual([
      'POOL()',
      `open((address,address,uint256,uint256,${S}))`,
      `openWithSig((address,address,uint256,uint256,${S}),${G})`,
      `close((address,address,uint256,uint256,uint256,${S}))`,
      `closeWithSig((address,address,uint256,uint256,uint256,${S}),${G})`,
      'isRouterAllowed(address)',
    ])
    expect(toFunctionSelector(sigs[1])).toMatch(/^0x[0-9a-f]{8}$/)
  })
})
