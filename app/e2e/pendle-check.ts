// Fork check of the Pendle routes through the executor, without the browser: open a PT loop, then close it.
//   NET=ethereum bash e2e/fork.sh   (prints the executor)
//   EXECUTOR=0x… VITE_RPC_URL_1=http://127.0.0.1:8545 npx vite-node e2e/pendle-check.ts [pt] [eMode]
import { createPublicClient, createWalletClient, http, maxUint256, parseUnits, type Address } from 'viem'
import { mainnet } from 'viem/chains'
import { getQuote } from '../src/lib/quotes'
import { closeCall, encodeCall, openCall, type ClosePlan, type OpenPlan } from '../src/lib/execute'
import { erc20Abi, debtTokenAbi, poolAbi } from '../src/abi'
import { forgetPts, readPt } from '../src/lib/pendle'

const R = 'http://127.0.0.1:8545'
const U: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const POOL: Address = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const USDC = { symbol: 'USDC', name: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address, decimals: 6 }
const PT = { symbol: 'PT', name: 'PT', address: (process.argv[2] ?? '0x2aE4f59E500b6ddEB88c480edf277eDA54A00205') as Address, decimals: 18 }
const EMODE = Number(process.argv[3] ?? 49)
const EXECUTOR = process.env.EXECUTOR as Address
const pub = createPublicClient({ chain: mainnet, transport: http(R) })
const wal = createWalletClient({ chain: mainnet, transport: http(R), account: U })
const side = { price: 10n ** 8n, decimals: 6 }
const ptSide = { price: 10n ** 8n, decimals: 18 }
async function send(to: Address, data: `0x${string}`, what: string) {
  const hash = await wal.sendTransaction({ to, data, gas: 3_000_000n })
  const r = await pub.waitForTransactionReceipt({ hash })
  console.log(what, r.status, 'gas', r.gasUsed)
  if (r.status !== 'success') process.exit(1)
}
const reserve = await pub.readContract({ address: POOL, abi: poolAbi, functionName: 'getReserveData', args: [USDC.address] })
const ptReserve = await pub.readContract({ address: POOL, abi: poolAbi, functionName: 'getReserveData', args: [PT.address] })
console.log('pt info', await readPt(1, PT.address))
await wal.writeContract({ address: POOL, abi: poolAbi, functionName: 'setUserEMode', args: [EMODE] })
const capital = parseUnits('1000', 6)
const debt = parseUnits('3000', 6)
await wal.writeContract({ address: USDC.address, abi: erc20Abi, functionName: 'approve', args: [EXECUTOR, capital] })
await wal.writeContract({ address: reserve.variableDebtTokenAddress, abi: debtTokenAbi, functionName: 'approveDelegation', args: [EXECUTOR, debt] })
const q = await getQuote({
  aggregator: 'best',
  chainId: 1,
  sell: USDC,
  buy: PT,
  sellAmount: capital + debt,
  taker: EXECUTOR,
  slippageBps: 10n,
  oracle: { sell: side, buy: ptSide },
})
console.log(
  'open quote',
  q.simulated,
  q.fallbackReason,
  q.route?.map((l) => `${l.via} ${l.sell.symbol}->${l.buy.symbol} ${l.sellAmount} -> ${l.buyAmount} min ${l.minOut}`),
  q.pendle,
)
const open = openCall({
  version: 2,
  collateral: PT.address,
  debt: USDC.address,
  initialCollateral: capital,
  capitalToken: USDC.address,
  debtAmount: debt,
  quote: q,
} as OpenPlan)
await send(EXECUTOR, encodeCall(open), 'open')
const aBal = await pub.readContract({ address: ptReserve.aTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [U] })
const acc = await pub.readContract({ address: POOL, abi: poolAbi, functionName: 'getUserAccountData', args: [U] })
console.log('aPT', aBal, 'hf', Number(acc[5]) / 1e18)
if (process.env.WARP) {
  await pub.request({ method: 'evm_increaseTime' as never, params: [Number(process.env.WARP)] as never })
  await pub.request({ method: 'evm_mine' as never, params: [] as never })
  forgetPts()
  // the quotes' deadlines follow the wall clock: move it with the chain's
  const real = Date.now
  Date.now = () => real() + Number(process.env.WARP) * 1000
  console.log('warped', process.env.WARP, 's')
}
const cq = await getQuote({
  aggregator: 'best',
  chainId: 1,
  sell: PT,
  buy: USDC,
  sellAmount: aBal,
  taker: EXECUTOR,
  slippageBps: 10n,
  oracle: { sell: ptSide, buy: side },
})
console.log(
  'close quote',
  cq.simulated,
  cq.fallbackReason,
  cq.route?.map((l) => `${l.via} ${l.sell.symbol}->${l.buy.symbol} ${l.sellAmount} -> ${l.buyAmount} min ${l.minOut}`),
  cq.pendle,
)
await wal.writeContract({ address: ptReserve.aTokenAddress, abi: erc20Abi, functionName: 'approve', args: [EXECUTOR, maxUint256] })
const close = closeCall({
  version: 2,
  flashLender: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  collateral: PT.address,
  debt: USDC.address,
  full: true,
  repayAmount: 0n,
  collateralToWithdraw: 0n,
  collateralToSell: aBal,
  quote: cq,
} as unknown as ClosePlan)
await send(EXECUTOR, encodeCall(close), 'close')
const left = await pub.readContract({ address: POOL, abi: poolAbi, functionName: 'getUserAccountData', args: [U] })
console.log(
  'after close: collateral',
  left[0],
  'debt',
  left[1],
  'usdc',
  await pub.readContract({ address: USDC.address, abi: erc20Abi, functionName: 'balanceOf', args: [U] }),
)
