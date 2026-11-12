import type { Address } from 'viem'

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
