import { encodeDeployData, getAddress, type Address } from 'viem'
import { deployContract, getPublicClient, waitForTransactionReceipt } from '@wagmi/core'
import { useQuery } from '@tanstack/react-query'
import { wagmiConfig } from '../wagmi'
import { executorAbi, executorAbiV1, morphoExecutorAbi } from '../abi'
import { EXECUTOR_BYTECODE_MORPHO, EXECUTOR_BYTECODE_V1, EXECUTOR_BYTECODE_V2 } from '../executorBytecode'
import { executorLenders, executorRouters, type Market, type MorphoNet } from '../config'

export type ExecutorVersion = 1 | 2
/** What the code check found: the contract version, and whether Pendle's router is whitelisted (PT loops). */
export type ExecutorCheck = { version: ExecutorVersion; pendle: boolean }

function deployDataV2(market: Market) {
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

/** Deploys a new (v2) executor from the connected wallet, waits for it, then verifies it on chain. */
export async function deployExecutor(market: Market, onStep: (s: string) => void): Promise<Address> {
  onStep('Signature du déploiement dans le portefeuille…')
  const hash = await deployContract(wagmiConfig, {
    abi: executorAbi,
    bytecode: EXECUTOR_BYTECODE_V2,
    args: [market.pool, executorRouters(market.chain.id).map((r) => r.router), executorLenders(market.chain.id)],
    chainId: market.chain.id,
  })
  onStep('Déploiement en cours, en attente de confirmation…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: market.chain.id })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('le déploiement a échoué')
  const address = getAddress(receipt.contractAddress)
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
  const data = encodeDeployData({ abi: morphoExecutorAbi, bytecode: EXECUTOR_BYTECODE_MORPHO, args: morphoArgs(net) })
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

/** Deploys the Morpho executor from the connected wallet, waits for it, then verifies it on chain. */
export async function deployMorphoExecutor(net: MorphoNet, onStep: (s: string) => void): Promise<Address> {
  onStep('Signature du déploiement dans le portefeuille…')
  const hash = await deployContract(wagmiConfig, { abi: morphoExecutorAbi, bytecode: EXECUTOR_BYTECODE_MORPHO, args: morphoArgs(net), chainId: net.chain.id })
  onStep('Déploiement en cours, en attente de confirmation…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: net.chain.id })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('le déploiement a échoué')
  const address = getAddress(receipt.contractAddress)
  onStep('Vérification du contrat déployé…')
  await verifyMorphoExecutor(net, address)
  return address
}
