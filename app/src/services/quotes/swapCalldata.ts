/**
 * Reads what an aggregator's calldata will really do before the wallet signs it: which tokens, how much it sells,
 * the minimum it accepts and who receives the output. A quote for a swap made from the user's wallet is used only
 * when its calldata pays the wallet itself, sells exactly the quoted amount and keeps a minimum at least the app's.
 */
import { decodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem'

/** Augustus v6.2 (Velora): beneficiary 0 means msg.sender. */
const veloraAbi = parseAbi([
  'function swapExactAmountIn(address executor, (address srcToken, address destToken, uint256 fromAmount, uint256 toAmount, uint256 quotedAmount, bytes32 metadata, address beneficiary) swapData, uint256 partnerAndFee, bytes permit, bytes executorData)',
])

const kyberDesc =
  '(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit)'
/** KyberSwap MetaAggregationRouterV2: the two entry points its build API returns. */
const kyberAbi = parseAbi([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${kyberDesc} desc, bytes clientData) execution)`,
  `function swapSimpleMode(address caller, ${kyberDesc} desc, bytes executorData, bytes clientData)`,
])

export type SwapTerms = {
  sell: Address
  buy: Address
  amount: bigint
  /** what the router pulls from the caller (KyberSwap splits it across receivers): never more than `amount` */
  pulled: bigint
  minOut: bigint
  recipient: Address
  fee: bigint
}

/** The terms encoded in a Velora or KyberSwap calldata; undefined for any other method (refused by the caller). */
export function swapTerms(aggregator: string, data: Hex, sender: Address): SwapTerms | undefined {
  try {
    if (aggregator === 'velora') {
      const { args } = decodeFunctionData({ abi: veloraAbi, data })
      const s = args[1]
      return {
        sell: getAddress(s.srcToken),
        buy: getAddress(s.destToken),
        amount: s.fromAmount,
        pulled: s.fromAmount,
        minOut: s.toAmount,
        recipient: s.beneficiary === zeroAddress ? getAddress(sender) : getAddress(s.beneficiary),
        fee: args[2] & 0x3fffn,
      }
    }
    if (aggregator === 'kyber') {
      const decoded = decodeFunctionData({ abi: kyberAbi, data })
      const d = decoded.functionName === 'swap' ? decoded.args[0].desc : decoded.args[1]
      return {
        sell: getAddress(d.srcToken),
        buy: getAddress(d.dstToken),
        amount: d.amount,
        pulled: d.srcAmounts.reduce((a, b) => a + b, 0n),
        minOut: d.minReturnAmount,
        recipient: getAddress(d.dstReceiver),
        fee: d.feeAmounts.reduce((a, b) => a + b, 0n),
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Why a wallet swap calldata cannot be signed, or undefined when it matches: same tokens, exact amount sold, output
 * to the user, no fee, and a minimum not below `minOut` (the quote's minus slippage, as the app shows it).
 */
export function walletSwapProblem(
  aggregator: string,
  data: Hex,
  expected: { sell: Address; buy: Address; amount: bigint; user: Address; minOut: bigint },
): string | undefined {
  const t = swapTerms(aggregator, data, expected.user)
  if (!t) return 'méthode de swap inconnue'
  if (t.sell !== getAddress(expected.sell) || t.buy !== getAddress(expected.buy)) return 'tokens du swap différents du devis'
  if (t.amount !== expected.amount || t.pulled > expected.amount) return 'montant vendu différent du devis'
  if (t.recipient !== getAddress(expected.user)) return 'le swap paie une autre adresse que le portefeuille'
  if (t.fee !== 0n) return 'le swap prélève des frais'
  if (t.minOut < expected.minOut) return 'minimum du swap sous celui du devis'
  return undefined
}
