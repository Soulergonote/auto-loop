import { describe, expect, it } from 'vitest'
import { concat, getAddress, keccak256, slice, toHex } from 'viem'
import { CREATE2_PROXY, CREATE2_SALT, create2Address, create2Calldata } from './create2'
import { deployDataV2 } from './deploy'
import { getMarket } from '../config'

describe('shared executor address', () => {
  it('follows the CREATE2 formula of the deterministic proxy', () => {
    const init = deployDataV2(getMarket('base'))
    const manual = getAddress(slice(keccak256(concat(['0xff', CREATE2_PROXY, CREATE2_SALT, keccak256(init)])), 12))
    expect(create2Address(init)).toBe(manual)
    expect(CREATE2_SALT).toBe(keccak256(toHex('auto-loop')))
    expect(create2Calldata(init)).toBe(concat([CREATE2_SALT, init]))
  })

  it('differs by market (pool, routers, lenders in the init code)', () => {
    expect(create2Address(deployDataV2(getMarket('base')))).not.toBe(create2Address(deployDataV2(getMarket('arbitrum'))))
  })
})
