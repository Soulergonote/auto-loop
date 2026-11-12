import { getAddress, isAddress, keccak256, slice, toBytes, type Address, type Chain } from 'viem'
import { arbitrum, arc, avalanche, base, bsc, hyperEvm, linea, mainnet, mantle, megaeth, monad, optimism, plasma, polygon, sonic, unichain } from 'viem/chains'

export type Token = { symbol: string; name: string; address: Address; decimals: number }

/**
 * Aave v3 markets the app offers: the larger Aave v3 deployments where Velora or KyberSwap quotes (checked 2026-10-31
 * against @bgd-labs/aave-address-book and each aggregator's chain list). Prices, risk parameters and the asset list
 * are read on-chain.
 * `soon`: listed for visibility but not selectable, with the reason shown.
 */
export type MarketDef = { id: string; label: string; chain: Chain; pool: Address; soon?: string }
/** The network alone, without the Aave market instance: « Ethereum (Prime) » → « Ethereum ». */
export const networkName = (label: string) => label.replace(/\s*\(.*\)$/, '')
/** The Aave market instance when a network has several: « Ethereum (Prime) » → « Prime ». */
export const marketInstance = (label: string) => label.match(/\((.*)\)$/)?.[1]

export const MARKETS: MarketDef[] = [
  { id: 'ethereum', label: 'Ethereum (Core)', chain: mainnet, pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
  { id: 'ethereum-prime', label: 'Ethereum (Prime)', chain: mainnet, pool: '0x4e033931ad43597d96D6bcc25c280717730B58B1' },
  { id: 'arbitrum', label: 'Arbitrum', chain: arbitrum, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'base', label: 'Base', chain: base, pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' },
  { id: 'avalanche', label: 'Avalanche', chain: avalanche, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'optimism', label: 'Optimism', chain: optimism, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'polygon', label: 'Polygon', chain: polygon, pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { id: 'bnb', label: 'BNB Chain', chain: bsc, pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' },
  { id: 'mantle', label: 'Mantle', chain: mantle, pool: '0x458F293454fE0d67EC0655f3672301301DD51422', soon: 'ni Velora ni KyberSwap n’y cotent' },
  { id: 'plasma', label: 'Plasma', chain: plasma, pool: '0x925a2A7214Ed92428B5b1B090F80b25700095e12' },
  { id: 'linea', label: 'Linea', chain: linea, pool: '0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac' },
  { id: 'sonic', label: 'Sonic', chain: sonic, pool: '0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3' },
  { id: 'monad', label: 'Monad', chain: monad, pool: '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef' },
  // MegaETH: Pool from @bgd-labs/aave-address-book 4.44.22 (AaveV3MegaEth), KyberSwap only; added 2026-11-11
  { id: 'megaeth', label: 'MegaETH', chain: megaeth, pool: '0x7e324AbC5De01d112AfC03a584966ff199741C28' },
]

export const DEFAULT_MARKET_ID = 'base'

/** Default pair on a new market: first symbol found in each list. */
export const DEFAULT_COLLATERAL_SYMBOLS = ['WETH', 'WETH.e', 'ETH', 'WBNB']
export const DEFAULT_DEBT_SYMBOLS = ['USDC', 'USDT0', 'USDT', 'USDt']

/** Base assets used by the demo mode (VITE_DEMO=true), where nothing is read on-chain. */
export const DEMO_TOKENS: Token[] = [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  { symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped stETH', address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18 },
  { symbol: 'weETH', name: 'Wrapped eETH', address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', decimals: 18 },
  { symbol: 'EURC', name: 'Euro Coin', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6 },
]

export type AggregatorId = 'velora' | 'kyber'
/** An aggregator, or 'best': every aggregator that quotes on the chain is asked and the highest output wins. */
export type AggregatorChoice = AggregatorId | 'best'

type Aggregator = {
  label: string
  router: Address
  /** chains the aggregator quotes on (undefined = not restricted) */
  chains?: number[]
}

/**
 * Router each aggregator's calldata must target. LeverageExecutor approves and calls the same address,
 * which holds for both (KyberSwap: MetaAggregationRouterV2, same address on
 * every chain listed). Same values as contracts/test/fork/BaseFork.t.sol; to re-verify against each aggregator's docs
 * before any deployment.
 */
export const AGGREGATORS: Record<AggregatorId, Aggregator> = {
  velora: {
    label: 'Velora',
    router: '0x6A000F20005980200259B80c5102003040001068',
    // from the API's own "Supported chains" error, 2026-10-31; Sonic (146) is listed but answers 503
    chains: [1, 10, 56, 100, 130, 137, 4663, 8453, 42161, 43114],
  },
  kyber: {
    label: 'KyberSwap',
    router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    // Mantle answers 404 (checked 2026-11-01); Arc quotes since 2026-11-10; Unichain, HyperEVM, MegaETH 2026-11-11
    // (router checked in each route answer). Also quotes on Berachain, Ronin, Etherlink: no Aave v3 nor Morpho API there.
    chains: [1, 10, 56, 130, 137, 143, 146, 999, 4326, 5042, 8453, 9745, 42161, 43114, 59144],
  },
}

/** KyberSwap names chains in its URLs. */
export const KYBER_CHAIN_SLUGS: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  130: 'unichain',
  137: 'polygon',
  143: 'monad',
  146: 'sonic',
  999: 'hyperevm',
  4326: 'megaeth',
  5042: 'arc',
  8453: 'base',
  9745: 'plasma',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
}

/** Client id sent to KyberSwap (identifies the integrator, no fee attached). */
export const KYBER_CLIENT_ID = 'auto-loop'

export function aggregatorsFor(chainId: number): AggregatorId[] {
  return (Object.keys(AGGREGATORS) as AggregatorId[]).filter((id) => supportsChain(id, chainId))
}

export function supportsChain(id: AggregatorId, chainId: number): boolean {
  const chains = AGGREGATORS[id].chains
  return !chains || chains.includes(chainId)
}

/** Partner name sent to Velora: without it the public API adds a 1 bps "anon" fee (checked on Base, 2026-10-18). */
export const VELORA_PARTNER = 'auto-loop'

/**
 * DEXes Velora may or must not route through (comma-separated Velora names, e.g. UniswapV3). For local fork
 * tests: oracle-priced pools (Kipseli, Tessera, WooFiV2, metric-v1…) quote from live state the fork does not
 * have and revert there, so the fork setup keeps only plain AMMs.
 */
export const VELORA_INCLUDE_DEXS = ((import.meta.env.VITE_VELORA_INCLUDE_DEXS as string | undefined) ?? '').trim()
export const VELORA_EXCLUDE_DEXS = ((import.meta.env.VITE_VELORA_EXCLUDE_DEXS as string | undefined) ?? '').trim()

/** Same for KyberSwap (its source ids, e.g. uniswapv3,aerodrome-cl,pancake-v3): prop AMMs such as kipseli-prop revert on a fork. */
export const KYBER_INCLUDED_SOURCES = ((import.meta.env.VITE_KYBER_INCLUDED_SOURCES as string | undefined) ?? '').trim()

/** Address the fork tests deploy the executor at; used as the quote taker until a real deployment exists. */
export const FORK_EXECUTOR: Address = getAddress(slice(keccak256(toBytes('auto-loop.executor.fork')), 12))

/**
 * Deployed LeverageExecutor per market (one per Aave pool): VITE_EXECUTORS='{"base":"0x…","arbitrum":"0x…"}'.
 * VITE_EXECUTOR_ADDRESS is still read as the Base one. Missing = not deployed there: everything is computed and
 * shown, but nothing is offered for signing.
 */
function readExecutors(): Record<string, Address> {
  const out: Record<string, Address> = {}
  try {
    const raw = JSON.parse((import.meta.env.VITE_EXECUTORS as string | undefined) || '{}') as Record<string, string>
    for (const [id, a] of Object.entries(raw)) if (isAddress(a)) out[id] = getAddress(a)
  } catch {
    console.warn('VITE_EXECUTORS illisible, ignoré')
  }
  const legacy = import.meta.env.VITE_EXECUTOR_ADDRESS as string | undefined
  if (legacy && isAddress(legacy) && !out.base) out.base = getAddress(legacy)
  return out
}
const EXECUTORS = readExecutors()

/**
 * Morpho Blue per chain, registered in v2 executors as a free flash lender for closes (no premium, unlike Aave).
 * Checked 2026-11-08 on each chain's RPC (Morpho Blue code, owner(), isIrmEnabled()). Balancer v2 is not used: its
 * Vault locks swaps during its own flash loans, so routes through Balancer pools would fail (audit L-02).
 */
export const MORPHO_BLUE: Record<number, Address> = {
  1: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  8453: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  42161: '0x6c247b1F6182318877311737BaC0844bAa518F5e',
  10: '0xce95AfbB8EA029495c66020883F87aaE8864AF92',
  137: '0x1bF0c2541F820E775182832f06c0B7Fc27A25f67',
  43114: '0x895383274303AA19fe978AFB4Ac55C7f094f982C',
  56: '0x01b0Bd309AA75547f7a37Ad7B1219A898E67a83a',
  146: '0xd6c916eB7542D0Ad3f18AEd0FCBD50C582cfa95f',
  // Arc: from Morpho's own address list (morpho-org/sdks, morpho-ts addresses.ts), 2026-11-10
  5042: '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD',
  // 2026-11-11: same in morpho-ts addresses.ts and the Morpho API (morphoBlues), owner() read on chain. Monad (143) stays out:
  // Aave v2 executors already deployed there have no Morpho lender, and their closes would pick it (see MORPHO_NETWORKS).
  130: '0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A',
  999: '0x68e37dE8d93d3496ae143F2E900490f6280C57cD',
}

/**
 * Morpho Blue as a lending platform (LeverageExecutorMorpho): the app networks where Morpho Blue is deployed and its
 * API (blue-api.morpho.org, market list and rates) answers. Checked 2026-11-09: the API refuses Avalanche, BNB and
 * Plasma; Sonic has no API data. Ethereum first, as Azerty asked; Arc added 2026-11-10.
 */
export type MorphoNetDef = { id: string; label: string; chain: Chain; morpho: Address }
export const MORPHO_NETWORKS: MorphoNetDef[] = [
  { id: 'morpho-ethereum', label: 'Ethereum', chain: mainnet, morpho: MORPHO_BLUE[1] },
  { id: 'morpho-base', label: 'Base', chain: base, morpho: MORPHO_BLUE[8453] },
  { id: 'morpho-arbitrum', label: 'Arbitrum', chain: arbitrum, morpho: MORPHO_BLUE[42161] },
  { id: 'morpho-optimism', label: 'Optimism', chain: optimism, morpho: MORPHO_BLUE[10] },
  { id: 'morpho-polygon', label: 'Polygon', chain: polygon, morpho: MORPHO_BLUE[137] },
  // Arc (Circle): gas paid in USDC, KyberSwap only, no Pendle; added 2026-11-10 at Azerty's request
  { id: 'morpho-arc', label: 'Arc', chain: arc, morpho: MORPHO_BLUE[5042] },
  // 2026-11-11: chains where KyberSwap quotes and the Morpho API lists markets (BNB, Linea, Sonic, Etherlink, MegaETH: API refuses)
  { id: 'morpho-unichain', label: 'Unichain', chain: unichain, morpho: MORPHO_BLUE[130] },
  { id: 'morpho-hyperevm', label: 'HyperEVM', chain: hyperEvm, morpho: MORPHO_BLUE[999] },
  // Monad: Morpho API + morpho-ts addresses.ts agree; code and owner() read on chain 2026-11-12
  { id: 'morpho-monad', label: 'Monad', chain: monad, morpho: '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee' },
]
export const isMorphoId = (id: string) => id.startsWith('morpho-')

/** Address the fork tests deploy the Morpho executor at; the quote taker until a real deployment exists. */
export const FORK_MORPHO_EXECUTOR: Address = getAddress(slice(keccak256(toBytes('auto-loop.morpho-executor.fork')), 12))

export type MorphoNet = MorphoNetDef & {
  executor?: Address
  executorSource?: 'build' | 'wallet'
  /** taker sent to the aggregators: the contract holds the tokens during the swap */
  quoteTaker: Address
}

export function getMorphoNet(id: string, local: Record<string, Address> = {}): MorphoNet {
  const def = MORPHO_NETWORKS.find((n) => n.id === id) ?? MORPHO_NETWORKS[0]
  const fromBuild = EXECUTORS[def.id]
  const executor = fromBuild ?? local[def.id]
  return { ...def, executor, executorSource: fromBuild ? 'build' : executor ? 'wallet' : undefined, quoteTaker: executor ?? FORK_MORPHO_EXECUTOR }
}

/**
 * Pendle (PT loops). The router is the same proxy on every chain; RouterStatic quotes on-chain, without Pendle's API.
 * Pendle is offered on every app network where Pendle is deployed (addresses from pendle-core-v2-public/deployments,
 * read 2026-11-09): no Pendle on Avalanche, Polygon or Linea. Tested in the browser on Ethereum (2026-11-08) and Base
 * (2026-11-09) forks that list a live PT on Aave; the RouterStatic and PT oracle answer on Arbitrum, Base, BNB,
 * Optimism, Mantle and Sonic, and on Plasma and Monad (read 2026-11-12, every listed market valid). New executors whitelist the
 * router; older ones keep working for every other pair.
 */
export const PENDLE_ROUTER: Address = '0x888888888889758F76e7103c6CbF23ABbF58F946'
export const PENDLE_ROUTER_STATIC: Record<number, Address> = {
  1: '0x263833d47eA3fA4a30f269323aba6a107f9eB14C',
  42161: '0xAdB09F65bd90d19e3148D9ccb693F3161C6DB3E8',
  8453: '0xB4205a645c7e920BD8504181B1D7f2c5C955C3e7',
  10: '0x704478Dd72FD7F9B83d1F1e0fc18C14B54F034d0',
  56: '0x2700ADB035F82a11899ce1D3f1BF8451c296eABb',
  5000: '0xCAd502Bb55d1A3F79952F969BFF3f011CF30a94a',
  9745: '0x6813d43782395A1F2AAb42f39aeEDE03ac655e09',
  146: '0x0013ACc071f732fd6BF8210AB46A3794a7D8945e',
  143: '0x6813d43782395A1F2AAb42f39aeEDE03ac655e09',
}
/** Pendle market factories (every version) whose `isValidMarket` vouches for a market. */
export const PENDLE_FACTORIES: Record<number, Address[]> = {
  1: [
    '0x27b1dAcd74688aF24a64BD3C9C1B143118740784',
    '0x1A6fCc85557BC4fB7B534ed835a03EF056552D52',
    '0x3d75Bd20C983edb5fD218A1b7e0024F1056c7A2F',
    '0x6fcf753f2C67b83f7B09746Bbc4FA0047b35D050',
    '0x6d247b1c044fA1E22e6B04fA9F71Baf99EB29A9f',
  ],
  42161: [
    '0xf5a7De2D276dbda3EEf1b62A9E718EFf4d29dDC8',
    '0x2FCb47B58350cD377f94d3821e7373Df60bD9Ced',
    '0xd9f5e9589016da862D2aBcE980A5A5B99A94f3E8',
    '0xd29e76c6F15ada0150D10A1D3f45aCCD2098283B',
    '0x49F2f7002669E0e4425Fa0203975625Ab4af3143',
  ],
  8453: ['0x59968008a703dC13E6beaECed644bdCe4ee45d13', '0x81E80A50E56d10C501fF17B5Fe2F662bd9EA4590'],
  10: [
    '0x17F100fB4bE2707675c6439468d38249DD993d58',
    '0x4A2B38b9cBd83c86F261a4d64c243795D4d44aBC',
    '0x73Be47237F12F36203823BAc9A4d80dC798B7015',
    '0x02Adf72d5D06a9C92136562Eb237C07696833a84',
    '0x95a937f7064C75C6Bc257160088C0a9D58cca333',
  ],
  56: [
    '0x2bEa6BfD8fbFF45aA2a893EB3B6d85D10EFcC70E',
    '0xC40fEbF5A33b8C92B187d9be0fD3fe0ac2E4B07c',
    '0x7D20e644D2A9e149e5be9bE9aD2aB243a7835d37',
    '0x7C7f73f7a320364DBB3C9aAa9bCcd402040EE0f9',
    '0x80cE46449DF1c977f6ba60495125ce282F83DdFB',
  ],
  5000: [
    '0xD228EC1f7D4313fe321fab511A872475D07F5bA6',
    '0xCa274A44a52241c1a8EFb9f84Bf492D8363929FC',
    '0xcb02435716b0143D4Ac1BDf370302D619E714126',
    '0xa35AE21a593CB06959978E20b33Db34163166C79',
  ],
  9745: ['0x28dE02Ac3c3F5ef427e55c321F73fDc7F192e8E4', '0x84A240Fa784E7F03CB99BA3716065961c5d0D531'],
  146: ['0xFeE31A6eC6eBefa0b5A594Bf5b1139e3c6fAA0fB', '0x0AB3ae25c42a2f3748a018556989355D568Fa6d6'],
  143: ['0xA3cb62a49b66eB2536cf6F3C7AC82293784888A3'],
}
/**
 * Known Pendle markets, used with the ones Pendle's API lists (it answers the deployed site, CORS limited to it): each
 * one is checked on-chain (factory, readTokens) before use. Lists read from the API on 2026-11-09 for the stablecoin and
 * staking PTs. PTs past maturity need no market: they are redeemed 1 for 1.
 */
export const PENDLE_MARKETS: Record<number, Address[]> = {
  1: [
    '0x90b70c407f1077f8eb92bf423b44cd92329b737a', // PT-reUSDe-10DEC2026
    '0x16d3126ee82ee36816499fb9db6f647c6addd09c', // PT-sUSN-22JUL2027
    '0x43c97094da0e894d3af2fda6f507d59a29888251', // PT-USDe-13AUG2026
    // PT collaterals of the largest Morpho Blue markets
    '0x13285bcbc27f92b47b4edb99d744c07b48c977c0', // PT-reUSD-10DEC2026
    '0x4a5067c3ff1abb7449244025b0e37feaf77d8e3e', // PT-USD3-17DEC2026
    '0x4ccf6deb3d1895373f604b418ff55d8adae8b846', // PT-USDat-14JAN2027
    '0x9c560ebaf78e596cbcc27411d633a74d628dd7dc', // PT-sUSDS-26NOV2026
  ],
  42161: [
    '0xf86119a39f8654f38acbbd5488bd83f3f51983c8', // PT-sUSDai-25FEB2027
    '0x46f545683d8494ef4c54b7ea40ca762c620846ef', // PT-USDai-25FEB2027
    '0xdf8c542a772a3a6a5daeed0f41296c2c3d2473df', // PT-USDai-24JUN2027
    '0x37fcd69d332a92a967194016b57ef4ff42bb4607', // PT-sUSDai-24JUN2027
  ],
  56: [
    '0x48fd92fd80e0256d455e82b7709b265fe44da9d2', // PT-USDat-14JAN2027
    '0x3974b474f33e00fe177b54206726a8d33fc87a57', // PT-slisBNB-15APR2027
  ],
  9745: ['0xdb96b529d19ff4a7d711e6e082172c77cfe88ed8'], // PT-sUSDe-28JAN2027
  143: [
    '0x88c5d8a908834e44b421cb67aec9a931782f9538', // PT-USDat-14JAN2027
    '0x22c2967cc989c313c8c3f205468a11f40f0a95f7', // PT-sUSDat-14JAN2027
    '0xc945210f85b55946eb970f427e4b9150fff600de', // PT-srUSDat-14JAN2027
    '0x176d9a5c25d3dfc9432eab81b38ddfb4ee0ace84', // PT-shMON-18MAR2027
    '0xea492a66e98a46426f03f5c3505ee89d96520813', // PT-reUSD-10DEC2026
    '0x9cbc42eff240ad2e43bbdc3c0562a9b4ce842a5a', // PT-AUSD-17DEC2026
    '0xdc66fcf20d4e8780ea9eda19d832345a2af69c42', // PT-earnAUSD-28JAN2027
    '0x9bf15c1824a4158d6f9c4ba8a19819e700f5e88b', // PT-sUSDe-28JAN2027
    '0xa9983573da171b910ba48dd5372a0ad60f737096', // PT-strUSD-04FEB2027
    '0x4124fabf9c3ae6a9844430ab6629036d0e4af47d', // PT-apyUSD-24DEC2026
  ],
}
export const pendleChain = (chainId: number) => !!PENDLE_ROUTER_STATIC[chainId]
/** Pendle's PT oracle (TWAP of the market's implied rate), read for the "Prix du PT" block; same address on every chain. */
export const PENDLE_PY_ORACLE: Record<number, Address> = {
  ...Object.fromEntries(Object.keys(PENDLE_ROUTER_STATIC).map((id) => [Number(id), '0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2' as Address])),
  1: '0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2',
}

/** Free flash lenders a new executor registers on a chain (kind 1 = Morpho), fixed for good like the routers. */
export function executorLenders(chainId: number): { kind: number; lender: Address }[] {
  const m = MORPHO_BLUE[chainId]
  return m ? [{ kind: 1, lender: getAddress(m) }] : []
}

export type Market = MarketDef & {
  executor?: Address
  /** contract version of `executor`, known once its code is checked on chain (2 for every new deployment) */
  executorVersion?: 1 | 2
  /** where the executor address comes from: the build (VITE_EXECUTORS) or a deployment from this browser's wallet */
  executorSource?: 'build' | 'wallet'
  /** taker sent to the aggregators: the contract holds the tokens during the swap */
  quoteTaker: Address
  /** the executor whitelists Pendle's router (PT loops), known once its code is checked */
  executorPendle?: boolean
}

/** Executors the user deployed (or pasted) from this browser, per market id. */
const LOCAL_EXECUTORS_KEY = 'auto-loop.executors'

export function savedExecutors(): Record<string, Address> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_EXECUTORS_KEY) || '{}') as Record<string, string>
    const out: Record<string, Address> = {}
    for (const [id, a] of Object.entries(raw)) if (isAddress(a)) out[id] = getAddress(a)
    return out
  } catch {
    return {}
  }
}

export function storeExecutors(all: Record<string, Address>) {
  try {
    localStorage.setItem(LOCAL_EXECUTORS_KEY, JSON.stringify(all))
  } catch {
    // private window: the address is kept for this visit only
  }
}

/** Routers a new executor whitelists on a chain (fixed for good): the aggregators that quote there, and Pendle's where PT loops are offered. */
export function executorRouters(chainId: number): { id: AggregatorId | 'pendle'; label: string; router: Address }[] {
  const seen = new Set<string>()
  const aggregators = aggregatorsFor(chainId).map((id) => ({ id, label: AGGREGATORS[id].label, router: getAddress(AGGREGATORS[id].router) }))
  const pendle = pendleChain(chainId) ? [{ id: 'pendle' as const, label: 'Pendle', router: getAddress(PENDLE_ROUTER) }] : []
  return [...aggregators, ...pendle].filter((r) => !seen.has(r.router) && !!seen.add(r.router))
}

export function getMarket(id: string, local: Record<string, Address> = {}): Market {
  const def = MARKETS.find((m) => m.id === id && !m.soon) ?? MARKETS.find((m) => m.id === DEFAULT_MARKET_ID)!
  const fromBuild = EXECUTORS[def.id]
  const executor = fromBuild ?? local[def.id]
  const executorSource = fromBuild ? 'build' : executor ? 'wallet' : undefined
  return { ...def, executor, executorSource, quoteTaker: executor ?? FORK_EXECUTOR }
}

/**
 * RPC per chain: VITE_RPC_URL_<chainId> if set (VITE_RPC_URL for Base, e.g. a local anvil fork), otherwise the
 * PublicNode endpoint with the chain's default public RPC as fallback. All keyless and callable from a browser.
 */
const PUBLICNODE: Record<number, string> = {
  [mainnet.id]: 'https://ethereum-rpc.publicnode.com',
  [arbitrum.id]: 'https://arbitrum-one-rpc.publicnode.com',
  [base.id]: 'https://base-rpc.publicnode.com',
  [avalanche.id]: 'https://avalanche-c-chain-rpc.publicnode.com',
  [optimism.id]: 'https://optimism-rpc.publicnode.com',
  [polygon.id]: 'https://polygon-bor-rpc.publicnode.com',
  [bsc.id]: 'https://bsc-rpc.publicnode.com',
  [mantle.id]: 'https://mantle-rpc.publicnode.com',
  [linea.id]: 'https://linea-rpc.publicnode.com',
  [sonic.id]: 'https://sonic-rpc.publicnode.com',
  [unichain.id]: 'https://unichain-rpc.publicnode.com',
  [hyperEvm.id]: 'https://hyperliquid-rpc.publicnode.com',
}

export function rpcUrls(chain: Chain): string[] {
  const env = import.meta.env as Record<string, string | undefined>
  const override = env[`VITE_RPC_URL_${chain.id}`] || (chain.id === base.id ? env.VITE_RPC_URL : undefined)
  if (override) return [override]
  // without a PublicNode endpoint, every public RPC of the chain in turn (Arc lists four)
  return PUBLICNODE[chain.id] ? [PUBLICNODE[chain.id], chain.rpcUrls.default.http[0]] : [...chain.rpcUrls.default.http]
}

/**
 * Keyless RPCs that answer calls at an old block (PublicNode refuses them without a token), for the share-price growth
 * of vault tokens (tokenYield.ts). Checked 12 Nov 2026: state 7 and 30 days back, CORS open to the app's origin.
 */
export const ARCHIVE_RPCS: Record<number, string[]> = {
  [mainnet.id]: ['https://eth.drpc.org', 'https://mainnet.gateway.tenderly.co', 'https://eth-mainnet.public.blastapi.io'],
  [base.id]: ['https://base.drpc.org', 'https://base.gateway.tenderly.co', 'https://mainnet.base.org'],
  [avalanche.id]: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-mainnet.gateway.tenderly.co'],
}

export type QuoteMode = 'auto' | 'live' | 'mock'
const rawMode = import.meta.env.VITE_QUOTE_MODE as string | undefined
export const QUOTE_MODE: QuoteMode = rawMode === 'live' || rawMode === 'mock' ? rawMode : 'auto'

/** Static illustrative market data instead of on-chain reads (screenshots, offline work). Never for real use. */
export const DEMO = import.meta.env.VITE_DEMO === 'true'

/**
 * The chain's wrapped native token among the market's assets (WETH, WPOL, WBNB, WAVAX, WXPL, wS, WMON…), to price
 * gas with the Aave oracle. Undefined when the market does not list it.
 */
export function wrappedNative(tokens: Token[] | undefined, chain: Chain): Token | undefined {
  const sym = chain.nativeCurrency.symbol.toUpperCase()
  const names = new Set([`W${sym}`, sym, ...(sym === 'POL' ? ['WMATIC', 'WPOL'] : [])])
  return tokens?.find((t) => names.has(t.symbol.toUpperCase()))
}
