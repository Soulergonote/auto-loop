/**
 * The only way the app reaches the wallet (X5). Every signature, transaction, batch and deployment goes through here:
 * the request is decoded into a French recap (services/recap) and shown by <SigningRecap> while the wallet asks,
 * then cleared, whatever the answer. A test (wallet.test.ts) fails when a wallet call bypasses this file.
 */
import { useSyncExternalStore } from 'react'
import { encodeFunctionData, erc20Abi, type Abi, type Address, type Hash, type Hex } from 'viem'
import { getAccount, readContract, readContracts, sendCalls, sendTransaction, signTypedData, writeContract } from '@wagmi/core'
import { wagmiConfig } from './wagmi'
import { CREATE2_PROXY, create2Address, create2Calldata } from './create2'
import {
  addressesIn,
  callArgs,
  eModeSet,
  describeBatch,
  describeCall,
  describeTypedData,
  type Call,
  type Recap,
  type RecapContext,
  type TypedData,
} from '../services/recap/describe'
import { eModeOf, nameOf, rememberEMode, rememberToken, tokenOf, v4ReserveOf } from '../services/recap/names'
import { poolAbi } from './abi'
import { fmtAddress } from '../ui/format'

// ---------------------------------------------------------------------------------------------------------------------
// The recap on screen
// ---------------------------------------------------------------------------------------------------------------------

let shown: Recap | undefined
const listeners = new Set<() => void>()
const show = (r: Recap | undefined) => {
  shown = r
  listeners.forEach((l) => l())
}

/** What the wallet is being asked right now, if anything. */
export const useSigningRecap = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    () => shown,
  )

/** Shows the recap while `send` waits for the wallet; a recap that cannot be built never stops the request. */
async function withRecap<T>(build: () => Promise<Recap>, send: () => Promise<T>): Promise<T> {
  let recap: Recap
  try {
    recap = await build()
  } catch (e) {
    recap = {
      kind: 'Demande',
      title: 'Demande au portefeuille',
      sentence: 'L’app n’a pas pu lire cette demande : vérifie-la dans le portefeuille.',
      lines: [],
      warnings: [`Récapitulatif indisponible : ${(e as Error).message}`],
      raw: '',
    }
  }
  show(recap)
  try {
    return await send()
  } finally {
    show(undefined)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Names: what the recap needs to know about the addresses it shows
// ---------------------------------------------------------------------------------------------------------------------

/** Symbol and decimals of the addresses that are neither a known contract nor an already read token. */
async function readTokens(chainId: number, addresses: Set<Address>) {
  const unknown = [...addresses].filter((a) => !nameOf(chainId, a) && !tokenOf(chainId, a))
  if (!unknown.length) return
  const res = await readContracts(wagmiConfig, {
    allowFailure: true,
    contracts: unknown.flatMap((address) => [
      { chainId, address, abi: erc20Abi, functionName: 'symbol' } as const,
      { chainId, address, abi: erc20Abi, functionName: 'decimals' } as const,
    ]),
  })
  unknown.forEach((a, i) => {
    const symbol = res[2 * i]?.result
    const decimals = res[2 * i + 1]?.result
    if (typeof symbol === 'string' && typeof decimals === 'number') rememberToken(chainId, a, { symbol, decimals })
  })
}

/** The labels of the eMode categories the calls set. */
async function readEModes(chainId: number, calls: Call[]) {
  for (const c of calls) {
    const id = eModeSet(c)
    if (id === undefined || eModeOf(chainId, c.to, id)) continue
    const label = await readContract(wagmiConfig, { chainId, address: c.to, abi: poolAbi, functionName: 'getEModeCategoryLabel', args: [id] })
    if (label) rememberEMode(chainId, c.to, id, label)
  }
}

/** Reads what the recap of `calls` (or of a signed message, `extra`) names, then gives the context to describe them. */
async function context(chainId: number, user: Address | undefined, calls: Call[], extra?: unknown): Promise<RecapContext> {
  const addresses = addressesIn([extra, calls.map((c) => [c.to, callArgs(c.data)])])
  await Promise.all([readTokens(chainId, addresses).catch(() => undefined), readEModes(chainId, calls).catch(() => undefined)])
  return {
    chainId,
    user: user ?? getAccount(wagmiConfig).address ?? '0x0000000000000000000000000000000000000000',
    nowSec: Math.floor(Date.now() / 1000),
    name: (a) => nameOf(chainId, a),
    token: (a) => tokenOf(chainId, a),
    v4Reserve: (spoke, id) => v4ReserveOf(chainId, spoke, id),
    eMode: (pool, id) => eModeOf(chainId, pool, id),
  }
}

const accountOf = (a: unknown): Address | undefined => (typeof a === 'string' ? (a as Address) : (a as { address?: Address } | undefined)?.address)

// ---------------------------------------------------------------------------------------------------------------------
// The wallet calls
// ---------------------------------------------------------------------------------------------------------------------

/** An EIP-712 signature. */
export function walletSignTypedData(args: Parameters<typeof signTypedData>[1] & { chainId: number }): Promise<Hex> {
  const { chainId, ...rest } = args
  const td = rest as unknown as TypedData
  return withRecap(
    async () => describeTypedData(await context(chainId, accountOf(rest.account), [], [td.message, td.domain]), td),
    () => signTypedData(wagmiConfig, rest),
  )
}

/** A contract call prepared by `simulateContract` (its `request`). */
export function walletWriteContract(request: {
  address: Address
  abi: unknown
  functionName: string
  args?: readonly unknown[]
  chainId?: number
  account?: unknown
  value?: bigint
}): Promise<Hash> {
  const chainId = request.chainId ?? getAccount(wagmiConfig).chainId!
  return withRecap(
    async () => {
      const data = encodeFunctionData({ abi: request.abi as Abi, functionName: request.functionName, args: request.args ?? [] } as never)
      const call: Call = { to: request.address, data, value: request.value }
      return describeCall(await context(chainId, accountOf(request.account), [call]), call)
    },
    () => writeContract(wagmiConfig, request as never),
  )
}

/** A raw transaction (a call the app encoded itself, a swap from the wallet). */
export function walletSendTransaction(args: { chainId: number; account?: Address; to: Address; data: Hex; value?: bigint }): Promise<Hash> {
  return withRecap(
    async () => describeCall(await context(args.chainId, args.account, [args]), args),
    () => sendTransaction(wagmiConfig, args),
  )
}

/** An atomic batch (EIP-5792). */
export function walletSendCalls(args: { chainId: number; account: Address; calls: Call[] }) {
  return withRecap(
    async () => describeBatch(await context(args.chainId, args.account, args.calls), args.calls),
    () =>
      sendCalls(wagmiConfig, {
        chainId: args.chainId,
        account: args.account,
        forceAtomic: true,
        calls: args.calls.map(({ to, data, value }) => ({ to, data, ...(value ? { value } : {}) })),
      }),
  )
}

/**
 * A deployment of one of Auto-loop's contracts: through the deterministic proxy at the shared CREATE2 address, or a
 * plain deployment (same init code, no `to`) where the chain has no proxy.
 */
export function walletDeploy(d: { chainId: number; contract: string; initCode: Hex; viaProxy: boolean }): Promise<Hash> {
  const target = d.viaProxy ? create2Address(d.initCode) : undefined
  return withRecap(
    async () => ({
      kind: 'Déploiement',
      title: `Déploiement du contrat ${d.contract}`,
      sentence: `Déploie ${d.contract}${target ? ` à l’adresse commune ${fmtAddress(target)}` : ''}. Tu paies le gas ; le contrat n’a ni propriétaire ni fonction d’administration, et l’app vérifie son code juste après.`,
      lines: [
        {
          label: 'Par',
          value: d.viaProxy ? `la fabrique CREATE2 (${fmtAddress(CREATE2_PROXY)})` : 'un déploiement direct (pas de fabrique CREATE2 sur ce réseau)',
        },
        ...(target ? [{ label: 'Adresse prévue', value: target }] : []),
      ],
      warnings: [],
      raw: '',
    }),
    () =>
      d.viaProxy
        ? sendTransaction(wagmiConfig, { chainId: d.chainId, to: CREATE2_PROXY, data: create2Calldata(d.initCode) })
        : sendTransaction(wagmiConfig, { chainId: d.chainId, data: d.initCode }),
  )
}
