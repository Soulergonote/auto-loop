import { domainSeparator, hexToSignature, type Address, type Hex, type TypedDataDomain } from 'viem'
import { readContract, signTypedData } from '@wagmi/core'
import { wagmiConfig } from '../../chain/wagmi'
import { debtTokenAbi } from '../../chain/abi'

/** Signature struct expected by LeverageExecutor.openWithSig / closeWithSig. */
export type ExecutorSignature = { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }

/**
 * Aave v3 tokens (aTokens, debt tokens) use EIP-712 with name = token name and version "1".
 * The domain is rebuilt locally and checked against the token's DOMAIN_SEPARATOR before signing,
 * so a wrong guess fails loudly instead of producing a useless signature.
 */
async function aaveTokenDomain(chainId: number, token: Address): Promise<{ domain: TypedDataDomain; nonceOf: (o: Address) => Promise<bigint> }> {
  const [name, separator] = await Promise.all([
    readContract(wagmiConfig, { chainId, address: token, abi: debtTokenAbi, functionName: 'name' }),
    readContract(wagmiConfig, { chainId, address: token, abi: debtTokenAbi, functionName: 'DOMAIN_SEPARATOR' }),
  ])
  const domain: TypedDataDomain = { name, version: '1', chainId, verifyingContract: token }
  const computed = domainSeparator({ domain })
  if (computed.toLowerCase() !== separator.toLowerCase()) {
    throw new Error(`Domaine EIP-712 inattendu pour ${name} : signature annulée`)
  }
  const nonceOf = (owner: Address) => readContract(wagmiConfig, { chainId, address: token, abi: debtTokenAbi, functionName: 'nonces', args: [owner] })
  return { domain, nonceOf }
}

function split(sig: Hex, value: bigint, deadline: bigint): ExecutorSignature {
  const { r, s, v, yParity } = hexToSignature(sig)
  return { value, deadline, v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s }
}

const deadlineIn = (seconds: number) => BigInt(Math.floor(Date.now() / 1000) + seconds)

/** Credit delegation on the variable debt token, consumed by openWithSig. */
export async function signDelegation(chainId: number, owner: Address, debtToken: Address, delegatee: Address, value: bigint) {
  const { domain, nonceOf } = await aaveTokenDomain(chainId, debtToken)
  const nonce = await nonceOf(owner)
  const deadline = deadlineIn(20 * 60)
  const sig = await signTypedData(wagmiConfig, {
    account: owner,
    domain,
    types: {
      DelegationWithSig: [
        { name: 'delegatee', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'DelegationWithSig',
    message: { delegatee, value, nonce, deadline },
  })
  return split(sig, value, deadline)
}

/** EIP-2612 permit on the collateral aToken, consumed by closeWithSig. */
export async function signATokenPermit(chainId: number, owner: Address, aToken: Address, spender: Address, value: bigint) {
  const { domain, nonceOf } = await aaveTokenDomain(chainId, aToken)
  const nonce = await nonceOf(owner)
  const deadline = deadlineIn(20 * 60)
  const sig = await signTypedData(wagmiConfig, {
    account: owner,
    domain,
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner, spender, value, nonce, deadline },
  })
  return split(sig, value, deadline)
}
