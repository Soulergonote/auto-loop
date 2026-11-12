/**
 * One shared executor per market at a predictable address: deployed through the deterministic deployment proxy
 * (0x4e59…956C, same address on every chain of the app, checked 2026-11-12 with e2e/probe-create2.ts) with a fixed
 * salt, so the address only depends on the contract's code and its constructor arguments (pool, routers, lenders).
 * Anyone can deploy it once; everyone else finds it there. The contracts have no owner and act only for the address
 * that signs, so sharing one is safe; the app still checks its code before use.
 */
import { concat, getContractAddress, keccak256, toHex, type Address, type Hex } from 'viem'

export const CREATE2_PROXY: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
export const CREATE2_SALT: Hex = keccak256(toHex('auto-loop'))

/** where the proxy deploys this init code (bytecode + constructor arguments) */
export const create2Address = (initCode: Hex): Address => getContractAddress({ opcode: 'CREATE2', from: CREATE2_PROXY, salt: CREATE2_SALT, bytecode: initCode })

/** calldata of the proxy: salt, then the init code */
export const create2Calldata = (initCode: Hex): Hex => concat([CREATE2_SALT, initCode])
