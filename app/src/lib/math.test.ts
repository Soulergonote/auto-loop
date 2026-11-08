import { describe, expect, it } from 'vitest'
import { parseUnits, toFunctionSelector, toFunctionSignature } from 'viem'
import {
  repayForTarget,
  collateralToSellForRepay,
  debtForLeverage,
  extraDebtForTarget,
  positionLeverage,
  toBase,
  flashLoanOwed,
  maxLeverage,
  oracleSwapOut,
  project,
  EMPTY_ACCOUNT,
} from './math'
import { decodeReserveConfig, rayAprToApy } from './aave'
import { executorAbi, executorAbiV1 } from '../abi'

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
    const data = 8000n | (8300n << 16n) | (10500n << 32n) | (18n << 48n) | (1n << 56n) | (1n << 58n) | (1n << 63n)
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

/** forge inspect LeverageExecutorV2 methodIdentifiers, in the ABI's order */
const SELECTORS_V2 = ['0x7535d246', '0x926ee4eb', '0x68883fad', '0x64cdaee6', '0xf48d7888', '0x7a19da58', '0xe83c2bc6', '0x61771e49', '0x7778ffdd']

describe('executor ABI', () => {
  // selectors checked against forge's methodIdentifiers for LeverageExecutorV2 (2026-11-08)
  it('matches the Solidity signatures of LeverageExecutorV2', () => {
    const sigs = executorAbi.filter((x) => x.type === 'function').map((f) => toFunctionSignature(f))
    const STEP = '(address,address,bytes,uint256)'
    const GUARD = '(uint256,uint256)'
    const SIG = '(uint256,uint256,uint8,bytes32,bytes32)'
    const OPEN = `(address,address,address,uint256,${STEP}[],uint256,${STEP}[],${GUARD})`
    const CLOSE = `(address,address,uint256,uint256,uint256,${STEP}[],address,${GUARD})`
    const SWAP = `(address,address,uint256,uint256,${STEP}[],address,${GUARD})`
    expect(sigs).toEqual([
      'POOL()',
      `open(${OPEN})`,
      `openWithSig(${OPEN},${SIG})`,
      `close(${CLOSE})`,
      `closeWithSig(${CLOSE},${SIG})`,
      `swapCollateral(${SWAP})`,
      `swapCollateralWithSig(${SWAP},${SIG})`,
      'isRouterAllowed(address)',
      'flashLenderKind(address)',
    ])
    expect(sigs.map((s) => toFunctionSelector(s))).toEqual(SELECTORS_V2)
  })
  it('keeps the v1 signatures for executors deployed before v2', () => {
    const S = '(address,bytes,uint256)'
    const G = '(uint256,uint256,uint8,bytes32,bytes32)'
    expect(executorAbiV1.filter((x) => x.type === 'function').map((f) => toFunctionSignature(f))).toEqual([
      'POOL()',
      `open((address,address,uint256,uint256,${S}))`,
      `openWithSig((address,address,uint256,uint256,${S}),${G})`,
      `close((address,address,uint256,uint256,uint256,${S}))`,
      `closeWithSig((address,address,uint256,uint256,uint256,${S}),${G})`,
      'isRouterAllowed(address)',
    ])
  })
})

describe('increasing an existing position', () => {
  const usd = (x: number) => BigInt(Math.round(x * 1e8))
  it('borrows only what is missing to reach the target leverage', () => {
    // 2x position: 6000 $ of WETH, 3000 $ of USDC debt, equity 3000 $. Target 3x with no new capital: debt 6000 $
    const pos = { collateralBase: usd(6000), debtBase: usd(3000) }
    expect(positionLeverage(pos)).toBe(2)
    expect(extraDebtForTarget(pos, 0n, 30_000n, USDC)).toBe(parseUnits('3000', 6))
    // adding 1 WETH (3000 $) at the same time: equity 6000 $, 3x = 12000 $ of debt, 9000 $ more
    expect(extraDebtForTarget(pos, usd(3000), 30_000n, USDC)).toBe(parseUnits('9000', 6))
    // already above the target: nothing to borrow
    expect(extraDebtForTarget(pos, 0n, 15_000n, USDC)).toBe(0n)
  })
  it('matches the fresh-position formula without a position', () => {
    const initial = parseUnits('1', 18)
    expect(extraDebtForTarget({ collateralBase: 0n, debtBase: 0n }, toBase(initial, WETH), 30_000n, USDC)).toBe(debtForLeverage(initial, 30_000n, WETH, USDC))
  })

  it('repays what brings the position down to the target leverage', () => {
    const usd = { price: 100_000_000n, decimals: 6 }
    // 7x on 1 000 $: 7 000 $ of collateral, 6 000 $ of debt
    const pos = { collateralBase: 7000n * 10n ** 8n, debtBase: 6000n * 10n ** 8n }
    expect(repayForTarget(pos, 30_000n, usd)).toBe(4000n * 10n ** 6n) // 3x: debt 2 000 $
    expect(repayForTarget(pos, 10_000n, usd)).toBe(6000n * 10n ** 6n) // 1x: everything
    expect(repayForTarget(pos, 80_000n, usd)).toBe(0n) // already below
  })
})
