import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { MARKETS, getMarket, type Market } from '../../../config'
import { morphoHf, morphoLeverage, morphoNetApy } from '../../../protocols/morpho/markets'
import {
  REPAY_ALL,
  encodeAction,
  executeRefinance,
  morphoOutcomeLines,
  readMorphoOutcome,
  refinanceAction,
  withInterestMargin,
  type MorphoRefinancePlan,
} from '../../../protocols/morpho/execute'
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
import { deployMorphoExecutor, sharedMorphoExecutorAddress, useSharedMorphoExecutor } from '../../../chain/deploy'
import { explainError } from '../../../chain/tx'
import { toBase } from '../../../domain/math'
import { isCorrelated } from '../../../domain/pairs'
import { fmtAddress, fmtAmount, fmtDollars, fmtHf, fmtLltv, fmtPct, fmtX, ptShortSymbol } from '../../../ui/format'
import { apyTone, hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LoopLayout, Metric, Notice, Steps, Summary, TxResult } from '../../../ui/primitives'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import type { MorphoCtx } from './MorphoView'

/** Aave v3 markets of the network (selectable ones). */
export const aaveMarketsOn = (chainId: number): Market[] => MARKETS.filter((m) => m.chain.id === chainId && !m.soon).map((m) => getMarket(m.id))

type Route = { pool: Market; snapshot: Snapshot; side: AaveSide; pair: AavePair & { switchTo?: number }; toMorpho: boolean }

/** Upgrade offer while the network's Morpho contract predates `refinance`: the shared one, used or deployed. */
function UpgradeNotice({ ctx }: { ctx: MorphoCtx }) {
  const { net } = ctx
  const shared = useSharedMorphoExecutor(net, true)
  const [step, setStep] = useState<string>()
  const [error, setError] = useState<string>()
  const address = shared.data
  async function deploy() {
    setError(undefined)
    try {
      ctx.onExecutor(await deployMorphoExecutor(net, setStep))
    } catch (e) {
      setError(explainError(e).split('\n')[0])
    } finally {
      setStep(undefined)
    }
  }
  return (
    <>
      <Notice>
        <span>
          Le contrat Morpho utilisé sur {net.label} date d’avant le refinancement Aave ↔ Morpho.{' '}
          {address
            ? `Le contrat commun à jour existe déjà (${fmtAddress(address)}) : l’utiliser.`
            : `Le contrat commun à jour (${fmtAddress(sharedMorphoExecutorAddress(net))}) n’est pas encore déployé : seul le gas est payé, une fois pour tous.`}
        </span>
        {net.executorSource !== 'build' &&
          (address ? (
            <button className="btn" onClick={() => ctx.onExecutor(address)}>
              Utiliser ce contrat
            </button>
          ) : (
            <button className="btn" disabled={!!step || shared.isPending || !ctx.account} onClick={deploy}>
              {step ?? 'Déployer le contrat à jour'}
            </button>
          ))}
      </Notice>
      {error && <Notice tone="bad">{error}</Notice>}
    </>
  )
}

export function MorphoRefinancePanel({ ctx }: { ctx: MorphoCtx }) {
  const { net, market: M, state, sides, account } = ctx
  const C = M.collateral
  const L = M.loan
  const executor = net.executor
  const mUser = state.user
  const { busy, setBusy, result, setResult, run } = useTxAction()
  const [choice, setChoice] = useState<string>()

  const pools = useMemo(() => aaveMarketsOn(net.chain.id), [net.chain.id])
  const snapshots = useQueries({ queries: pools.map((p) => snapshotQuery(p)) })
  const campaigns = useQuery(merklQuery(net.chain.id))
  const aaveSides = useQueries({
    queries: pools.map((p, i) => {
      const snap = snapshots[i].data
      const any = snap && aavePair(snap, C.address, L.address, 0, true)
      return {
        queryKey: ['refinance-aave', p.id, account, executor, C.address, L.address],
        queryFn: () => readAaveSide(net.chain.id, p.pool, any!, account!, executor),
        enabled: !!any && !!account,
        refetchInterval: 30_000,
      }
    }),
  })

  // every move this position allows: each Aave position of the pair to this market, this market to each Aave pool
  const routes = useMemo(() => {
    const out: Route[] = []
    const hasMorpho = !!mUser && mUser.collateral > 0n && mUser.debt > 0n
    pools.forEach((pool, i) => {
      const snapshot = snapshots[i].data
      const side = aaveSides[i].data
      if (!snapshot || !side) return
      const empty = side.account.collateralBase === 0n && side.account.debtBase === 0n
      const pair = aavePair(snapshot, C.address, L.address, side.eModeCategory, empty)
      if (!pair) return
      const rw = (r: typeof pair.collateral) => ({
        ...r,
        ...((h) => ({ supplyRewardApr: h.supply, borrowRewardApr: h.borrow }))(headlineRewards(campaigns.data, r)),
      })
      const p = { ...pair, collateral: rw(pair.collateral), debt: rw(pair.debt) }
      if (side.supplied > 0n && side.borrowed > 0n) out.push({ pool, snapshot, side, pair: p, toMorpho: true })
      if (hasMorpho) out.push({ pool, snapshot, side, pair: p, toMorpho: false })
    })
    return out.sort((a, b) => Number(b.toMorpho) - Number(a.toMorpho))
  }, [pools, snapshots, aaveSides, mUser, C.address, L.address, campaigns.data])
  const key = (r: Route) => `${r.pool.id}-${r.toMorpho ? 'in' : 'out'}`
  const route = routes.find((r) => key(r) === choice) ?? routes[0]
  const loading = snapshots.some((s) => s.isPending) || (!!account && aaveSides.some((s) => s.isPending && s.fetchStatus !== 'idle'))
  const listedOnAave = snapshots.some((s) => s.data && aavePair(s.data, C.address, L.address, 0, true))

  const correlated = isCorrelated({ price: sides.collateral.price, token: C }, { price: sides.loan.price, token: L })
  const own = ctx.collateralApy
  const mBorrow = ctx.borrowApy - ctx.rewardsApr

  // amounts and both ends of the move
  const r = route
  const collMoved = r ? (r.toMorpho ? r.side.supplied : (mUser?.collateral ?? 0n)) : 0n
  const debtMoved = r ? (r.toMorpho ? r.side.borrowed : (mUser?.debt ?? 0n)) : 0n
  const aC = r?.pair.collateral
  const aD = r?.pair.debt
  const lev = collMoved > 0n ? morphoLeverage(collMoved, debtMoved, state.price) : undefined
  const aaveApy = lev !== undefined && Number.isFinite(lev) && aC && aD ? morphoNetApy(lev, own + aaveSupplyNet(aC), aaveBorrowNet(aD)) : undefined
  const morphoApy = lev !== undefined && Number.isFinite(lev) ? morphoNetApy(lev, own, mBorrow) : undefined
  const apyBefore = r?.toMorpho ? aaveApy : morphoApy
  const apyAfter = r?.toMorpho ? morphoApy : aaveApy
  const equityUsd = r ? Number(toBase(collMoved, sides.collateral) - toBase(debtMoved, sides.loan)) / 1e8 : 0
  const yearly = apyBefore !== undefined && apyAfter !== undefined ? (apyAfter - apyBefore) * equityUsd : undefined

  let hfBefore: number | undefined
  let hfAfter: number | undefined
  /** what stays on Aave after a move to Morpho, when the account holds something else */
  let aaveRest: ReturnType<typeof aaveAccountAfter> | undefined
  let ltvOk = true
  if (r && aC && aD) {
    if (r.toMorpho) {
      hfBefore = r.side.healthFactor
      hfAfter = morphoHf((mUser?.collateral ?? 0n) + collMoved, (mUser?.debt ?? 0n) + debtMoved, state.price, M.params.lltv)
      aaveRest = aaveAccountAfter(r.side.account, collMoved, aC.side, r.pair.ltBps, r.pair.ltvBps, debtMoved, aD.side, -1)
    } else {
      hfBefore = mUser ? morphoHf(mUser.collateral, mUser.debt, state.price, M.params.lltv) : undefined
      const base = r.pair.switchTo !== undefined ? { ...r.side.account, collateralBase: 0n, debtBase: 0n } : r.side.account
      const after = aaveAccountAfter(base, collMoved, aC.side, r.pair.ltBps, r.pair.ltvBps, debtMoved, aD.side, 1)
      hfAfter = after.healthFactor
      ltvOk = after.ltvOk
    }
  }

  const problems: string[] = []
  const warnings: string[] = []
  if (r && aC && aD) {
    if (r.toMorpho) {
      if (state.liquidity < withInterestMargin(debtMoved))
        problems.push(`Liquidité insuffisante sur ce marché Morpho pour reprendre ${fmtAmount(debtMoved, L.decimals)} ${L.symbol}.`)
      if (aaveRest && aaveRest.debtBase > 0n && aaveRest.healthFactor < 1)
        problems.push(`Le reste du compte Aave tomberait à un health factor de ${fmtHf(aaveRest.healthFactor)} : Aave refuse le retrait du collatéral.`)
      else if (aaveRest && aaveRest.debtBase > 0n && aaveRest.healthFactor < hfThresholds(false).ok)
        warnings.push(`Le reste du compte Aave passe à un health factor de ${fmtHf(aaveRest.healthFactor)}.`)
    } else {
      if (aaveBorrowRoomBase(aD) < toBase(withInterestMargin(debtMoved), aD.side))
        problems.push(`Aave ${r.pool.label} ne peut pas prêter ${fmtAmount(debtMoved, L.decimals)} ${L.symbol} (liquidité ou plafond d’emprunt).`)
      const room = aaveSupplyRoomBase(aC)
      if (room !== undefined && room < toBase(collMoved, aC.side)) problems.push(`Plafond de dépôt de ${C.symbol} atteint sur Aave ${r.pool.label}.`)
      if (!ltvOk) problems.push(`Sur Aave, la dette dépasserait le LTV de ${fmtPct(r.pair.ltvBps / 10_000)} : Aave refuse l’emprunt.`)
      if (r.pair.switchTo !== undefined && r.pair.switchTo > 0) warnings.push(`Le compte Aave passe d’abord en eMode « ${r.pair.emode?.label} ».`)
    }
    if (hfAfter !== undefined && hfAfter < 1) problems.push(`Health factor ${fmtHf(hfAfter)} à l’arrivée : la position serait liquidable.`)
    else if (hfAfter !== undefined && hfAfter < hfThresholds(correlated).ok) warnings.push(`Health factor ${fmtHf(hfAfter)} à l’arrivée.`)
    if (r.toMorpho && !M.listed) warnings.push('Ce marché Morpho n’est pas listé par Morpho : vérifier son oracle.')
  }
  if (executor && !net.executorRefinance) problems.push('Le contrat Morpho de ce réseau ne sait pas encore refinancer : passer au contrat à jour.')

  const plan = (): MorphoRefinancePlan | undefined =>
    executor && account && r && aC && aD
      ? {
          net,
          executor,
          user: account,
          authorized: !!mUser?.authorized,
          minHealthFactor: hfAfter !== undefined && Number.isFinite(hfAfter) ? BigInt(Math.floor(hfAfter * 0.98 * 1e6)) * 10n ** 12n : 0n,
          pool: r.pool.pool,
          market: M.params,
          toMorpho: r.toMorpho,
          debtAmount: REPAY_ALL,
          collateralAmount: REPAY_ALL,
          aave: r.toMorpho
            ? { token: aC.aToken, need: withInterestMargin(collMoved), allowance: r.side.aTokenAllowance }
            : { token: aD.variableDebtToken, need: withInterestMargin(debtMoved), allowance: r.side.borrowAllowance },
          eModeTarget: r.toMorpho ? undefined : r.pair.switchTo,
        }
      : undefined
  const preview = (() => {
    try {
      const p = plan()
      return p && encodeAction(refinanceAction(p))
    } catch {
      return undefined
    }
  })()
  const canSign = !!preview && net.executorRefinance === true && problems.length === 0 && !busy && hfAfter !== undefined
  const disabledReason = signBlocker({ executor, account, problems }) ?? (!r && !loading ? 'Rien à refinancer' : undefined)

  async function onRefinance() {
    await run(async () => {
      const p = plan()!
      const hash = await executeRefinance(p, { batch: ctx.batch, nonce: mUser?.nonce ?? 0n }, setBusy)
      const outcome = await readMorphoOutcome(net.chain.id, hash, p.executor, p.user)
      const res = {
        ok: true,
        text: p.toMorpho ? 'Position refinancée sur Morpho.' : `Position refinancée sur Aave ${r!.pool.label}.`,
        hash,
        details: outcome && morphoOutcomeLines(outcome, C, L),
      }
      if (p.toMorpho) ctx.onMoved(M.id, res)
      else {
        setResult(res)
        ctx.onDone()
        void aaveSides.forEach((s) => s.refetch())
      }
    })
  }

  const needsAave = !!r && (r.toMorpho ? r.side.aTokenAllowance : r.side.borrowAllowance) < withInterestMargin(r.toMorpho ? collMoved : debtMoved)
  const aaveStep = r?.toMorpho
    ? 'Autoriser le contrat à prendre le collatéral déposé sur Aave'
    : 'Déléguer au contrat l’emprunt sur Aave, du montant de la dette'
  const emodeStep = r && !r.toMorpho && r.pair.switchTo !== undefined ? [{ label: `Passer le compte Aave en eMode « ${r.pair.emode?.label ?? 'aucun'} »` }] : []
  const authorized = !!mUser?.authorized
  const steps = ctx.batch
    ? [
        ...emodeStep,
        ...(needsAave ? [{ label: `${aaveStep} (rendu à sa valeur à la fin du lot)` }] : []),
        ...(authorized ? [] : [{ label: 'Autoriser le contrat sur Morpho, le temps du lot' }]),
        { label: 'Refinancer : flash loan Morpho, remboursement, déplacement du collatéral et emprunt' },
        ...(authorized ? [] : [{ label: 'Retirer l’autorisation Morpho' }]),
      ]
    : [
        ...emodeStep.map((s) => ({ label: `${s.label} (transaction)` })),
        ...(needsAave ? [{ label: authorized ? `${aaveStep} (transaction)` : `Signer un message Aave (sans gas) : ${aaveStep.toLowerCase()}` }] : []),
        ...(authorized
          ? []
          : [{ label: 'Signer deux messages Morpho (sans gas) : autoriser le contrat pour cette transaction, puis retirer cette autorisation' }]),
        { label: 'Signer la transaction : tout en une fois, sans swap' },
      ]

  const from = r ? (r.toMorpho ? `Aave ${r.pool.label}` : 'Morpho') : undefined
  const to = r ? (r.toMorpho ? 'Morpho' : `Aave ${r.pool.label}`) : undefined
  const summary = (
    <Summary
      items={[
        {
          label: 'Health factor',
          value: hfAfter !== undefined ? fmtHf(hfAfter) : undefined,
          sub: hfBefore !== undefined ? `avant ${fmtHf(hfBefore)}${r?.toMorpho ? ' (compte Aave)' : ''}` : undefined,
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
          {busy ?? (to ? `Refinancer sur ${to}` : 'Refinancer')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={net} result={result} />
    </Summary>
  )

  const borrowOf = (aave: boolean) => (aave && aD ? aaveBorrowNet(aD) : mBorrow)
  return (
    <LoopLayout summary={summary}>
      {ctx.head}
      {executor && !net.executorRefinance && <UpgradeNotice ctx={ctx} />}
      <Card title="Refinancer">
        <p className="muted small">
          La même position ({ptShortSymbol(C.symbol)} / {L.symbol}) passe d’Aave à Morpho ou de Morpho à Aave en une transaction : la dette est remboursée d’un
          côté et ouverte de l’autre, le collatéral déplacé sans swap ni passage par le portefeuille.
        </p>
        {!account ? null : loading && !r ? (
          <p className="muted small">Lecture des positions Aave de ce réseau…</p>
        ) : !r ? (
          <Notice>
            {listedOnAave
              ? `Rien à refinancer : aucune position ${ptShortSymbol(C.symbol)} / ${L.symbol} sur ce marché Morpho ni sur Aave ${pools.map((p) => p.label).join(', ')}.`
              : `Aave ne prête pas ${L.symbol} contre ${ptShortSymbol(C.symbol)} sur ${net.label} : pas de refinancement possible pour cette paire.`}
          </Notice>
        ) : (
          <>
            {routes.length > 1 && (
              <label className="field">
                <span>Déplacement</span>
                <select value={key(r)} onChange={(e) => setChoice(e.target.value)}>
                  {routes.map((x) => (
                    <option key={key(x)} value={key(x)}>
                      {x.toMorpho ? `Aave ${x.pool.label} → Morpho` : `Morpho → Aave ${x.pool.label}`} · emprunt{' '}
                      {fmtPct(x.toMorpho ? mBorrow : aaveBorrowNet(x.pair.debt))}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="metrics">
              <Metric label="Collatéral déplacé" value={`${fmtAmount(collMoved, C.decimals)} ${ptShortSymbol(C.symbol)}`} sub={`de ${from} vers ${to}`} />
              <Metric
                label="Dette déplacée"
                value={`${fmtAmount(debtMoved, L.decimals)} ${L.symbol}`}
                sub={lev !== undefined ? `levier ${fmtX(lev)}` : undefined}
              />
              <Metric
                label="Taux d’emprunt"
                value={fmtPct(borrowOf(!r.toMorpho))}
                sub={`avant ${fmtPct(borrowOf(r.toMorpho))}`}
                tone={borrowOf(!r.toMorpho) < borrowOf(r.toMorpho) ? 'good' : borrowOf(!r.toMorpho) > borrowOf(r.toMorpho) ? 'bad' : undefined}
              />
            </div>
          </>
        )}
        <Banners problems={problems} warnings={warnings} />
        {r && aC && aD && (
          <Fold title="Comparaison" value={`emprunt ${fmtPct(borrowOf(r.toMorpho))} → ${fmtPct(borrowOf(!r.toMorpho))}`}>
            <dl className="preview">
              <dt>Emprunt {L.symbol}</dt>
              <dd>
                Aave {fmtPct(aaveBorrowNet(aD))}
                {aD.borrowRewardApr > 0 ? ` (récompenses ${fmtPct(aD.borrowRewardApr)} déduites)` : ''} · Morpho {fmtPct(mBorrow)}
                {ctx.rewardsApr > 0 ? ` (récompenses ${fmtPct(ctx.rewardsApr)} déduites)` : ''}
              </dd>
              <dt>Collatéral {ptShortSymbol(C.symbol)}</dt>
              <dd>
                Aave {fmtPct(aaveSupplyNet(aC))} de dépôt en plus du rendement propre ({fmtPct(own)}) · Morpho : rendement propre seul, le collatéral n’y est
                pas prêté
              </dd>
              <dt>Seuil de liquidation</dt>
              <dd>
                Aave {fmtPct(r.pair.ltBps / 10_000)}
                {r.pair.emode ? ` (eMode « ${r.pair.emode.label} »)` : ''} · Morpho {fmtLltv(M.lltv)}
              </dd>
              <dt>Liquidité</dt>
              <dd>
                Aave {fmtDollars(Number(aaveBorrowRoomBase(aD)) / 1e8, true)} · Morpho {fmtDollars(M.liquidityUsd, true)}
              </dd>
              {r.side.account.debtBase > 0n && (
                <>
                  <dt>Compte Aave</dt>
                  <dd>
                    health factor {fmtHf(r.side.healthFactor)} pour {fmtDollars(Number(r.side.account.debtBase) / 1e8, true)} de dette au total
                    {aaveRest && aaveRest.debtBase > 0n ? `, ${fmtHf(aaveRest.healthFactor)} pour ce qui reste après le déplacement` : ''}
                  </dd>
                </>
              )}
            </dl>
            <p className="muted small">
              Écart par an : différence d’APY net sur la mise ({fmtDollars(equityUsd, true)}), aux taux d’aujourd’hui. Le refinancement ne coûte que le gas : le
              flash loan Morpho est gratuit et rien n’est échangé.
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
        {r && (
          <Fold title="Étapes" value={ctx.batch ? 'une seule confirmation' : `${steps.length} étape${steps.length > 1 ? 's' : ''}`}>
            <Steps steps={steps} />
          </Fold>
        )}
      </Card>
    </LoopLayout>
  )
}
