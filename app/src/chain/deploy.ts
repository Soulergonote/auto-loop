import { encodeDeployData, getAddress, parseAbi, type Address, type Chain, type Hex } from 'viem'
import { CREATE2_PROXY, create2Address } from './create2'
import { getPublicClient, waitForTransactionReceipt } from '@wagmi/core'
import { walletDeploy } from './wallet'
import { rememberName } from '../services/recap/names'
import { useQuery } from '@tanstack/react-query'
import { wagmiConfig } from './wagmi'
import { executorAbi, executorAbiV1, morphoExecutorAbi, v4ExecutorAbi } from './abi'
import { EXECUTOR_BYTECODE_AAVE_V4, EXECUTOR_BYTECODE_MORPHO, EXECUTOR_BYTECODE_V1, EXECUTOR_BYTECODE_V2 } from '../generated/executorBytecode'
import { EXECUTOR_BYTECODE_MORPHO_0, EXECUTOR_BYTECODE_MORPHO_1, EXECUTOR_BYTECODE_V2_0, EXECUTOR_BYTECODE_V2_1 } from '../generated/executorBytecodeLegacy'
import {
  AGGREGATORS,
  MARKETS,
  SHARED_BEFORE,
  executorLenders,
  executorRouters,
  marketPlace,
  type AggregatorId,
  type Market,
  type MorphoNet,
  type V4Net,
} from '../config'

/** The chain's client and the code at `address`, refused when there is none. */
async function codeAt(chain: Chain, address: Address) {
  const client = getPublicClient(wagmiConfig, { chainId: chain.id })
  if (!client) throw new Error(`pas de connexion à ${chain.name}`)
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error(`aucun contrat à cette adresse sur ${chain.name}`)
  /** whether the code equals what this deployment produces (dry-run of the constructor) */
  const isBuild = async (initCode: Hex) => {
    const expected = await client.call({ data: initCode }).catch(() => undefined)
    return !!expected?.data && expected.data.toLowerCase() === code.toLowerCase()
  }
  return { client, isBuild }
}

/** Every router of the chain must be registered in the contract, except an optional aggregator (added later). */
async function requireRouters(client: Awaited<ReturnType<typeof codeAt>>['client'], chainId: number, address: Address) {
  for (const r of executorRouters(chainId)) {
    const ok = await client.readContract({ address, abi: morphoExecutorAbi, functionName: 'isRouterAllowed', args: [r.router] })
    if (!ok && (r.id === 'pendle' || !AGGREGATORS[r.id].optional)) throw new Error(`le routeur ${r.label} n’est pas autorisé dans ce contrat`)
  }
}

type Declared = { id: string; chain: Chain; executor?: Address }

/** The on-chain check of the declared executor, once per address. */
function useCheck<N extends Declared, R>(key: string, net: N, verify: (net: N, address: Address) => Promise<R>) {
  return useQuery({
    queryKey: [key, net.id, net.executor],
    queryFn: () => verify(net, net.executor!),
    enabled: !!net.executor,
    staleTime: Infinity,
    retry: 1,
  })
}

/**
 * The shared (CREATE2) executor when someone already deployed it and `accept` passes, else null: the current address
 * first, then those of the earlier router lists (SHARED_BEFORE).
 */
function useShared<N extends Declared>(
  key: string,
  net: N,
  addresses: (net: N) => Address[],
  accept: (net: N, a: Address) => Promise<boolean>,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [key, net.id],
    queryFn: async () => {
      for (const a of addresses(net)) if ((await hasCode(net.chain.id, a)) && (await accept(net, a))) return a
      return null
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

export type ExecutorVersion = 1 | 2
/**
 * What the code check found: the contract version, whether Pendle's router is whitelisted (PT loops), and whether
 * the contract can change the debt asset (`swapDebt`, v2 deployed from 2026-11-13).
 */
export type ExecutorCheck = { version: ExecutorVersion; pendle: boolean; debtSwap: boolean }

export function deployDataV2(market: Market, without: AggregatorId[] = []) {
  const routers = executorRouters(market.chain.id, without).map((r) => r.router)
  return encodeDeployData({ abi: executorAbi, bytecode: EXECUTOR_BYTECODE_V2, args: [market.pool, routers, executorLenders(market.chain.id)] })
}

function deployDataV1(market: Market) {
  const routers = executorRouters(market.chain.id).map((r) => r.router)
  return encodeDeployData({ abi: executorAbiV1, bytecode: EXECUTOR_BYTECODE_V1, args: [market.pool, routers] })
}

/**
 * Earlier v2 builds (same constructor): before `swapDebt` (V2_0), and before open learned to borrow in the callback on a
 * pool without flash premium (V2_1, which SparkLend refuses but every Aave market accepts).
 */
function deployDataV2Legacy(market: Market, bytecode: string): Hex {
  const routers = executorRouters(market.chain.id).map((r) => r.router)
  return encodeDeployData({ abi: executorAbi, bytecode: bytecode as Hex, args: [market.pool, routers, executorLenders(market.chain.id)] })
}

/**
 * Checks that `address` runs exactly the audited-in-tests LeverageExecutor for this market, and says which version:
 * its code must equal what the constructor produces for this Aave pool (dry-run of the deployment, same compiler
 * output as the tests), and every aggregator router (and, for v2, the Morpho lender) of the market must be registered,
 * except an optional one (1inch, added later): an older executor lacks it and is just never quoted through it.
 * Code equality also proves there is no owner or admin function. A v1 executor (deployed before v2) is still accepted:
 * positions live in the user's Aave account, so either version manages them. Pendle's router is checked on its own:
 * an executor deployed before PT loops lacks it and stays usable for every other pair.
 */
export async function verifyExecutor(market: Market, address: Address): Promise<ExecutorCheck> {
  const { client, isBuild } = await codeAt(market.chain, address)
  let version: ExecutorVersion | undefined
  let debtSwap = false
  for (const [v, data, swaps] of [
    [2, deployDataV2(market), true],
    // a fork (SparkLend) refuses the earlier builds' flash loan into debt: only the current v2 opens there
    ...(market.fork
      ? []
      : ([
          [2, deployDataV2Legacy(market, EXECUTOR_BYTECODE_V2_1), true],
          [2, deployDataV2Legacy(market, EXECUTOR_BYTECODE_V2_0), false],
        ] as const)),
    ...(market.fork ? [] : ([[1, deployDataV1(market), false]] as const)),
  ] as const) {
    if (await isBuild(data)) {
      version = v
      debtSwap = swaps
      break
    }
  }
  if (!version) throw new Error('le code de ce contrat n’est pas celui d’Auto-loop pour ce marché')
  const abi = version === 2 ? executorAbi : executorAbiV1
  let pendle = false
  for (const r of executorRouters(market.chain.id)) {
    const ok = await client.readContract({ address, abi, functionName: 'isRouterAllowed', args: [r.router] })
    if (r.id === 'pendle') pendle = ok && version === 2
    else if (!ok && !AGGREGATORS[r.id].optional) throw new Error(`le routeur ${r.label} n’est pas autorisé dans ce contrat`)
  }
  if (version === 2)
    for (const l of executorLenders(market.chain.id)) {
      const kind = await client.readContract({ address, abi: executorAbi, functionName: 'flashLenderKind', args: [l.lender] })
      if (kind !== l.kind) throw new Error('le prêteur Morpho n’est pas enregistré dans ce contrat')
    }
  rememberName(market.chain.id, address, { label: `contrat Auto-loop ${version === 2 ? 'V2' : 'v1'} · ${marketPlace(market)}`, ours: true })
  return { version, pendle, debtSwap }
}

export const useExecutorCheck = (market: Market) => useCheck('executor-check', market, verifyExecutor)

/** the market's shared v2 executor address (CREATE2 through the deterministic proxy) */
export const sharedExecutorAddress = (market: Market) => create2Address(deployDataV2(market))

/** Current shared address, then those of the earlier router lists (same code), without duplicates. */
const sharedAddresses = (initCode: (without: AggregatorId[]) => Hex): Address[] => [...new Set([[], ...SHARED_BEFORE].map((w) => create2Address(initCode(w))))]

/** every address the market's shared v2 executor may sit at */
export const sharedExecutorAddresses = (market: Market) => sharedAddresses((w) => deployDataV2(market, w))

const hasCode = async (chainId: number, address: Address) => {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error('pas de connexion au réseau')
  const code = await client.getCode({ address })
  return !!code && code !== '0x'
}

/** the market's shared executor when someone already deployed it (and it passes the code check) */
export const useSharedExecutor = (market: Market, enabled: boolean) =>
  useShared('shared-executor', market, sharedExecutorAddresses, async (m, a) => (await verifyExecutor(m, a)).version === 2, enabled)

/**
 * Deploys `initCode` from the connected wallet at its shared address through the deterministic proxy; a chain without
 * the proxy gets a plain deployment. Returns the address once the receipt is in (an address someone filled in the
 * meantime is returned as is).
 */
async function deployShared(chainId: number, contract: string, initCode: Hex, onStep: (s: string) => void): Promise<Address> {
  const target = create2Address(initCode)
  if (await hasCode(chainId, target)) return target
  const viaProxy = await hasCode(chainId, CREATE2_PROXY)
  onStep('Signature du déploiement dans le portefeuille…')
  const hash = await walletDeploy({ chainId, contract, initCode, viaProxy })
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
  const address = await deployShared(market.chain.id, `Auto-loop V2 (${market.label})`, deployDataV2(market), onStep)
  onStep('Vérification du contrat déployé…')
  if ((await verifyExecutor(market, address)).version !== 2) throw new Error('le contrat déployé n’est pas la v2')
  return address
}

// ---------------------------------------------------------------------------------------------------------------------
// LeverageExecutorMorpho (one per chain, for every Morpho Blue market of that chain)
// ---------------------------------------------------------------------------------------------------------------------

/** Aave pools of the chain a Morpho position can be refinanced from or to (fixed in the contract at deployment). */
export const morphoAavePools = (chainId: number): Address[] => [...new Set(MARKETS.filter((m) => m.chain.id === chainId && !m.soon).map((m) => m.pool))]

const morphoArgs = (net: MorphoNet, without: AggregatorId[] = []) =>
  [net.morpho, executorRouters(net.chain.id, without).map((r) => r.router), morphoAavePools(net.chain.id)] as const

/** The Morpho executor as deployed before `refinance` (no Aave pools): still recognised for everything else. */
const morphoInitCodeLegacy = (net: MorphoNet) =>
  encodeDeployData({
    abi: parseAbi(['constructor(address morpho, address[] routers)']),
    bytecode: EXECUTOR_BYTECODE_MORPHO_0 as Hex,
    args: [net.morpho, executorRouters(net.chain.id).map((r) => r.router)],
  })

/** What the code check found: whether the contract can refinance between Aave and Morpho (deployed from 2026-11-13). */
export type MorphoExecutorCheck = { refinance: boolean }

/**
 * Same check as `verifyExecutor` for the Morpho executor: code equal to the constructor's output for this chain's
 * Morpho Blue, routers and Aave pools (so no owner, no admin function, the right Morpho), and every router registered.
 */
export async function verifyMorphoExecutor(net: MorphoNet, address: Address): Promise<MorphoExecutorCheck> {
  const { client, isBuild } = await codeAt(net.chain, address)
  const refinance =
    (await isBuild(morphoInitCode(net))) || (await isBuild(morphoInitCodeR1(net))) ? true : (await isBuild(morphoInitCodeLegacy(net))) ? false : undefined
  if (refinance === undefined) throw new Error('le code de ce contrat n’est pas celui d’Auto-loop pour Morpho')
  await requireRouters(client, net.chain.id, address)
  rememberName(net.chain.id, address, { label: `contrat Auto-loop Morpho · ${net.label}`, ours: true })
  return { refinance }
}

export const useMorphoExecutorCheck = (net: MorphoNet) => useCheck('morpho-executor-check', net, verifyMorphoExecutor)

const morphoInitCode = (net: MorphoNet, without: AggregatorId[] = []) =>
  encodeDeployData({ abi: morphoExecutorAbi, bytecode: EXECUTOR_BYTECODE_MORPHO, args: morphoArgs(net, without) })

/** The Morpho executor with refinance as deployed before the internal audit R1 fix (2026-11-25): still fully usable. */
const morphoInitCodeR1 = (net: MorphoNet) => encodeDeployData({ abi: morphoExecutorAbi, bytecode: EXECUTOR_BYTECODE_MORPHO_1 as Hex, args: morphoArgs(net) })

/** the network's shared Morpho executor address (CREATE2 through the deterministic proxy) */
export const sharedMorphoExecutorAddress = (net: MorphoNet) => create2Address(morphoInitCode(net))

/** every address the network's shared Morpho executor may sit at */
export const sharedMorphoExecutorAddresses = (net: MorphoNet) => sharedAddresses((w) => morphoInitCode(net, w))

export const useSharedMorphoExecutor = (net: MorphoNet, enabled: boolean) =>
  useShared('shared-morpho-executor', net, sharedMorphoExecutorAddresses, async (n, a) => !!(await verifyMorphoExecutor(n, a)), enabled)

/** Deploys the network's shared Morpho executor from the connected wallet, waits for it, then verifies it on chain. */
export async function deployMorphoExecutor(net: MorphoNet, onStep: (s: string) => void): Promise<Address> {
  const address = await deployShared(net.chain.id, `Auto-loop Morpho (${net.label})`, morphoInitCode(net), onStep)
  onStep('Vérification du contrat déployé…')
  await verifyMorphoExecutor(net, address)
  return address
}

// ---------------------------------------------------------------------------------------------------------------------
// LeverageExecutorV4 (one per set of Aave v4 position managers, for every spoke they serve)
// ---------------------------------------------------------------------------------------------------------------------

const v4Args = (net: V4Net, without: AggregatorId[] = []) =>
  [net.morpho, net.giver, net.taker, executorRouters(net.chain.id, without).map((r) => r.router), morphoAavePools(net.chain.id)] as const
export const v4InitCode = (net: V4Net, without: AggregatorId[] = []) =>
  encodeDeployData({ abi: v4ExecutorAbi, bytecode: EXECUTOR_BYTECODE_AAVE_V4, args: v4Args(net, without) })

/**
 * Same check as `verifyExecutor` for the v4 executor: code equal to the constructor's output for this entry's Morpho,
 * Giver, Taker and routers (so no owner, no admin function, the right position managers), and every router registered.
 */
export async function verifyV4Executor(net: V4Net, address: Address): Promise<true> {
  const { client, isBuild } = await codeAt(net.chain, address)
  if (!(await isBuild(v4InitCode(net)))) throw new Error('le code de ce contrat n’est pas celui d’Auto-loop pour Aave v4')
  await requireRouters(client, net.chain.id, address)
  rememberName(net.chain.id, address, { label: `contrat Auto-loop V4 · ${net.label}`, ours: true })
  return true
}

export const useV4ExecutorCheck = (net: V4Net) => useCheck('v4-executor-check', net, verifyV4Executor)

/** the shared v4 executor address of this set of position managers (CREATE2 through the deterministic proxy) */
export const sharedV4ExecutorAddress = (net: V4Net) => create2Address(v4InitCode(net))

/** every address the shared v4 executor may sit at */
export const sharedV4ExecutorAddresses = (net: V4Net) => sharedAddresses((w) => v4InitCode(net, w))

export const useSharedV4Executor = (net: V4Net, enabled: boolean) => useShared('shared-v4-executor', net, sharedV4ExecutorAddresses, verifyV4Executor, enabled)

/** Deploys the shared v4 executor from the connected wallet, waits for it, then verifies it on chain. */
export async function deployV4Executor(net: V4Net, onStep: (s: string) => void): Promise<Address> {
  const address = await deployShared(net.chain.id, `Auto-loop V4 (${net.label})`, v4InitCode(net), onStep)
  onStep('Vérification du contrat déployé…')
  await verifyV4Executor(net, address)
  return address
}
