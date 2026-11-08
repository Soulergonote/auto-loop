import { encodeDeployData, getAddress, type Address } from 'viem'
import { deployContract, getPublicClient, waitForTransactionReceipt } from '@wagmi/core'
import { useQuery } from '@tanstack/react-query'
import { wagmiConfig } from '../wagmi'
import { executorAbi, executorAbiV1 } from '../abi'
import { EXECUTOR_BYTECODE_V1, EXECUTOR_BYTECODE_V2 } from '../executorBytecode'
import { executorLenders, executorRouters, type Market } from '../config'

export type ExecutorVersion = 1 | 2

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
 * output as the tests), and every router (and, for v2, the Morpho lender) of the market must be registered. Code
 * equality also proves there is no owner or admin function. A v1 executor (deployed before v2) is still accepted:
 * positions live in the user's Aave account, so either version manages them.
 */
export async function verifyExecutor(market: Market, address: Address): Promise<ExecutorVersion> {
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
  for (const r of executorRouters(market.chain.id)) {
    const ok = await client.readContract({ address, abi, functionName: 'isRouterAllowed', args: [r.router] })
    if (!ok) throw new Error(`le routeur ${r.label} n’est pas autorisé dans ce contrat`)
  }
  if (version === 2)
    for (const l of executorLenders(market.chain.id)) {
      const kind = await client.readContract({ address, abi: executorAbi, functionName: 'flashLenderKind', args: [l.lender] })
      if (kind !== l.kind) throw new Error('le prêteur Morpho n’est pas enregistré dans ce contrat')
    }
  return version
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
  if ((await verifyExecutor(market, address)) !== 2) throw new Error('le contrat déployé n’est pas la v2')
  return address
}
