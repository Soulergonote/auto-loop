/**
 * X5: what the wallet is about to sign, in French, decoded from the very bytes the app hands it (typed data, calldata,
 * a batch), never from a description kept beside them. Each recap has one sentence, the decoded fields and warnings:
 * a spender the app did not check, an unlimited amount, a long validity, a call it cannot read. Pure, tested.
 */
import { decodeFunctionData, getAddress, maxUint256, type Abi, type Address, type Hex } from 'viem'
import {
  debtTokenAbi,
  erc20Abi,
  executorAbi,
  executorAbiV1,
  morphoAbi,
  morphoExecutorAbi,
  poolAbi,
  v4ExecutorAbi,
  v4SpokeAbi,
  v4TakerAbi,
  wrappedNativeAbi,
  distributorAbi,
} from '../../chain/abi'
import { swapTerms } from '../quotes/swapCalldata'
import { fmtAddress, fmtAmount, fmtHf } from '../../ui/format'
import type { Name, Token } from './names'

export type RecapContext = {
  chainId: number
  /** the connected account: what the calls and signatures act for */
  user: Address
  nowSec: number
  name: (a: Address) => Name | undefined
  token: (a: Address) => Token | undefined
  v4Reserve: (spoke: Address, reserveId: bigint) => Token | undefined
  /** an Aave eMode category's label */
  eMode: (pool: Address, id: number) => string | undefined
}

export type RecapLine = { label: string; value: string }

export type Recap = {
  /** « Signature », « Transaction », « Lot de 5 opérations », « Déploiement » */
  kind: string
  title: string
  sentence: string
  lines: RecapLine[]
  warnings: string[]
  /** the bytes as sent, for whoever wants to compare them with the wallet's screen */
  raw: string
  /** a batch: one recap per call, in order */
  calls?: Recap[]
}

/** Validity above this is unusual for the app (it asks for 20 minutes). */
const LONG_VALIDITY_SEC = 3_600

// ---------------------------------------------------------------------------------------------------------------------
// Words for addresses, amounts and dates
// ---------------------------------------------------------------------------------------------------------------------

function who(ctx: RecapContext, a: Address): string {
  if (a.toLowerCase() === ctx.user.toLowerCase()) return `ton compte (${fmtAddress(a)})`
  const n = ctx.name(a)
  const t = ctx.token(a)
  return n ? `${n.label} (${fmtAddress(a)})` : t ? `${t.symbol} (${fmtAddress(a)})` : fmtAddress(a)
}

const symbolOf = (ctx: RecapContext, a: Address) => ctx.token(a)?.symbol ?? fmtAddress(a)

/** An amount of `token`, « tout » for the max, raw units when the token is unknown. */
function amountOf(amount: bigint, token: Token | undefined, max = 'tout'): string {
  if (amount === maxUint256) return max
  return token ? `${fmtAmount(amount, token.decimals)} ${token.symbol}` : `${amount} (unités brutes)`
}

function when(ctx: RecapContext, deadline: bigint): string {
  const sec = Number(deadline)
  if (!Number.isFinite(sec) || deadline >= maxUint256 / 2n) return 'sans limite'
  const t = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(sec * 1000))
  const left = Math.round((sec - ctx.nowSec) / 60)
  return left >= 0 ? `${t} (dans ${left} min)` : `${t} (déjà passé)`
}

/** The warnings shared by every allowance: unknown spender, unlimited amount, long validity, another owner. */
function allowanceWarnings(ctx: RecapContext, a: { spender: Address; amount?: bigint; deadline?: bigint; owner?: Address }): string[] {
  const w: string[] = []
  if (!ctx.name(a.spender)?.ours) w.push(`${fmtAddress(a.spender)} n’est pas un contrat Auto-loop vérifié par l’app : refuse si tu ne l’attendais pas.`)
  if (a.amount === maxUint256) w.push('Montant illimité : l’app ne demande jamais d’autorisation illimitée.')
  if (a.deadline !== undefined && Number(a.deadline) - ctx.nowSec > LONG_VALIDITY_SEC) w.push('Validité de plus d’une heure : l’app demande 20 minutes.')
  if (a.owner && a.owner.toLowerCase() !== ctx.user.toLowerCase()) w.push(`Signée pour ${fmtAddress(a.owner)}, pas pour ton compte.`)
  return w
}

const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

// ---------------------------------------------------------------------------------------------------------------------
// Signatures (EIP-712)
// ---------------------------------------------------------------------------------------------------------------------

export type TypedData = { domain?: { verifyingContract?: Address; name?: string }; primaryType: string; message: Record<string, unknown> }

/** A signature the app asks for: Aave credit delegation or aToken permit, Morpho authorization, Aave v4 Taker permit. */
export function describeTypedData(ctx: RecapContext, td: TypedData): Recap {
  const m = td.message
  const contract = td.domain?.verifyingContract
  const base = { kind: 'Signature', raw: json({ domain: td.domain, primaryType: td.primaryType, message: m }) }
  const addr = (k: string) => getAddress(m[k] as string)
  const big = (k: string) => m[k] as bigint

  if (td.primaryType === 'DelegationWithSig' && contract) {
    const spender = addr('delegatee')
    const t = ctx.token(contract)
    return {
      ...base,
      title: 'Délégation de crédit Aave',
      sentence: `Autorise ${who(ctx, spender)} à emprunter jusqu’à ${amountOf(big('value'), t, 'un montant illimité')} en ton nom, jusqu’à ${when(ctx, big('deadline'))}.`,
      lines: [
        { label: 'Bénéficiaire', value: who(ctx, spender) },
        { label: 'Montant', value: amountOf(big('value'), t, 'illimité') },
        { label: 'Jeton de dette', value: who(ctx, contract) },
        { label: 'Valable jusqu’à', value: when(ctx, big('deadline')) },
        { label: 'Nonce', value: String(big('nonce')) },
      ],
      warnings: allowanceWarnings(ctx, { spender, amount: big('value'), deadline: big('deadline') }),
    }
  }
  if (td.primaryType === 'Permit' && contract) {
    const spender = addr('spender')
    const t = ctx.token(contract)
    return {
      ...base,
      title: 'Autorisation sur des aTokens (permit)',
      sentence: `Autorise ${who(ctx, spender)} à prendre jusqu’à ${amountOf(big('value'), t, 'un montant illimité')} sur ton compte, jusqu’à ${when(ctx, big('deadline'))}.`,
      lines: [
        { label: 'Bénéficiaire', value: who(ctx, spender) },
        { label: 'Montant', value: amountOf(big('value'), t, 'illimité') },
        { label: 'Jeton', value: who(ctx, contract) },
        { label: 'Valable jusqu’à', value: when(ctx, big('deadline')) },
        { label: 'Nonce', value: String(big('nonce')) },
      ],
      warnings: allowanceWarnings(ctx, { spender, amount: big('value'), deadline: big('deadline'), owner: addr('owner') }),
    }
  }
  if (td.primaryType === 'Authorization') {
    const spender = addr('authorized')
    const on = m.isAuthorized === true
    return {
      ...base,
      title: on ? 'Autorisation Morpho' : 'Retrait de l’autorisation Morpho',
      sentence: on
        ? `Donne à ${who(ctx, spender)} le droit d’agir sur tes positions Morpho (nonce ${big('nonce')}), jusqu’à ${when(ctx, big('deadline'))}. Le contrat le retire lui-même à la fin de sa transaction.`
        : `Retire à ${who(ctx, spender)} le droit d’agir sur tes positions Morpho (nonce ${big('nonce')}) : consommé dans la même transaction que l’autorisation.`,
      lines: [
        { label: 'Contrat', value: who(ctx, spender) },
        { label: 'Droit', value: on ? 'accordé' : 'retiré' },
        { label: 'Valable jusqu’à', value: when(ctx, big('deadline')) },
        { label: 'Nonce', value: String(big('nonce')) },
      ],
      warnings: on ? allowanceWarnings(ctx, { spender, deadline: big('deadline'), owner: addr('authorizer') }) : [],
    }
  }
  if ((td.primaryType === 'BorrowPermit' || td.primaryType === 'WithdrawPermit') && contract) {
    const spender = addr('spender')
    const spoke = addr('spoke')
    const t = ctx.v4Reserve(spoke, big('reserveId'))
    const borrow = td.primaryType === 'BorrowPermit'
    return {
      ...base,
      title: borrow ? 'Autorisation d’emprunt Aave v4' : 'Autorisation de retrait Aave v4',
      sentence: `Autorise ${who(ctx, spender)} à ${borrow ? 'emprunter' : 'retirer'} jusqu’à ${amountOf(big('amount'), t, 'un montant illimité')} sur ${who(ctx, spoke)}, jusqu’à ${when(ctx, big('deadline'))}.`,
      lines: [
        { label: 'Bénéficiaire', value: who(ctx, spender) },
        { label: 'Montant', value: amountOf(big('amount'), t, 'illimité') },
        { label: 'Spoke', value: who(ctx, spoke) },
        { label: 'Réserve', value: t ? `${t.symbol} (n° ${big('reserveId')})` : `n° ${big('reserveId')}` },
        { label: 'Valable jusqu’à', value: when(ctx, big('deadline')) },
        { label: 'Nonce', value: String(big('nonce')) },
      ],
      warnings: allowanceWarnings(ctx, { spender, amount: big('amount'), deadline: big('deadline'), owner: addr('owner') }),
    }
  }
  return {
    ...base,
    title: `Signature « ${td.primaryType} »`,
    sentence: `Signature d’un message ${td.primaryType}${contract ? ` pour ${who(ctx, contract)}` : ''} que l’app ne sait pas lire.`,
    lines: [],
    warnings: ['Message non reconnu par l’app : vérifie chaque champ dans le portefeuille.'],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------------------------------

export type Call = { to: Address; data: Hex; value?: bigint }

type Step = { router: Address; tokenOut: Address; minOut: bigint }
type Guard = { minHealthFactor: bigint; deadline: bigint }
type MarketParams = { loanToken: Address; collateralToken: Address; lltv: bigint }

/** The ABIs of every call the app sends, tried in turn (a selector shared by two ABIs reads the same way). */
const ABIS: [string, Abi][] = [
  ['erc20', erc20Abi],
  ['debt', debtTokenAbi],
  ['pool', poolAbi],
  ['morpho', morphoAbi],
  ['wrap', wrappedNativeAbi],
  ['spoke', v4SpokeAbi],
  ['taker', v4TakerAbi],
  ['merkl', distributorAbi],
  ['v2', executorAbi],
  ['v1', executorAbiV1],
  ['morphoExecutor', morphoExecutorAbi],
  ['v4', v4ExecutorAbi],
]

function decode(data: Hex): { abi: string; functionName: string; args: readonly unknown[] } | undefined {
  for (const [abi, a] of ABIS)
    try {
      const d = decodeFunctionData({ abi: a, data })
      return { abi, functionName: d.functionName, args: d.args ?? [] }
    } catch {
      // next ABI
    }
  return undefined
}

const ACTIONS: Record<string, string> = {
  open: 'Ouvrir ou augmenter la boucle',
  close: 'Fermer ou réduire la boucle',
  swapCollateral: 'Changer de collatéral',
  swapDebt: 'Changer de dette',
  roll: 'Changer de marché Morpho',
  refinance: 'Refinancer : déplacer la position',
}

/** The swaps of a plan: router, token bought and the minimum the contract checks. */
const stepLines = (ctx: RecapContext, steps: readonly Step[], label = 'Swap'): RecapLine[] =>
  steps.map((s, i) => ({
    label: steps.length > 1 ? `${label} ${i + 1}` : label,
    value: `${ctx.name(s.router)?.label ?? fmtAddress(s.router)}, au moins ${amountOf(s.minOut, ctx.token(s.tokenOut))}`,
  }))

const guardLines = (ctx: RecapContext, g: Guard): RecapLine[] => [
  ...(g.minHealthFactor > 0n ? [{ label: 'Health factor final minimum', value: fmtHf(Number(g.minHealthFactor) / 1e18) }] : []),
  { label: 'Valable jusqu’à', value: when(ctx, g.deadline) },
]

const marketText = (ctx: RecapContext, m: MarketParams) =>
  `${symbolOf(ctx, m.collateralToken)} / ${symbolOf(ctx, m.loanToken)} (LLTV ${Number(m.lltv) / 1e16} %)`

/** The fields of an executor call, read by role (collateral, debt, capital…) whatever the contract. */
function executorLines(ctx: RecapContext, abi: string, fn: string, args: readonly unknown[]): RecapLine[] {
  const p = args[0] as Record<string, unknown>
  const action = fn.replace(/With(Sig|Auth)$/, '')
  const tok = (a: unknown) => (a ? ctx.token(a as Address) : undefined)
  const spoke = p.spoke as Address | undefined
  const v4 = (id: unknown) => (spoke !== undefined && id !== undefined ? ctx.v4Reserve(spoke, id as bigint) : undefined)
  const market = p.market as MarketParams | undefined
  const collateral = tok(p.collateralAsset) ?? tok(market?.collateralToken) ?? v4(p.collateralId)
  const debt = tok(p.debtAsset) ?? tok(market?.loanToken) ?? v4(p.debtId)
  const from = tok(p.fromAsset) ?? v4(p.fromId)
  const to = tok(p.toAsset) ?? v4(p.toId)
  const out: RecapLine[] = []
  const add = (label: string, value: string | undefined) => value !== undefined && out.push({ label, value })
  const amt = (k: string, t: Token | undefined) => (p[k] !== undefined ? amountOf(p[k] as bigint, t) : undefined)
  const swaps = (p.steps as Step[] | undefined) ?? (p.swap ? [{ ...(p.swap as Step), tokenOut: p.collateralAsset as Address }] : [])

  if (market) add('Marché Morpho', marketText(ctx, market))
  if (spoke) add('Spoke Aave v4', who(ctx, spoke))
  if (action === 'roll') {
    add('De', marketText(ctx, p.from as MarketParams))
    add('Vers', marketText(ctx, p.to as MarketParams))
  }
  if (action === 'refinance' && abi === 'morphoExecutor') {
    add('Sens', p.toMorpho ? `d’Aave (${who(ctx, p.pool as Address)}) vers Morpho` : `de Morpho vers Aave (${who(ctx, p.pool as Address)})`)
  }
  if (action === 'refinance' && abi === 'v4') {
    const place = (x: { target: Address; collateralId: bigint; debtId: bigint; market: MarketParams }) =>
      ctx.name(x.target)?.label.startsWith('Morpho') ? `Morpho, ${marketText(ctx, x.market)}` : who(ctx, x.target)
    add('De', place(p.from as never))
    add('Vers', place(p.to as never))
  }
  if (p.collateralAsset) add('Collatéral', symbolOf(ctx, p.collateralAsset as Address))
  if (p.debtAsset) add('Dette', symbolOf(ctx, p.debtAsset as Address))
  if (p.fromAsset || p.fromId !== undefined) add('De', from?.symbol ?? `réserve n° ${p.fromId}`)
  if (p.toAsset || p.toId !== undefined) add('Vers', to?.symbol ?? `réserve n° ${p.toId}`)
  if (p.capitalAmount !== undefined && (p.capitalAmount as bigint) > 0n) add('Capital versé', amountOf(p.capitalAmount as bigint, tok(p.capitalToken)))
  add('Collatéral versé', amt('initialCollateral', collateral))
  if (action === 'open') add('Emprunt', amt('debtAmount', debt))
  add('Dette remboursée', amt('repayAmount', debt))
  add('Collatéral retiré', amt('collateralToWithdraw', collateral))
  if (p.collateralToSell !== undefined) add('Collatéral vendu', amt('collateralToSell', collateral))
  add('Collatéral déplacé', amt('collateralToMove', tok((p.from as MarketParams | undefined)?.collateralToken)))
  add('Retiré de l’ancien collatéral', amt('fromAmount', from))
  add('Déposé en nouveau collatéral', amt('toAmount', to))
  add('Nouvelle dette empruntée', amt('newDebtAmount', to))
  add('Ancienne dette remboursée au moins', amt('minRepaid', from))
  if (action === 'refinance') {
    add('Dette déplacée', amountOf(p.debtAmount as bigint, debt))
    add('Collatéral déplacé', amountOf(p.collateralAmount as bigint, collateral))
  }
  if (p.flashLender) add('Prêteur du flash loan', who(ctx, p.flashLender as Address))
  out.push(...stepLines(ctx, (p.capitalSteps as Step[] | undefined) ?? [], 'Swap du capital'))
  out.push(...stepLines(ctx, swaps))
  if (p.guard) out.push(...guardLines(ctx, p.guard as Guard))
  if (fn.endsWith('WithSig')) add('Signature jointe', 'la délégation ou le permit signé juste avant')
  if (fn.endsWith('WithAuth')) add('Signatures jointes', 'l’autorisation Morpho et son retrait, signés juste avant')
  return out
}

/** One call: approval, account setting, Morpho authorization, Taker allowance, wrap, Merkl claim, a swap, an executor call. */
export function describeCall(ctx: RecapContext, call: Call): Recap {
  const raw = json({ to: call.to, value: call.value ?? 0n, data: call.data })
  const base = { kind: 'Transaction', raw }
  const target = who(ctx, call.to)
  const d = decode(call.data)
  const a = (i: number) => d!.args[i] as Address
  const n = (i: number) => d!.args[i] as bigint

  if (d?.functionName === 'approve' && d.abi === 'erc20') {
    const t = ctx.token(call.to)
    const reset = n(1) === 0n
    return {
      ...base,
      title: reset ? 'Remise à zéro d’une autorisation' : 'Autorisation de dépense',
      sentence: reset
        ? `Ramène à 0 l’autorisation de ${who(ctx, a(0))} sur ton ${symbolOf(ctx, call.to)}.`
        : `Autorise ${who(ctx, a(0))} à prendre jusqu’à ${amountOf(n(1), t, 'un montant illimité')} sur ton compte.`,
      lines: [
        { label: 'Bénéficiaire', value: who(ctx, a(0)) },
        { label: 'Montant', value: amountOf(n(1), t, 'illimité') },
        { label: 'Jeton', value: target },
      ],
      warnings: reset ? [] : allowanceWarnings(ctx, { spender: a(0), amount: n(1) }),
    }
  }
  if (d?.functionName === 'approveDelegation') {
    const t = ctx.token(call.to)
    return {
      ...base,
      title: 'Délégation de crédit Aave',
      sentence: `Autorise ${who(ctx, a(0))} à emprunter jusqu’à ${amountOf(n(1), t, 'un montant illimité')} en ton nom.`,
      lines: [
        { label: 'Bénéficiaire', value: who(ctx, a(0)) },
        { label: 'Montant', value: amountOf(n(1), t, 'illimité') },
        { label: 'Jeton de dette', value: target },
      ],
      warnings: n(1) === 0n ? [] : allowanceWarnings(ctx, { spender: a(0), amount: n(1) }),
    }
  }
  if (d?.functionName === 'setAuthorization') {
    const on = d.args[1] === true
    return {
      ...base,
      title: on ? 'Autorisation Morpho' : 'Retrait de l’autorisation Morpho',
      sentence: on
        ? `Donne à ${who(ctx, a(0))} le droit d’agir sur tes positions Morpho.`
        : `Retire à ${who(ctx, a(0))} le droit d’agir sur tes positions Morpho.`,
      lines: [
        { label: 'Contrat', value: who(ctx, a(0)) },
        { label: 'Sur', value: target },
      ],
      warnings: on ? allowanceWarnings(ctx, { spender: a(0) }) : [],
    }
  }
  if (d?.functionName === 'setUserEMode') {
    const id = Number(d.args[0])
    const category = ctx.eMode(call.to, id) ? `« ${ctx.eMode(call.to, id)} » (n° ${id})` : `n° ${id}`
    return {
      ...base,
      title: id === 0 ? 'Sortie de l’eMode' : 'Activation de l’eMode',
      sentence: id === 0 ? `Sort ton compte de l’eMode sur ${target}.` : `Passe ton compte dans la catégorie eMode ${category} sur ${target}.`,
      lines: [{ label: 'Catégorie', value: id === 0 ? 'aucune' : category }],
      warnings: [],
    }
  }
  if (d?.functionName === 'setUserPositionManager') {
    const on = d.args[1] === true
    return {
      ...base,
      title: on ? 'Gestionnaire de position Aave v4' : 'Retrait d’un gestionnaire de position',
      sentence: `${on ? 'Accepte' : 'Retire'} ${who(ctx, a(0))} comme gestionnaire de tes positions sur ${target}.`,
      lines: [{ label: 'Gestionnaire', value: who(ctx, a(0)) }],
      warnings: on && !ctx.name(a(0)) ? [`${fmtAddress(a(0))} n’est pas un gestionnaire Aave v4 connu de l’app.`] : [],
    }
  }
  if (d?.functionName === 'setUsingAsCollateral') {
    const t = ctx.v4Reserve(call.to, n(0))
    return {
      ...base,
      title: 'Réserve en collatéral',
      sentence: `${d.args[1] ? 'Utilise' : 'N’utilise plus'} ${t?.symbol ?? `la réserve n° ${n(0)}`} comme collatéral sur ${target}.`,
      lines: [{ label: 'Réserve', value: t ? `${t.symbol} (n° ${n(0)})` : `n° ${n(0)}` }],
      warnings: a(2).toLowerCase() !== ctx.user.toLowerCase() ? [`Pour le compte ${fmtAddress(a(2))}, pas le tien.`] : [],
    }
  }
  if (d?.functionName === 'multicall' && d.abi === 'spoke') {
    const inner = (d.args[0] as Hex[]).map((data) => describeCall(ctx, { to: call.to, data }))
    return {
      ...base,
      title: `Réglages du spoke (${inner.length} opérations)`,
      sentence: inner.map((r) => r.sentence).join(' '),
      lines: inner.flatMap((r) => r.lines),
      warnings: inner.flatMap((r) => r.warnings),
    }
  }
  if ((d?.functionName === 'approveBorrow' || d?.functionName === 'approveWithdraw') && d.abi === 'taker') {
    const t = ctx.v4Reserve(a(0), n(1))
    const borrow = d.functionName === 'approveBorrow'
    return {
      ...base,
      title: borrow ? 'Autorisation d’emprunt Aave v4' : 'Autorisation de retrait Aave v4',
      sentence: `Autorise ${who(ctx, a(2))} à ${borrow ? 'emprunter' : 'retirer'} jusqu’à ${amountOf(n(3), t, 'un montant illimité')} sur ${who(ctx, a(0))}.`,
      lines: [
        { label: 'Bénéficiaire', value: who(ctx, a(2)) },
        { label: 'Montant', value: amountOf(n(3), t, 'illimité') },
        { label: 'Réserve', value: t ? `${t.symbol} (n° ${n(1)})` : `n° ${n(1)}` },
      ],
      warnings: n(3) === 0n ? [] : allowanceWarnings(ctx, { spender: a(2), amount: n(3) }),
    }
  }
  if (d?.functionName === 'deposit' && d.abi === 'wrap') {
    const t = ctx.token(call.to)
    return {
      ...base,
      title: 'Conversion du token natif',
      sentence: `Convertit ${amountOf(call.value ?? 0n, t ? { ...t, symbol: 'natif' } : undefined)} en ${symbolOf(ctx, call.to)}.`,
      lines: [{ label: 'Envoyé', value: amountOf(call.value ?? 0n, t ? { ...t, symbol: '(token natif)' } : undefined) }],
      warnings: [],
    }
  }
  if (d?.functionName === 'claim' && d.abi === 'merkl') {
    const tokens = d.args[1] as Address[]
    const amounts = d.args[2] as bigint[]
    const users = d.args[0] as Address[]
    return {
      ...base,
      title: 'Réclamation des récompenses Merkl',
      sentence: `Réclame tes récompenses Merkl : ${tokens.map((t, i) => amountOf(amounts[i], ctx.token(t))).join(', ')} (montants cumulés depuis le début).`,
      lines: tokens.map((t, i) => ({ label: symbolOf(ctx, t), value: amountOf(amounts[i], ctx.token(t)) })),
      warnings: users.some((u) => u.toLowerCase() !== ctx.user.toLowerCase()) ? ['Réclame aussi pour une autre adresse que la tienne.'] : [],
    }
  }
  const action = d && ['v2', 'v1', 'morphoExecutor', 'v4'].includes(d.abi) ? d.functionName.replace(/With(Sig|Auth)$/, '') : undefined
  if (d && action && ACTIONS[action]) {
    const lines = executorLines(ctx, d.abi, d.functionName, d.args)
    const main = lines.filter((l) => !/^(Swap|Valable|Signature|Health|Nonce|Prêteur)/.test(l.label)).slice(0, 4)
    return {
      ...base,
      title: ACTIONS[action],
      sentence: `Appelle ${target} : ${main.map((l) => `${l.label.toLowerCase()} ${l.value}`).join(', ')}.`,
      lines,
      warnings: ctx.name(call.to)?.ours ? [] : [`${fmtAddress(call.to)} n’est pas un contrat Auto-loop vérifié par l’app : refuse si tu ne l’attendais pas.`],
    }
  }
  // a swap from the wallet (reinvest): the aggregator's own calldata
  for (const agg of ctx.name(call.to)?.label.startsWith('routeur') ? ['velora', 'kyber', 'oneinch'] : []) {
    const s = swapTerms(agg, call.data, ctx.user)
    if (s)
      return {
        ...base,
        title: 'Échange',
        sentence: `Échange ${amountOf(s.amount, ctx.token(s.sell))} contre au moins ${amountOf(s.minOut, ctx.token(s.buy))} via ${target}.`,
        lines: [
          { label: 'Vendu', value: amountOf(s.amount, ctx.token(s.sell)) },
          { label: 'Reçu au moins', value: amountOf(s.minOut, ctx.token(s.buy)) },
          { label: 'Payé à', value: who(ctx, s.recipient) },
        ],
        warnings: s.recipient.toLowerCase() !== ctx.user.toLowerCase() ? ['Le swap paie une autre adresse que ton compte.'] : [],
      }
  }
  return {
    ...base,
    title: d ? `Appel ${d.functionName}` : 'Appel non reconnu',
    sentence: `${d ? `Appelle ${d.functionName}` : 'Envoie un appel que l’app ne sait pas lire'} sur ${target}${call.value ? ` avec ${call.value} wei` : ''}.`,
    lines: d ? d.args.map((x, i) => ({ label: `Argument ${i + 1}`, value: json(x) })) : [],
    warnings: d ? [] : ['Appel non reconnu par l’app : vérifie-le dans le portefeuille.'],
  }
}

/** An atomic batch: every call decoded, in order. */
export function describeBatch(ctx: RecapContext, calls: Call[]): Recap {
  const parts = calls.map((c) => describeCall(ctx, c))
  return {
    kind: `Lot de ${calls.length} opération${calls.length > 1 ? 's' : ''}`,
    title: 'Lot atomique : tout passe ou rien ne passe',
    sentence: parts.map((p, i) => `${i + 1}. ${p.title}`).join(' · '),
    lines: [],
    warnings: parts.flatMap((p) => p.warnings),
    raw: json(calls),
    calls: parts,
  }
}

/** Every address a recap may name or read as a token: what the wallet gateway resolves before describing. */
export function addressesIn(x: unknown, out = new Set<Address>()): Set<Address> {
  if (typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x)) out.add(getAddress(x))
  else if (Array.isArray(x)) x.forEach((y) => addressesIn(y, out))
  else if (x && typeof x === 'object') Object.values(x).forEach((y) => addressesIn(y, out))
  return out
}

/** The arguments of a call, for `addressesIn`. */
export const callArgs = (data: Hex): readonly unknown[] => decode(data)?.args ?? []

/** The eMode category a call sets, if it is a `setUserEMode`: the gateway reads its label first. */
export function eModeSet(call: Call): number | undefined {
  const d = decode(call.data)
  return d?.functionName === 'setUserEMode' && d.abi === 'pool' && Number(d.args[0]) > 0 ? Number(d.args[0]) : undefined
}
