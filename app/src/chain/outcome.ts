/**
 * What a v2 transaction really did, read from its receipt: the executor emits one event per action
 * (PositionOpened, PositionClosed, CollateralSwapped, DebtSwapped) and one `Swapped` per swap step. Only the executor's own logs
 * for the connected account count; a v1 executor emits none of these, so nothing is shown for it.
 */
import { parseAbi, parseEventLogs, type Address, type Hash, type Log } from 'viem'
import { getTransactionReceipt } from '@wagmi/core'
import { wagmiConfig } from './wagmi'
import { fmtAmount, fmtHf } from '../ui/format'

export const executorEventsAbi = parseAbi([
  'event Swapped(address indexed user, address indexed router, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
  'event PositionOpened(address indexed user, address indexed collateralAsset, address indexed debtAsset, address capitalToken, uint256 capitalAmount, uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)',
  'event PositionClosed(address indexed user, address indexed collateralAsset, address indexed debtAsset, address flashLender, (uint256 debtRepaid, uint256 collateralWithdrawn, uint256 collateralReturned, uint256 debtReturned, uint256 flashPremium, uint256 healthFactor) result)',
  'event CollateralSwapped(address indexed user, address indexed fromAsset, address indexed toAsset, address flashLender, (uint256 withdrawn, uint256 supplied, uint256 flashPremium, uint256 healthFactor) result)',
  'event DebtSwapped(address indexed user, address indexed fromAsset, address indexed toAsset, (uint256 repaid, uint256 borrowed, uint256 returned, uint256 healthFactor) result)',
])

export type SwapDone = { tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint }

/** Aave reports an account without debt with the max uint256 health factor. */
const hf = (x: bigint) => (x >= 10n ** 59n ? Infinity : Number(x) / 1e18)

export type Outcome =
  | {
      kind: 'open'
      collateral: Address
      debt: Address
      capitalToken: Address
      capitalAmount: bigint
      supplied: bigint
      borrowed: bigint
      healthFactor: number
      swaps: SwapDone[]
    }
  | {
      kind: 'close'
      collateral: Address
      debt: Address
      flashLender: Address
      debtRepaid: bigint
      collateralWithdrawn: bigint
      collateralReturned: bigint
      debtReturned: bigint
      flashPremium: bigint
      healthFactor: number
      swaps: SwapDone[]
    }
  | {
      kind: 'swap'
      from: Address
      to: Address
      flashLender: Address
      withdrawn: bigint
      supplied: bigint
      flashPremium: bigint
      healthFactor: number
      swaps: SwapDone[]
    }
  | {
      kind: 'debt'
      from: Address
      to: Address
      repaid: bigint
      borrowed: bigint
      returned: bigint
      healthFactor: number
      swaps: SwapDone[]
    }

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The action and swaps of `user` through `executor` in these logs (the last action when there are several). */
export function decodeOutcome(logs: Log[], executor: Address, user: Address): Outcome | undefined {
  const mine = parseEventLogs({ abi: executorEventsAbi, logs }).filter((l) => same(l.address, executor) && same(l.args.user, user))
  const swaps: SwapDone[] = mine.flatMap((l) =>
    l.eventName === 'Swapped' ? [{ tokenIn: l.args.tokenIn, tokenOut: l.args.tokenOut, amountIn: l.args.amountIn, amountOut: l.args.amountOut }] : [],
  )
  const action = mine.filter((l) => l.eventName !== 'Swapped').at(-1)
  if (!action) return undefined
  switch (action.eventName) {
    case 'PositionOpened': {
      const a = action.args
      return {
        kind: 'open',
        collateral: a.collateralAsset,
        debt: a.debtAsset,
        capitalToken: a.capitalToken,
        capitalAmount: a.capitalAmount,
        supplied: a.collateralSupplied,
        borrowed: a.debtBorrowed,
        healthFactor: hf(a.healthFactor),
        swaps,
      }
    }
    case 'PositionClosed': {
      const a = action.args
      return {
        kind: 'close',
        collateral: a.collateralAsset,
        debt: a.debtAsset,
        flashLender: a.flashLender,
        ...a.result,
        healthFactor: hf(a.result.healthFactor),
        swaps,
      }
    }
    case 'CollateralSwapped': {
      const a = action.args
      return { kind: 'swap', from: a.fromAsset, to: a.toAsset, flashLender: a.flashLender, ...a.result, healthFactor: hf(a.result.healthFactor), swaps }
    }
    case 'DebtSwapped': {
      const a = action.args
      return { kind: 'debt', from: a.fromAsset, to: a.toAsset, ...a.result, healthFactor: hf(a.result.healthFactor), swaps }
    }
  }
}

/** Reads the mined transaction's receipt; undefined when the RPC does not answer or nothing was emitted. */
export async function readOutcome(chainId: number, hash: Hash | undefined, executor: Address, user: Address): Promise<Outcome | undefined> {
  if (!hash) return undefined
  try {
    const receipt = await getTransactionReceipt(wagmiConfig, { chainId, hash })
    return decodeOutcome(receipt.logs, executor, user)
  } catch {
    return undefined
  }
}

export type TokenInfo = { address: Address; symbol: string; decimals: number }

/** Estimates shown before signing, to point out where the real amounts differ. */
export type Expected = { supplied?: bigint; collateralReturned?: bigint; debtReturned?: bigint }

/** Differs from the estimate by more than 0.01 %. */
const differs = (real: bigint, expected?: bigint) =>
  expected !== undefined && expected > 0n && (real > expected ? real - expected : expected - real) * 10_000n > expected

/** One line per amount, as the charte formats them; zero amounts are left out. */
export function outcomeLines(o: Outcome, tokens: TokenInfo[], expected: Expected = {}): string[] {
  const t = (a: Address) => tokens.find((x) => same(x.address, a))
  const amt = (x: bigint, a: Address) => {
    const k = t(a)
    return k ? `${fmtAmount(x, k.decimals)} ${k.symbol}` : undefined
  }
  const est = (x: bigint, a: Address, e?: bigint) => (differs(x, e) ? ` (devis ${fmtAmount(e!, t(a)?.decimals ?? 18)})` : '')
  const swapLines = o.swaps.flatMap((s) => {
    const i = amt(s.amountIn, s.tokenIn)
    const out = amt(s.amountOut, s.tokenOut)
    return i && out ? [`Swap ${i} → ${out}`] : []
  })
  const lines: (string | false | undefined)[] = []
  if (o.kind === 'open')
    lines.push(
      o.capitalAmount > 0n && amt(o.capitalAmount, o.capitalToken) && `Capital ${amt(o.capitalAmount, o.capitalToken)}`,
      `Déposé ${amt(o.supplied, o.collateral)}${est(o.supplied, o.collateral, expected.supplied)}`,
      o.borrowed > 0n && `Emprunté ${amt(o.borrowed, o.debt)}`,
      ...swapLines,
    )
  if (o.kind === 'close')
    lines.push(
      `Dette remboursée ${amt(o.debtRepaid, o.debt)}`,
      `Collatéral retiré ${amt(o.collateralWithdrawn, o.collateral)}`,
      ...swapLines,
      o.collateralReturned > 0n && `Rendu ${amt(o.collateralReturned, o.collateral)}${est(o.collateralReturned, o.collateral, expected.collateralReturned)}`,
      o.debtReturned > 0n && `Rendu ${amt(o.debtReturned, o.debt)}${est(o.debtReturned, o.debt, expected.debtReturned)}`,
      o.flashPremium > 0n && `Prime du flash loan ${amt(o.flashPremium, o.debt)}`,
    )
  if (o.kind === 'swap')
    lines.push(
      `Retiré ${amt(o.withdrawn, o.from)}`,
      `Déposé ${amt(o.supplied, o.to)}${est(o.supplied, o.to, expected.supplied)}`,
      ...swapLines,
      o.flashPremium > 0n && `Prime du flash loan ${amt(o.flashPremium, o.to)}`,
    )
  if (o.kind === 'debt')
    lines.push(
      `Dette remboursée ${amt(o.repaid, o.from)}`,
      `Nouvelle dette ${amt(o.borrowed, o.to)}`,
      ...swapLines,
      o.returned > 0n && `Rendu ${amt(o.returned, o.from)}${est(o.returned, o.from, expected.debtReturned)}`,
    )
  lines.push(`Health factor ${fmtHf(o.healthFactor)}`)
  return lines.filter((l): l is string => typeof l === 'string' && !l.includes('undefined'))
}
