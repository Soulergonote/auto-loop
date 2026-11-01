import { encodeDeployData, getAddress, type Address } from 'viem'
import { deployContract, getPublicClient, waitForTransactionReceipt } from '@wagmi/core'
import { useQuery } from '@tanstack/react-query'
import { wagmiConfig } from '../wagmi'
import { executorAbi } from '../abi'
import { EXECUTOR_BYTECODE } from '../executorBytecode'
import { executorRouters, type Market } from '../config'

function deployArgs(market: Market) {
  return [market.pool, executorRouters(market.chain.id).map((r) => r.router)] as const
}

/**
 * Checks that `address` runs exactly the audited-in-tests LeverageExecutor for this market: its code must equal what
 * the constructor produces for this Aave pool (dry-run of the deployment, same compiler output as the tests), and
 * every router of the market must be allowed. Code equality also proves there is no owner or admin function.
 */
export async function verifyExecutor(market: Market, address: Address): Promise<void> {
  const client = getPublicClient(wagmiConfig, { chainId: market.chain.id })
  if (!client) throw new Error(`pas de connexion à ${market.chain.name}`)
  const [code, expected] = await Promise.all([
    client.getCode({ address }),
    client.call({ data: encodeDeployData({ abi: executorAbi, bytecode: EXECUTOR_BYTECODE, args: deployArgs(market) }) }),
  ])
  if (!code || code === '0x') throw new Error(`aucun contrat à cette adresse sur ${market.chain.name}`)
  if (!expected.data) throw new Error('impossible de recalculer le code attendu')
  if (code.toLowerCase() !== expected.data.toLowerCase())
    throw new Error('le code de ce contrat n’est pas celui d’Auto-loop pour ce marché')
  for (const r of executorRouters(market.chain.id)) {
    const ok = await client.readContract({ address, abi: executorAbi, functionName: 'isRouterAllowed', args: [r.router] })
    if (!ok) throw new Error(`le routeur ${r.label} n’est pas autorisé dans ce contrat`)
  }
}

export function useExecutorCheck(market: Market) {
  return useQuery({
    queryKey: ['executor-check', market.id, market.executor],
    queryFn: () => verifyExecutor(market, market.executor!).then(() => true),
    enabled: !!market.executor,
    staleTime: Infinity,
    retry: 1,
  })
}

/** Deploys a new executor from the connected wallet, waits for it, then verifies it on chain. */
export async function deployExecutor(market: Market, onStep: (s: string) => void): Promise<Address> {
  onStep('Signature du déploiement dans le portefeuille…')
  const hash = await deployContract(wagmiConfig, {
    abi: executorAbi,
    bytecode: EXECUTOR_BYTECODE,
    args: deployArgs(market),
    chainId: market.chain.id,
  })
  onStep('Déploiement en cours, en attente de confirmation…')
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: market.chain.id })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('le déploiement a échoué')
  const address = getAddress(receipt.contractAddress)
  onStep('Vérification du contrat déployé…')
  await verifyExecutor(market, address)
  return address
}
