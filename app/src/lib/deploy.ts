import { encodeDeployData, getAddress, type Address, type Hex } from 'viem'
import { CREATE2_PROXY, create2Address, create2Calldata } from './create2'
import { deployContract, getPublicClient, sendTransaction, waitForTransactionReceipt } from '@wagmi/core'
import { useQuery } from '@tanstack/react-query'
import { wagmiConfig } from '../wagmi'
import { executorAbi, executorAbiV1, morphoExecutorAbi } from '../abi'
import { EXECUTOR_BYTECODE_MORPHO, EXECUTOR_BYTECODE_V1, EXECUTOR_BYTECODE_V2 } from '../generated/executorBytecode'
import { executorLenders, executorRouters, type Market, type MorphoNet } from '../config'

export type ExecutorVersion = 1 | 2
/** What the code check found: the contract version, and whether Pendle's router is whitelisted (PT loops). */
export type ExecutorCheck = { version: ExecutorVersion; pendle: boolean }

export function deployDataV2(market: Market) {
  const routers = executorRouters(market.chain.id).map((r) => r.router)
  return encodeDeployData({ abi: executorAbi, bytecode: EXECUTOR_BYTECODE_V2, args: [market.pool, routers, executorLenders(market.chain.id)] })
}

function deployDataV1(market: Market) {
  const routers = executorRouters(market.chain.id).map((r) => r.router)
  return encodeDeployData({ abi: executorAbiV1, bytecode: EXECUTOR_BYTECODE_V1, args: [market.pool, routers] })
}

/**
 * Checks that `address` runs exactly the audited-in-tests LeverageExecutor for this market, and says which version:
 * its code must equal what the constructor produces for this Aave pool (dry-run of the deployment, same compiler
 * output as the tests), and every aggregator router (and, for v2, the Morpho lender) of the market must be registered.
 * Code equality also proves there is no owner or admin function. A v1 executor (deployed before v2) is still accepted:
 * positions live in the user's Aave account, so either version manages them. Pendle's router is checked on its own:
 * an executor deployed before PT loops lacks it and stays usable for every other pair.
 */
export async function verifyExecutor(market: Market, address: Address): Promise<ExecutorCheck> {
  const client = getPublicClient(wagmiConfig, { chainId: market.chain.id })
  if (!client) throw new Error(`pas de connexion à ${market.chain.name}`)
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error(`aucun contrat à cette adresse sur ${market.chain.name}`)
  let version: ExecutorVersion | undefined
  for (const [v, data] of [
    [2, deployDataV2(market)],
    [1, deployDataV1(market)],
  ] as const) {
    const expected = await client.call({ data }).catch(() => undefined)
    if (expected?.data && expected.data.toLowerCase() === code.toLowerCase()) {
      version = v
      break
    }
  }
  if (!version) throw new Error('le code de ce contrat n’est pas celui d’Auto-loop pour ce marché')
  const abi = version === 2 ? executorAbi : executorAbiV1
  let pendle = false
  for (const r of executorRouters(market.chain.id)) {
    const ok = await client.readContract({ address, abi, functionName: 'isRouterAllowed', args: [r.router] })
    if (r.id === 'pendle') pendle = ok && version === 2
    else if (!ok) throw new Error(`le routeur ${r.label} n’est pas autorisé dans ce contrat`)
  }
  if (version === 2)
    for (const l of executorLenders(market.chain.id)) {
      const kind = await client.readContract({ address, abi: executorAbi, functionName: 'flashLenderKind', args: [l.lender] })
      if (kind !== l.kind) throw new Error('le prêteur Morpho n’est pas enregistré dans ce contrat')
    }
  return { version, pendle }
}

export function useExecutorCheck(market: Market) {
  return useQuery({
    queryKey: ['executor-check', market.id, market.executor],
    queryFn: () => verifyExecutor(market, market.executor!),
    enabled: !!market.executor,
    staleTime: Infinity,
    retry: 1,
  })
}

/** the market's shared v2 executor address (CREATE2 through the deterministic proxy) */
export const sharedExecutorAddress = (market: Market) => create2Address(deployDataV2(market))

const hasCode = async (chainId: number, address: Address) => {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error('pas de connexion au réseau')
  const code = await client.getCode({ address })
  return !!code && code !== '0x'
}

/** the market's shared executor when someone already deployed it (and it passes the code check), else undefined */
export async function findSharedExecutor(market: Market): Promise<Address | undefined> {
  const a = sharedExecutorAddress(market)
  if (!(await hasCode(market.chain.id, a))) return undefined
  return (await verifyExecutor(market, a)).version === 2 ? a : undefined
}

export function useSharedExecutor(market: Market, enabled: boolean) {
  return useQuery({
    queryKey: ['shared-executor', market.id],
    queryFn: async () => (await findSharedExecutor(market)) ?? null,
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

/**
 * Deploys `initCode` from the connected wallet at its shared address through the deterministic proxy; a chain without
 * the proxy gets a plain deployment. Returns the address once the receipt is in (an address someone filled in the
 * meantime is returned as is).
 */
async function deployShared(chainId: number, initCode: Hex, onStep: (s: string) => void, plain: () => Promise<Hex>): Promise<Address> {
  const target = create2Address(initCode)
  if (await hasCode(chainId, target)) return target
  const viaProxy = await hasCode(chainId, CREATE2_PROXY)
  onStep('Signature du déploiement dans le portefeuille…')
  const hash = viaProxy ? await sendTransaction(wagmiConfig, { chainId, to: CREATE2_PROXY, data: create2Calldata(initCode) }) : await plain()
  onStep('Déploiement en cours, en attente de confirmation…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
  if (receipt.status !== 'success') throw new Error('le déploiement a échoué')
  if (viaProxy) {
    if (!(await hasCode(chainId, target))) throw new Error('le déploiement a échoué')
    return target
  }
  if (!receipt.contractAddress) throw new Error('le déploiement a échoué')
  return getAddress(receipt.contractAddress)
}

/** Deploys the market's shared (v2) executor from the connected wallet, waits for it, then verifies it on chain. */
export async function deployExecutor(market: Market, onStep: (s: string) => void): Promise<Address> {
  const address = await deployShared(market.chain.id, deployDataV2(market), onStep, () =>
    deployContract(wagmiConfig, {
      abi: executorAbi,
      bytecode: EXECUTOR_BYTECODE_V2,
      args: [market.pool, executorRouters(market.chain.id).map((r) => r.router), executorLenders(market.chain.id)],
      chainId: market.chain.id,
    }),
  )
  onStep('Vérification du contrat déployé…')
  if ((await verifyExecutor(market, address)).version !== 2) throw new Error('le contrat déployé n’est pas la v2')
  return address
}

// ---------------------------------------------------------------------------------------------------------------------
// LeverageExecutorMorpho (one per chain, for every Morpho Blue market of that chain)
// ---------------------------------------------------------------------------------------------------------------------

const morphoArgs = (net: MorphoNet) => [net.morpho, executorRouters(net.chain.id).map((r) => r.router)] as const

/**
 * Same check as `verifyExecutor` for the Morpho executor: code equal to the constructor's output for this chain's
 * Morpho Blue and routers (so no owner, no admin function, the right Morpho), and every router registered.
 */
export async function verifyMorphoExecutor(net: MorphoNet, address: Address): Promise<true> {
  const client = getPublicClient(wagmiConfig, { chainId: net.chain.id })
  if (!client) throw new Error(`pas de connexion à ${net.chain.name}`)
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error(`aucun contrat à cette adresse sur ${net.chain.name}`)
  const data = morphoInitCode(net)
  const expected = await client.call({ data }).catch(() => undefined)
  if (!expected?.data || expected.data.toLowerCase() !== code.toLowerCase()) throw new Error('le code de ce contrat n’est pas celui d’Auto-loop pour Morpho')
  for (const r of executorRouters(net.chain.id)) {
    const ok = await client.readContract({ address, abi: morphoExecutorAbi, functionName: 'isRouterAllowed', args: [r.router] })
    if (!ok) throw new Error(`le routeur ${r.label} n’est pas autorisé dans ce contrat`)
  }
  return true
}

export function useMorphoExecutorCheck(net: MorphoNet) {
  return useQuery({
    queryKey: ['morpho-executor-check', net.id, net.executor],
    queryFn: () => verifyMorphoExecutor(net, net.executor!),
    enabled: !!net.executor,
    staleTime: Infinity,
    retry: 1,
  })
}

const morphoInitCode = (net: MorphoNet) => encodeDeployData({ abi: morphoExecutorAbi, bytecode: EXECUTOR_BYTECODE_MORPHO, args: morphoArgs(net) })

/** the network's shared Morpho executor address (CREATE2 through the deterministic proxy) */
export const sharedMorphoExecutorAddress = (net: MorphoNet) => create2Address(morphoInitCode(net))

export function useSharedMorphoExecutor(net: MorphoNet, enabled: boolean) {
  return useQuery({
    queryKey: ['shared-morpho-executor', net.id],
    queryFn: async () => {
      const a = sharedMorphoExecutorAddress(net)
      if (!(await hasCode(net.chain.id, a))) return null
      await verifyMorphoExecutor(net, a)
      return a
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

/** Deploys the network's shared Morpho executor from the connected wallet, waits for it, then verifies it on chain. */
export async function deployMorphoExecutor(net: MorphoNet, onStep: (s: string) => void): Promise<Address> {
  const address = await deployShared(net.chain.id, morphoInitCode(net), onStep, () =>
    deployContract(wagmiConfig, { abi: morphoExecutorAbi, bytecode: EXECUTOR_BYTECODE_MORPHO, args: morphoArgs(net), chainId: net.chain.id }),
  )
  onStep('Vérification du contrat déployé…')
  await verifyMorphoExecutor(net, address)
  return address
}
