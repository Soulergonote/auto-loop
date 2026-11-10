// Simulates on the live Arc chain (one eth_call, nothing sent): deploy LeverageExecutorMorpho, open a 3x cirBTC / USDC
// loop with 1000 USDC through KyberSwap, then close it all. Arc's RPC has no eth_simulateV1 and an anvil fork cannot move
// USDC (Arc's native token, through a precompile), so the user is a harness contract created by the eth_call
// (contracts/script/ArcSimHarness.sol, `forge build` first), funded by a balance override.
//   NODE_USE_ENV_PROXY=1 npx vite-node e2e/arc-sim.ts
import { readFileSync } from 'node:fs'
import {
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  http,
  maxUint256,
  type Address,
  type Hex,
} from 'viem'
import { arc } from 'viem/chains'
import { morphoExecutorAbi, morphoAbi } from '../src/abi'
import { EXECUTOR_BYTECODE_MORPHO } from '../src/executorBytecode'
import { MORPHO_BLUE, executorRouters, AGGREGATORS } from '../src/config'

const RPC = 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ chain: arc, transport: http(RPC) })
const USDC: Address = '0x3600000000000000000000000000000000000000'
const CBTC: Address = '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0'
const MORPHO = MORPHO_BLUE[5042]
const FROM: Address = '0x00000000000000000000000000000000000d3910'
// the harness (the user) is create(FROM, its nonce), the executor create(harness, 1)
const nonce = BigInt(await client.getTransactionCount({ address: FROM }))
const H = getContractAddress({ from: FROM, nonce })
const X = getContractAddress({ from: H, nonce: 1n })
const kyber = 'https://aggregator-api.kyberswap.com/arc/api/v1'

async function quote(tokenIn: Address, tokenOut: Address, amountIn: bigint) {
  const h = { 'x-client-id': 'auto-loop', 'content-type': 'application/json' }
  const r = await (await fetch(`${kyber}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { headers: h })).json()
  const b = await (
    await fetch(`${kyber}/route/build`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        routeSummary: r.data.routeSummary,
        sender: X,
        recipient: X,
        slippageTolerance: 50,
        deadline: Math.floor(Date.now() / 1000) + 1200,
      }),
    })
  ).json()
  if (b.data.routerAddress.toLowerCase() !== AGGREGATORS.kyber.router.toLowerCase()) throw new Error('router ' + b.data.routerAddress)
  return { data: b.data.data as Hex, out: BigInt(b.data.amountOut) }
}

const api = await (
  await fetch('https://blue-api.morpho.org/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ markets(first: 1, where: {chainId_in: [5042], collateralAssetAddress_in: ["${CBTC}"], loanAssetAddress_in: ["${USDC}"], listed: true}, orderBy: SupplyAssetsUsd, orderDirection: Desc) { items { marketId lltv irmAddress oracle { address } } } }`,
    }),
  })
).json()
const m = api.data.markets.items[0]
const market = { loanToken: USDC, collateralToken: CBTC, oracle: m.oracle.address as Address, irm: m.irmAddress as Address, lltv: BigInt(m.lltv) }
console.log('market', m.marketId, 'lltv', Number(market.lltv) / 1e18, 'executor', X)

const capital = 1000_000000n
const debt = 2000_000000n
const buy = await quote(USDC, CBTC, capital + debt)
const guard = { minHealthFactor: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 1200) }
const openP = {
  market,
  capitalToken: USDC,
  capitalAmount: capital,
  capitalSteps: [],
  debtAmount: debt,
  steps: [{ router: AGGREGATORS.kyber.router as Address, tokenOut: CBTC, data: buy.data, minOut: (buy.out * 99n) / 100n }],
  guard,
}
// close: sell all the collateral the open guarantees (the rest comes back), repay everything
const sellAmount = (buy.out * 99n) / 100n
const sell = await quote(CBTC, USDC, sellAmount)
const closeP = {
  market,
  repayAmount: maxUint256,
  collateralToWithdraw: maxUint256,
  collateralToSell: sellAmount,
  steps: [{ router: AGGREGATORS.kyber.router as Address, tokenOut: USDC, data: sell.data, minOut: (sell.out * 99n) / 100n }],
  guard,
}
const executorInit = encodeDeployData({
  abi: morphoExecutorAbi,
  bytecode: EXECUTOR_BYTECODE_MORPHO,
  args: [MORPHO, executorRouters(5042).map((r) => r.router)],
})
const harness = JSON.parse(readFileSync(new URL('../../contracts/out/ArcSimHarness.sol/ArcSimHarness.json', import.meta.url), 'utf8')).bytecode.object as Hex
const args = encodeAbiParameters(
  [{ type: 'bytes' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bytes' }],
  [
    executorInit,
    MORPHO,
    USDC,
    capital,
    encodeFunctionData({ abi: morphoExecutorAbi, functionName: 'open', args: [openP] }),
    encodeFunctionData({ abi: morphoExecutorAbi, functionName: 'close', args: [closeP] }),
  ],
)
const { data } = await client.call({
  account: FROM,
  data: (harness + args.slice(2)) as Hex,
  gas: 30_000_000n,
  stateOverride: [
    { address: FROM, balance: 10n ** 20n },
    { address: H, balance: 10_000n * 10n ** 18n }, // 10 000 USDC (native, 18 decimals)
  ],
})
const [x, okOpen, retOpen, okClose, retClose, before, after, still] = decodeAbiParameters(
  [{ type: 'address' }, { type: 'bool' }, { type: 'bytes' }, { type: 'bool' }, { type: 'bytes' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
  data!,
)
const err = (ret: Hex) => {
  try {
    return JSON.stringify(decodeFunctionResult({ abi: morphoExecutorAbi, functionName: 'open', data: ret }), (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
  } catch {
    return ret.slice(0, 74)
  }
}
console.log('executor', x, x === X ? '(as quoted)' : '(MISMATCH)')
console.log('open', okOpen, okOpen ? err(retOpen) : retOpen.slice(0, 200))
console.log('close', okClose, okClose ? retClose.slice(0, 2 + 64 * 5) : retClose.slice(0, 200))
console.log('USDC before', Number(before) / 1e6, 'after', Number(after) / 1e6, 'cost', (Number(before) - Number(after)) / 1e6, 'still authorized', still)
console.log('quotes: buy', buy.out.toString(), 'cirBTC units for 3000 USDC; sell', sell.out.toString(), 'USDC units')
