import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Address, Hash } from 'viem'
import type { Market } from '../../../config'
import { readV4Outcome, v4OutcomeLines } from '../../../protocols/aavev4/execute'
import { encodeV4Refinance, executeV4Refinance, type V4Place, type V4RefinancePlan } from '../../../protocols/aavev4/refinance'
import { readV4State, v4BorrowApy, v4PairKey, type V4Pair, type V4State } from '../../../protocols/aavev4/state'
import { v4SamePairs } from '../../../protocols/aavev4/switch'
import { withInterestMargin } from '../../../protocols/morpho/execute'
import { morphoHf, morphoMarketsQuery, readMorphoState, type MorphoMarket, type MorphoState } from '../../../protocols/morpho/markets'
import {
  aaveAccountAfter,
  aaveBorrowNet,
  aaveBorrowRoomBase,
  aavePair,
  aaveSupplyNet,
  aaveSupplyRoomBase,
  readAaveSide,
  type AavePair,
  type AaveSide,
} from '../../../protocols/morpho/refinance'
import { snapshotQuery, type Snapshot } from '../../../protocols/aave/snapshot'
import { headlineRewards, merklQuery } from '../../../services/merkl'
import { toBase } from '../../../domain/math'
import { isCorrelated } from '../../../domain/pairs'
import { fmtAmount, fmtDollars, fmtHf, fmtLltv, fmtPct } from '../../../ui/format'
import { apyTone, hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LoopLayout, Metric, Notice, Summary, TxResult } from '../../../ui/primitives'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { StepsFold } from '../shared/folds'
import { aaveMarketsOn } from '../morpho/MorphoRefinancePanel'
import { v4SetupOf, v4SetupSteps } from './setup'
import type { V4Ctx } from './V4View'

/** The other end of a move: another spoke, an Aave v3 pool or a Morpho market. */
type Other =
  | { kind: 'v4'; pair: V4Pair; state: V4State; canLand: boolean }
  | { kind: 'aave'; pool: Market; snapshot: Snapshot; side: AaveSide; pair: AavePair & { switchTo?: number } }
  | { kind: 'morpho'; market: MorphoMarket; state: MorphoState }
type Route = { other: Other; out: boolean }

/** Morpho markets of the pair read on chain, the deepest first. */
const MORPHO_CANDIDATES = 4

const otherKey = (o: Other) => (o.kind === 'v4' ? `v4-${v4PairKey(o.pair)}` : o.kind === 'aave' ? `aave-${o.pool.id}` : `morpho-${o.market.id}`)
const otherName = (o: Other) =>
  o.kind === 'v4'
    ? `spoke ${o.pair.collateral.spoke.name}`
    : o.kind === 'aave'
      ? `Aave ${o.pool.label}`
      : `Morpho ${fmtLltv(o.market.lltv)} (${fmtDollars(o.market.liquidityUsd, true)} à prêter)`

/** What the other end holds of the pair: collateral and debt. */
function holdings(o: Other): { coll: bigint; debt: bigint } {
  if (o.kind === 'v4') return { coll: o.state.user?.collateral ?? 0n, debt: o.state.user?.debt ?? 0n }
  if (o.kind === 'aave') return { coll: o.side.supplied, debt: o.side.borrowed }
  return { coll: o.state.user?.collateral ?? 0n, debt: o.state.user?.debt ?? 0n }
}

/** « Refinancer »: the position moves, without a swap, between this spoke and another spoke, Aave v3 or Morpho. */
export function V4RefinancePanel({ ctx }: { ctx: V4Ctx }) {
  const { net, pair, state, sides, account } = ctx
  const C = pair.collateral
  const D = pair.debt
  const executor = net.executor
  const chainId = net.chain.id
  const user = state.user
  const { busy, setBusy, result, setResult, run } = useTxAction<{ ok: boolean; text: string; hash?: Hash; details?: string[]; land?: Other }>()
  const [choice, setChoice] = useState<string>()

  // the same pair on the other spokes of these position managers
  const samePairs = useMemo(() => v4SamePairs(ctx.reserves, pair), [ctx.reserves, pair])
  const v4States = useQueries({
    queries: samePairs.map((p) => ({
      queryKey: ['v4-state', net.id, v4PairKey(p), account, executor],
      queryFn: () => readV4State(net, p, account, executor),
      enabled: !!account,
      refetchInterval: 30_000,
    })),
  })
  // Aave v3 pools of the network that list the pair
  const pools = useMemo(() => aaveMarketsOn(chainId), [chainId])
  const snapshots = useQueries({ queries: pools.map((p) => snapshotQuery(p)) })
  const campaigns = useQuery(merklQuery(chainId))
  const aaveSides = useQueries({
    queries: pools.map((p, i) => {
      const snap = snapshots[i].data
      const any = snap && aavePair(snap, C.token.address, D.token.address, 0, true)
      return {
        queryKey: ['refinance-aave', p.id, account, executor, C.token.address, D.token.address],
        queryFn: () => readAaveSide(chainId, p.pool, any!, account!, executor),
        enabled: !!any && !!account,
        refetchInterval: 30_000,
      }
    }),
  })
  // Morpho markets of the pair
  const morphoList = useQuery(morphoMarketsQuery(chainId))
  const markets = useMemo(
    () =>
      (morphoList.data ?? [])
        .filter(
          (m) =>
            m.collateral.address.toLowerCase() === C.token.address.toLowerCase() &&
            m.loan.address.toLowerCase() === D.token.address.toLowerCase() &&
            m.warnings.every((w) => w.level !== 'RED'),
        )
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
        .slice(0, MORPHO_CANDIDATES),
    [morphoList.data, C.token.address, D.token.address],
  )
  const morphoStates = useQueries({
    queries: markets.map((m) => ({
      queryKey: ['morpho-state', chainId, m.id, account, executor],
      queryFn: () => readMorphoState(chainId, net.morpho, m, account, executor),
      enabled: !!account,
      refetchInterval: 30_000,
    })),
  })

  const here = { coll: user?.collateral ?? 0n, debt: user?.debt ?? 0n }
  const routes = useMemo(() => {
    const others: Other[] = []
    samePairs.forEach((p, i) => {
      const s = v4States[i].data
      if (s) others.push({ kind: 'v4', pair: p, state: s, canLand: p.canLand })
    })
    pools.forEach((pool, i) => {
      const snapshot = snapshots[i].data
      const side = aaveSides[i].data
      if (!snapshot || !side) return
      const empty = side.account.collateralBase === 0n && side.account.debtBase === 0n
      const ap = aavePair(snapshot, C.token.address, D.token.address, side.eModeCategory, empty)
      if (!ap) return
      const rw = (r: typeof ap.collateral) => ({
        ...r,
        ...((h) => ({ supplyRewardApr: h.supply, borrowRewardApr: h.borrow }))(headlineRewards(campaigns.data, r)),
      })
      others.push({ kind: 'aave', pool, snapshot, side, pair: { ...ap, collateral: rw(ap.collateral), debt: rw(ap.debt) } })
    })
    markets.forEach((market, i) => {
      const s = morphoStates[i].data
      if (s) others.push({ kind: 'morpho', market, state: s })
    })
    const out: Route[] = []
    const mine = here.coll > 0n && here.debt > 0n
    for (const o of others) {
      const h = holdings(o)
      if (h.coll > 0n && h.debt > 0n) out.push({ other: o, out: false })
      if (mine && (o.kind !== 'v4' || o.canLand)) out.push({ other: o, out: true })
    }
    return out
  }, [samePairs, v4States, pools, snapshots, aaveSides, markets, morphoStates, campaigns.data, here.coll, here.debt, C.token.address, D.token.address])
  const key = (r: Route) => `${otherKey(r.other)}-${r.out ? 'out' : 'in'}`
  const r = routes.find((x) => key(x) === choice) ?? routes[0]
  const loading =
    !!account &&
    (v4States.some((s) => s.isPending) ||
      snapshots.some((s) => s.isPending) ||
      aaveSides.some((s) => s.isPending && s.fetchStatus !== 'idle') ||
      morphoList.isPending ||
      morphoStates.some((s) => s.isPending))

  const correlated = isCorrelated({ price: sides.collateral.price, token: C.token }, { price: sides.loan.price, token: D.token })
  const own = C.underlyingApy
  const hereSupply = C.supplyApy + C.supplyRewardApy
  const hereBorrow = ctx.borrowApy - ctx.borrowRewardApy
  /** lending rate on the collateral and net borrow rate at the other end */
  const ratesOf = (o: Other): { supply: number; borrow: number } => {
    if (o.kind === 'v4') {
      const premium = o.state.user?.otherPositions ? o.state.user.riskPremium : o.pair.collateral.collateralRisk
      return {
        supply: o.pair.collateral.supplyApy + o.pair.collateral.supplyRewardApy,
        borrow: v4BorrowApy(o.pair.debt.borrowApy, premium) - o.pair.debt.borrowRewardApy,
      }
    }
    if (o.kind === 'aave') return { supply: aaveSupplyNet(o.pair.collateral), borrow: aaveBorrowNet(o.pair.debt) }
    return { supply: 0, borrow: (o.state.borrowApy ?? o.market.borrowApy) - o.market.borrowRewardsApr }
  }

  // amounts and both ends of the move
  const moved = r ? (r.out ? here : holdings(r.other)) : { coll: 0n, debt: 0n }
  const collV = toBase(moved.coll, sides.collateral)
  const debtV = toBase(moved.debt, sides.loan)
  const equity = Number(collV - debtV)
  const rates = r ? ratesOf(r.other) : undefined
  const fromRates = r ? (r.out ? { supply: hereSupply, borrow: hereBorrow } : rates!) : undefined
  const toRates = r ? (r.out ? rates! : { supply: hereSupply, borrow: hereBorrow }) : undefined
  const apyOf = (x?: { supply: number; borrow: number }) =>
    x && equity > 0 ? ((own + x.supply) * Number(collV) - x.borrow * Number(debtV)) / equity : undefined
  const apyBefore = apyOf(fromRates)
  const apyAfter = apyOf(toRates)
  const yearly = apyBefore !== undefined && apyAfter !== undefined ? ((apyAfter - apyBefore) * equity) / 1e8 : undefined

  let hfBefore: number | undefined
  let hfAfter: number | undefined
  let ltvOk = true
  const problems: string[] = []
  const warnings: string[] = []
  if (r) {
    const o = r.other
    const hfHere = (c: bigint, d: bigint) => morphoHf(c, d, state.price, state.lltv)
    const hfOther = (c: bigint, d: bigint): number => {
      if (o.kind === 'v4') return morphoHf(c, d, o.state.price, o.state.lltv)
      if (o.kind === 'morpho') return morphoHf(c, d, o.state.price, o.market.params.lltv)
      return o.side.healthFactor
    }
    const h = holdings(o)
    if (r.out) {
      hfBefore = user?.healthFactor
      if (o.kind === 'aave') {
        const base = o.pair.switchTo !== undefined ? { ...o.side.account, collateralBase: 0n, debtBase: 0n } : o.side.account
        const after = aaveAccountAfter(base, moved.coll, o.pair.collateral.side, o.pair.ltBps, o.pair.ltvBps, moved.debt, o.pair.debt.side, 1)
        hfAfter = after.healthFactor
        ltvOk = after.ltvOk
        if (aaveBorrowRoomBase(o.pair.debt) < toBase(withInterestMargin(moved.debt), o.pair.debt.side))
          problems.push(
            `Aave ${o.pool.label} ne peut pas prêter ${fmtAmount(moved.debt, D.token.decimals)} ${D.token.symbol} (liquidité ou plafond d’emprunt).`,
          )
        const room = aaveSupplyRoomBase(o.pair.collateral)
        if (room !== undefined && room < toBase(moved.coll, o.pair.collateral.side))
          problems.push(`Plafond de dépôt de ${C.token.symbol} atteint sur Aave ${o.pool.label}.`)
        if (!ltvOk) problems.push(`Sur Aave, la dette dépasserait le LTV de ${fmtPct(o.pair.ltvBps / 10_000)} : Aave refuse l’emprunt.`)
        if (o.pair.switchTo !== undefined && o.pair.switchTo > 0) warnings.push(`Le compte Aave passe d’abord en eMode « ${o.pair.emode?.label} ».`)
      } else {
        hfAfter = hfOther(h.coll + moved.coll, h.debt + moved.debt)
        if (o.kind === 'v4') {
          if (withInterestMargin(moved.debt) > o.state.borrowable)
            problems.push(`Le spoke ${o.pair.collateral.spoke.name} ne peut pas prêter ${fmtAmount(moved.debt, D.token.decimals)} ${D.token.symbol}.`)
          if (moved.coll > o.state.suppliable) problems.push(`Plafond de dépôt de ${C.token.symbol} atteint dans le spoke ${o.pair.collateral.spoke.name}.`)
        } else {
          if (o.state.liquidity < withInterestMargin(moved.debt))
            problems.push(`Liquidité insuffisante sur ce marché Morpho pour reprendre ${fmtAmount(moved.debt, D.token.decimals)} ${D.token.symbol}.`)
          if (!o.market.listed) warnings.push('Ce marché Morpho n’est pas listé par Morpho : vérifier son oracle.')
        }
      }
      if (user?.otherPositions)
        warnings.push('Ce compte a d’autres positions dans ce spoke : le retrait du collatéral doit laisser leur health factor au-dessus de 1.')
    } else {
      hfBefore = hfOther(h.coll, h.debt)
      hfAfter = hfHere(here.coll + moved.coll, here.debt + moved.debt)
      if (withInterestMargin(moved.debt) > state.borrowable)
        problems.push(`Ce spoke ne peut pas prêter ${fmtAmount(moved.debt, D.token.decimals)} ${D.token.symbol} (liquidité ou plafond).`)
      if (moved.coll > state.suppliable) problems.push(`Plafond de dépôt de ${C.token.symbol} atteint dans ce spoke.`)
      if (!C.canCollateral || C.collateralFactor === 0) problems.push(`${C.token.symbol} n’est pas accepté en collatéral dans ce spoke.`)
      if (o.kind === 'aave' && o.side.account.debtBase > toBase(moved.debt, o.pair.debt.side) + 100n * 10n ** 8n)
        warnings.push(`Le compte Aave ${o.pool.label} a d’autres dettes : le retrait du collatéral doit les laisser garanties.`)
    }
    if (withInterestMargin(moved.debt) > state.flashLiquidity)
      problems.push(`Flash loan trop grand : Morpho Blue ne détient que ${fmtAmount(state.flashLiquidity, D.token.decimals)} ${D.token.symbol} sur ce réseau.`)
    if (hfAfter !== undefined && hfAfter < 1) problems.push(`Health factor ${fmtHf(hfAfter)} à l’arrivée : la position serait liquidable.`)
    else if (hfAfter !== undefined && hfAfter < hfThresholds(correlated).ok) warnings.push(`Health factor ${fmtHf(hfAfter)} à l’arrivée.`)
  }

  const placeOf = (o: Other): V4Place =>
    o.kind === 'v4'
      ? { venue: 'v4', spoke: o.pair.collateral.spoke.address, collateralId: o.pair.collateral.reserveId, debtId: o.pair.debt.reserveId }
      : o.kind === 'aave'
        ? { venue: 'aave', pool: o.pool.pool }
        : { venue: 'morpho', market: o.market.params }
  const herePlace: V4Place = { venue: 'v4', spoke: C.spoke.address, collateralId: C.reserveId, debtId: D.reserveId }

  const plan = (): V4RefinancePlan | undefined => {
    if (!executor || !account || !r || moved.coll === 0n || moved.debt === 0n) return undefined
    const o = r.other
    const exitNeed = withInterestMargin(moved.coll)
    const enterNeed = withInterestMargin(moved.debt)
    const v4User = (s?: V4State) => s?.user
    const src = r.out ? undefined : o
    const dst = r.out ? o : undefined
    return {
      net,
      executor,
      user: account,
      minHealthFactor: hfAfter !== undefined && Number.isFinite(hfAfter) ? BigInt(Math.floor(hfAfter * 0.98 * 1e6)) * 10n ** 12n : 0n,
      from: r.out ? herePlace : placeOf(o),
      to: r.out ? placeOf(o) : herePlace,
      fromSetup: r.out ? v4SetupOf(user) : src?.kind === 'v4' ? v4SetupOf(v4User(src.state)) : undefined,
      toSetup: r.out ? (dst?.kind === 'v4' ? v4SetupOf(v4User(dst.state)) : undefined) : v4SetupOf(user),
      exit: r.out
        ? { need: exitNeed, allowance: user?.withdrawAllowance ?? 0n }
        : src?.kind === 'v4'
          ? { need: exitNeed, allowance: src.state.user?.withdrawAllowance ?? 0n }
          : src?.kind === 'aave'
            ? { need: exitNeed, allowance: src.side.aTokenAllowance, aToken: src.pair.collateral.aToken }
            : { need: 0n, allowance: 0n },
      enter: !r.out
        ? { need: enterNeed, allowance: user?.borrowAllowance ?? 0n }
        : dst?.kind === 'v4'
          ? { need: enterNeed, allowance: dst.state.user?.borrowAllowance ?? 0n }
          : dst?.kind === 'aave'
            ? { need: enterNeed, allowance: dst.side.borrowAllowance, debtToken: dst.pair.debt.variableDebtToken }
            : { need: 0n, allowance: 0n },
      morphoAuthorized: o.kind === 'morpho' ? !!o.state.user?.authorized : undefined,
      eModeTarget: dst?.kind === 'aave' ? dst.pair.switchTo : undefined,
    }
  }
  const preview = (() => {
    try {
      const p = plan()
      return p && encodeV4Refinance(p)
    } catch {
      return undefined
    }
  })()
  const canSign = !!preview && problems.length === 0 && !busy && hfAfter !== undefined
  const disabledReason = signBlocker({ executor, account, problems }) ?? (!r && !loading ? 'Rien à refinancer' : undefined)

  async function onRefinance() {
    await run(async () => {
      const p = plan()!
      const o = r!.other
      const hash = await executeV4Refinance(
        p,
        {
          batch: ctx.batch,
          permit: ctx.permit,
          takerNonce: user?.permitNonce ?? 0n,
          morphoNonce: o.kind === 'morpho' ? (o.state.user?.nonce ?? 0n) : 0n,
        },
        setBusy,
      )
      const outcome = await readV4Outcome(chainId, hash, p.executor, p.user)
      setResult({
        ok: true,
        text: r!.out ? `Position refinancée : ${otherName(o)}.` : `Position refinancée dans le spoke ${C.spoke.name}.`,
        hash,
        details: outcome && v4OutcomeLines(outcome, C.token, D.token),
        land: r!.out && o.kind === 'v4' ? o : undefined,
      })
      ctx.onDone()
      v4States.forEach((s) => void s.refetch())
      aaveSides.forEach((s) => void s.refetch())
      morphoStates.forEach((s) => void s.refetch())
    })
  }

  // the steps, as the wallet will see them
  const p = plan()
  const exitStep =
    p && p.exit.need > p.exit.allowance
      ? p.from.venue === 'v4'
        ? 'autoriser le contrat à retirer le collatéral du spoke'
        : p.from.venue === 'aave'
          ? 'autoriser le contrat à prendre le collatéral déposé sur Aave'
          : undefined
      : undefined
  const enterStep =
    p && p.enter.need > p.enter.allowance
      ? p.to.venue === 'v4'
        ? 'autoriser le contrat à emprunter la dette dans le spoke'
        : p.to.venue === 'aave'
          ? 'déléguer au contrat l’emprunt sur Aave, du montant de la dette'
          : undefined
      : undefined
  const morphoStep = p && (p.from.venue === 'morpho' || p.to.venue === 'morpho') && !p.morphoAuthorized
  const setupLines = p
    ? [
        ...(p.from.venue === 'v4' && p.fromSetup ? v4SetupSteps(p.fromSetup, ctx.batch, { collateral: false }) : []),
        ...(p.to.venue === 'v4' && p.toSetup ? v4SetupSteps(p.toSetup, ctx.batch) : []),
      ]
    : []
  const emodeLine =
    p?.eModeTarget !== undefined && r?.other.kind === 'aave' ? [{ label: `Passer le compte Aave en eMode « ${r.other.pair.emode?.label ?? 'aucun'} »` }] : []
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const steps = ctx.batch
    ? [
        ...setupLines,
        ...emodeLine,
        ...[exitStep, enterStep].filter((s): s is string => !!s).map((s) => ({ label: `${cap(s)} (rendu à sa valeur à la fin du lot)` })),
        ...(morphoStep ? [{ label: 'Autoriser le contrat sur Morpho, le temps du lot' }] : []),
        { label: 'Refinancer : flash loan Morpho, remboursement, déplacement du collatéral et emprunt' },
        ...(morphoStep ? [{ label: 'Retirer l’autorisation Morpho' }] : []),
      ]
    : [
        ...setupLines,
        ...emodeLine.map((s) => ({ label: `${s.label} (transaction)` })),
        ...[exitStep, enterStep]
          .filter((s): s is string => !!s)
          .map((s) => ({ label: ctx.permit ? `Signer un message (sans gas) : ${s}, pour cette transaction seulement` : `${cap(s)} (transaction)` })),
        ...(morphoStep
          ? [
              {
                label: ctx.permit
                  ? 'Signer deux messages Morpho (sans gas) : autoriser le contrat pour cette transaction, puis retirer cette autorisation'
                  : 'Autoriser le contrat sur Morpho (transaction, retirée après)',
              },
            ]
          : []),
        { label: 'Signer la transaction : tout en une fois, sans swap' },
      ]

  const fromName = r ? (r.out ? `spoke ${C.spoke.name}` : otherName(r.other)) : undefined
  const toName = r ? (r.out ? otherName(r.other) : `spoke ${C.spoke.name}`) : undefined
  const summary = (
    <Summary
      items={[
        {
          label: 'Health factor',
          value: hfAfter !== undefined ? fmtHf(hfAfter) : undefined,
          sub: hfBefore !== undefined ? `avant ${fmtHf(hfBefore)}` : undefined,
          tone: hfAfter !== undefined ? hfTone(hfAfter, correlated) : undefined,
          key: true,
        },
        {
          label: 'APY net',
          value: apyAfter !== undefined ? fmtPct(apyAfter) : undefined,
          sub: apyBefore !== undefined ? `avant ${fmtPct(apyBefore)}` : undefined,
          tone: apyTone(apyAfter),
          key: true,
        },
        {
          label: 'Écart par an',
          value: yearly !== undefined ? `${yearly >= 0 ? '+' : '−'}${fmtDollars(Math.abs(yearly))}` : undefined,
          sub: 'aux taux d’aujourd’hui',
          tone: yearly === undefined ? undefined : yearly > 0 ? 'good' : yearly < 0 ? 'bad' : undefined,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onRefinance} title={disabledReason}>
          {busy ?? (toName ? `Refinancer vers ${toName}` : 'Refinancer')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={net} result={result} />
      {result?.ok && result.land?.kind === 'v4' && (
        <button
          className="btn"
          onClick={() => {
            const l = result.land as Extract<Other, { kind: 'v4' }>
            ctx.onPick({ spoke: l.pair.collateral.spoke.address, collateralId: l.pair.collateral.reserveId, debtId: l.pair.debt.reserveId }, 'close')
          }}
        >
          Afficher la position dans le spoke {result.land.pair.collateral.spoke.name}
        </button>
      )}
    </Summary>
  )

  return (
    <LoopLayout summary={summary}>
      {ctx.head}
      <Card title="Refinancer">
        <p className="muted small">
          La même position ({C.token.symbol} / {D.token.symbol}) passe de ce spoke à un autre spoke, à Aave v3 ou à Morpho, ou l’inverse, en une transaction :
          la dette est remboursée d’un côté et ouverte de l’autre, le collatéral déplacé sans swap ni passage par le portefeuille.
        </p>
        {!account ? (
          <Notice>Portefeuille non connecté : les positions ne sont pas lisibles.</Notice>
        ) : loading && !r ? (
          <p className="muted small">Lecture des positions de ce réseau (spokes, Aave, Morpho)…</p>
        ) : !r ? (
          <Notice>
            Rien à refinancer : aucune position {C.token.symbol} / {D.token.symbol} dans ce spoke, ni ailleurs sur {net.label} (autres spokes, Aave{' '}
            {pools.map((x) => x.label).join(', ')}, Morpho) à faire venir ici.
          </Notice>
        ) : (
          <>
            {routes.length > 0 && (
              <label className="field">
                <span>Déplacement</span>
                <select value={key(r)} onChange={(e) => setChoice(e.target.value)}>
                  {routes.map((x) => (
                    <option key={key(x)} value={key(x)}>
                      {x.out ? `Ce spoke → ${otherName(x.other)}` : `${otherName(x.other)} → ce spoke`} · emprunt{' '}
                      {fmtPct(x.out ? ratesOf(x.other).borrow : hereBorrow)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="metrics">
              <Metric label="Collatéral déplacé" value={`${fmtAmount(moved.coll, C.token.decimals)} ${C.token.symbol}`} sub={`de ${fromName} vers ${toName}`} />
              <Metric label="Dette déplacée" value={`${fmtAmount(moved.debt, D.token.decimals)} ${D.token.symbol}`} sub="intérêts compris à l’inclusion" />
              {fromRates && toRates && (
                <Metric
                  label="Taux d’emprunt"
                  value={fmtPct(toRates.borrow)}
                  sub={`avant ${fmtPct(fromRates.borrow)}`}
                  tone={toRates.borrow < fromRates.borrow ? 'good' : toRates.borrow > fromRates.borrow ? 'bad' : undefined}
                />
              )}
            </div>
          </>
        )}
        <Banners problems={problems} warnings={warnings} />
        {r && fromRates && toRates && (
          <Fold title="Comparaison" value={`emprunt ${fmtPct(fromRates.borrow)} → ${fmtPct(toRates.borrow)}`}>
            <dl className="preview">
              <dt>Emprunt {D.token.symbol}</dt>
              <dd>
                {fromName} {fmtPct(fromRates.borrow)} · {toName} {fmtPct(toRates.borrow)} (récompenses déduites, prime de risque v4 comprise)
              </dd>
              <dt>Collatéral {C.token.symbol}</dt>
              <dd>
                rendement propre {fmtPct(own)}, plus le taux de prêt : {fromName} {fmtPct(fromRates.supply)} · {toName} {fmtPct(toRates.supply)}
              </dd>
              <dt>Valeur déplacée</dt>
              <dd>
                {fmtDollars(Number(collV) / 1e8, true)} de collatéral, {fmtDollars(Number(debtV) / 1e8, true)} de dette
              </dd>
            </dl>
            <p className="muted small">
              Écart par an : différence d’APY net sur la mise, aux taux d’aujourd’hui. Le refinancement ne coûte que le gas : le flash loan Morpho est gratuit
              et rien n’est échangé.
            </p>
          </Fold>
        )}
        {preview && (
          <Fold title="Transaction" value="refinance()">
            <dl className="preview">
              <dt>Contrat</dt>
              <dd>{executor as Address}</dd>
              <dt>Calldata</dt>
              <dd className="mono">{preview}</dd>
            </dl>
          </Fold>
        )}
        {r && <StepsFold steps={steps} batch={ctx.batch} />}
      </Card>
    </LoopLayout>
  )
}
