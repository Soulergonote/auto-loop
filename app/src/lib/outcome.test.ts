import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, getAddress, maxUint256, type Hex, type Log } from 'viem'
import { decodeOutcome, executorEventsAbi, outcomeLines } from './outcome'

const a = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const USER = a(0x11),
  OTHER = a(0x12),
  EXECUTOR = a(0xe1),
  STRANGER = a(0xe2),
  WETH = a(0xc0),
  WSTETH = a(0xc1),
  USDC = a(0xd0),
  ROUTER = a(0x7001),
  MORPHO = a(0x8001)
const E18 = 10n ** 18n
/** the formats use thin and non-breaking spaces */
const plain = (lines: string[]) => lines.map((l) => l.replace(/\s/g, ' '))
const tokens = [
  { address: WETH, symbol: 'WETH', decimals: 18 },
  { address: WSTETH, symbol: 'wstETH', decimals: 18 },
  { address: USDC, symbol: 'USDC', decimals: 6 },
]

/** A log as the executor at `address` would emit it. */
function log(address: `0x${string}`, eventName: string, args: Record<string, unknown>): Log {
  const ev = executorEventsAbi.find((e) => e.name === eventName)!
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as [Hex, ...Hex[]]
  const plainInputs = (ev.inputs as readonly { name: string; indexed?: boolean }[]).filter((i) => !i.indexed)
  const data = encodeAbiParameters(plainInputs as never, plainInputs.map((i) => args[i.name]) as never)
  return { address, topics, data, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false } as Log
}
const swapped = (tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint, amountOut: bigint, user = USER, at = EXECUTOR) =>
  log(at, 'Swapped', { user, router: ROUTER, tokenIn, tokenOut, amountIn, amountOut })

describe('decodeOutcome', () => {
  it('an open with the capital swapped first: both swaps and the amounts', () => {
    const logs = [
      swapped(WSTETH, WETH, 5n * 10n ** 17n, 624n * 10n ** 15n),
      swapped(USDC, WETH, 2_790_400_000n, 1248n * 10n ** 15n),
      log(EXECUTOR, 'PositionOpened', {
        user: USER,
        collateralAsset: WETH,
        debtAsset: USDC,
        capitalToken: WSTETH,
        capitalAmount: 5n * 10n ** 17n,
        collateralSupplied: 1872n * 10n ** 15n,
        debtBorrowed: 2_790_400_000n,
        healthFactor: 1_264n * 10n ** 15n,
      }),
    ]
    const o = decodeOutcome(logs, EXECUTOR, USER)!
    expect(o.kind).toBe('open')
    expect(o.swaps).toHaveLength(2)
    expect(plain(outcomeLines(o, tokens, { supplied: 1873n * 10n ** 15n }))).toEqual([
      'Capital 0,5 wstETH',
      'Déposé 1,872 WETH (devis 1,873)',
      'Emprunté 2 790,40 USDC',
      'Swap 0,5 wstETH → 0,624 WETH',
      'Swap 2 790,40 USDC → 1,248 WETH',
      'Health factor 1,26',
    ])
  })

  it('a full close: infinite health factor, no premium line through Morpho, the estimate left out when it matches', () => {
    const logs = [
      swapped(WETH, USDC, 175n * 10n ** 16n, 4_483_000_000n),
      log(EXECUTOR, 'PositionClosed', {
        user: USER,
        collateralAsset: WETH,
        debtAsset: USDC,
        flashLender: MORPHO,
        result: {
          debtRepaid: 4_470_500_000n,
          collateralWithdrawn: 3n * E18,
          collateralReturned: 125n * 10n ** 16n,
          debtReturned: 12_500_000n,
          flashPremium: 0n,
          healthFactor: maxUint256,
        },
      }),
    ]
    const o = decodeOutcome(logs, EXECUTOR, USER)!
    expect(o.healthFactor).toBe(Infinity)
    expect(plain(outcomeLines(o, tokens, { collateralReturned: 125n * 10n ** 16n }))).toEqual([
      'Dette remboursée 4 470,50 USDC',
      'Collatéral retiré 3 WETH',
      'Swap 1,75 WETH → 4 483,00 USDC',
      'Rendu 1,25 WETH',
      'Rendu 12,5 USDC',
      'Health factor ∞',
    ])
  })

  it('a collateral swap through Aave: the premium is shown', () => {
    const logs = [
      log(EXECUTOR, 'CollateralSwapped', {
        user: USER,
        fromAsset: WETH,
        toAsset: WSTETH,
        flashLender: a(0x9001),
        result: { withdrawn: 3n * E18, supplied: 2_45n * 10n ** 16n, flashPremium: 13n * 10n ** 14n, healthFactor: 118n * 10n ** 16n },
      }),
    ]
    const lines = plain(outcomeLines(decodeOutcome(logs, EXECUTOR, USER)!, tokens))
    expect(lines).toContain('Prime du flash loan 0,0013 wstETH')
    expect(lines[0]).toBe('Retiré 3 WETH')
  })

  it('ignores the logs of another contract or another account', () => {
    const opened = (user: `0x${string}`, at: `0x${string}`) =>
      log(at, 'PositionOpened', {
        user,
        collateralAsset: WETH,
        debtAsset: USDC,
        capitalToken: WETH,
        capitalAmount: E18,
        collateralSupplied: 3n * E18,
        debtBorrowed: 1n,
        healthFactor: E18,
      })
    expect(decodeOutcome([opened(USER, STRANGER), opened(OTHER, EXECUTOR)], EXECUTOR, USER)).toBeUndefined()
    expect(decodeOutcome([swapped(WETH, USDC, 1n, 1n, OTHER), opened(USER, EXECUTOR)], EXECUTOR, USER)!.swaps).toHaveLength(0)
  })
})
