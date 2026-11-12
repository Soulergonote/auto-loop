import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AGGREGATORS } from '../../../config'
import { dropToLiquidation, morphoHf, morphoLeverage, morphoNetApy, morphoSides, readMorphoState, type MorphoMarket } from '../../../protocols/morpho/markets'
import {
  REPAY_ALL,
  encodeAction,
  executeMorpho,
  morphoOutcomeLines,
  readMorphoOutcome,
  rollAction,
  type MorphoRollPlan,
} from '../../../protocols/morpho/execute'
import { useQuote } from '../../../services/quotes/useQuote'
import { getQuote, quoteLabel } from '../../../services/quotes/quotes'
import { isExpired, ptInfosQuery, type PtInfo } from '../../../protocols/pendle/pt'
import { swapLoss, swapLossProblem } from '../../../domain/economics'
import { explainError } from '../../../chain/tx'
import { fmtLltv, fmtBps, fmtAmount, fmtDate, fmtDollars, fmtHf, fmtPct, fmtPrice, fmtX, ptShortSymbol } from '../../../ui/format'
import { isCorrelated } from '../../../domain/pairs'
import { apyTone, hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LoopLayout, Metric, NA, QuoteCompare, Segmented, Steps, Summary, TxResult, aggregatorLabel } from '../../../ui/primitives'
import type { MorphoCtx } from './MorphoView'
import { SLIPPAGES, slippageNote, useSlippage } from '../../../domain/slippage'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'

/** Targets offered: at most this many, the best first. */
const MAX_TARGETS = 30

/**
 * Markets the position can move to in one transaction: same loan token, and either the same collateral (another
 * LLTV, oracle or rate) or, for a PT, a PT maturing later (same underlying first, then the nearest maturity).
 */
export function rollTargetsMorpho(markets: MorphoMarket[], from: MorphoMarket, pts: Map<string, PtInfo>, debt: bigint, nowSec = Date.now() / 1000) {
  const fromPt = pts.get(from.collateral.address.toLowerCase())
  const family = ptShortSymbol(from.collateral.symbol)
  const out: { m: MorphoMarket; pt?: PtInfo; sameCollateral: boolean }[] = []
  for (const m of markets) {
    if (m.id === from.id || m.loan.address !== from.loan.address || m.liquidity < debt) continue
    if (m.collateral.address === from.collateral.address) {
      out.push({ m, sameCollateral: true })
      continue
    }
    const pt = pts.get(m.collateral.address.toLowerCase())
    if (fromPt && pt && !isExpired(pt, nowSec) && pt.expiry > fromPt.expiry && !!pt.market) out.push({ m, pt, sameCollateral: false })
  }
  return out
    .sort((a, b) => {
      if (a.sameCollateral !== b.sameCollateral) return a.sameCollateral ? -1 : 1
      if (a.sameCollateral) return a.m.borrowApy - b.m.borrowApy
      const fa = ptShortSymbol(a.m.collateral.symbol) === family ? 0 : 1
      const fb = ptShortSymbol(b.m.collateral.symbol) === family ? 0 : 1
      return fa - fb || a.pt!.expiry - b.pt!.expiry || b.m.liquidityUsd - a.m.liquidityUsd
    })
    .slice(0, MAX_TARGETS)
}

export function MorphoRollPanel({ ctx, renew }: { ctx: MorphoCtx; renew: boolean }) {
  const { net, market: M, state, pt, sides, account } = ctx
  const C = M.collateral
  const L = M.loan
  const executor = net.executor
  const user = state.user!
  const coll = user.collateral
  const debt = user.debt
  const { slippage, setSlippage, auto: autoSlip } = useSlippage('pt')
  const [choice, setChoice] = useState<string>()
  const { busy, setBusy, result, run } = useTxAction()

  // PT infos of every candidate collateral with the same loan token (only PTs can be roll targets across collaterals)
  const candidates = useMemo(
    () =>
      pt ? [...new Set(ctx.markets.filter((m) => m.loan.address === L.address && /^PT-/i.test(m.collateral.symbol)).map((m) => m.collateral.address))] : [],
    [ctx.markets, L.address, pt],
  )
  const ptInfos = useQuery(ptInfosQuery(net.chain.id, [C.address, ...candidates]))
  const targets = useMemo(() => rollTargetsMorpho(ctx.markets, M, ptInfos.data ?? new Map(), debt), [ctx.markets, M, ptInfos.data, debt])
  const target = targets.find((t) => t.m.id === choice) ?? targets[0]
  const T = target?.m
  const toState = useQuery({
    queryKey: ['morpho-state', net.chain.id, T?.id],
    queryFn: () => readMorphoState(net.chain.id, net.morpho, T!),
    enabled: !!T,
    refetchInterval: 30_000,
  })
  const same = !!target?.sameCollateral
  const quoteReq =
    T && !same && toState.data
      ? {
          aggregator: ctx.aggregator,
          chainId: net.chain.id,
          sell: C,
          buy: T.collateral,
          sellAmount: coll,
          taker: net.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: sides.collateral, buy: morphoSides(T, toState.data.price).collateral },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = quote.data
  const newColl = same ? coll : q?.buyAmount
  const newCollMin = same ? coll : q?.minOut
  const price2 = toState.data?.price
  const hf = newColl !== undefined && price2 !== undefined && T ? morphoHf(newColl, debt, price2, T.params.lltv) : undefined
  const worstHf = newCollMin !== undefined && price2 !== undefined && T ? morphoHf(newCollMin, debt, price2, T.params.lltv) : undefined
  const hfNow = morphoHf(coll, debt, state.price, M.params.lltv)
  const lev2 = newColl !== undefined && price2 !== undefined ? morphoLeverage(newColl, debt, price2) : undefined
  const apy2Collateral = target?.pt ? (q?.pendle?.fixedApy ?? target.pt.impliedApy ?? 0) : same ? ctx.collateralApy : 0
  const borrow2 = toState.data?.borrowApy ?? T?.borrowApy ?? 0
  const apy2 = lev2 !== undefined && Number.isFinite(lev2) && T ? morphoNetApy(lev2, apy2Collateral, borrow2 - T.borrowRewardsApr) : undefined
  const correlated = T ? isCorrelated({ price: sides.collateral.price, token: T.collateral }, { price: sides.loan.price, token: L }) : true

  const problems: string[] = []
  if (!T)
    problems.push(
      pt
        ? `Aucun marché ${L.symbol} avec un PT plus lointain ou le même collatéral, et assez de liquidité.`
        : `Aucun autre marché ${C.symbol} / ${L.symbol} avec assez de liquidité.`,
    )
  if (T && toState.data && toState.data.liquidity < debt)
    problems.push(`Liquidité insuffisante sur le nouveau marché pour ${fmtAmount(debt, L.decimals)} ${L.symbol}.`)
  if (worstHf !== undefined && worstHf < 1) problems.push(`Health factor ${fmtHf(worstHf)} sur le nouveau marché : sous son LLTV, Morpho refuse l’emprunt.`)
  if (toState.isError) problems.push(`Lecture du nouveau marché impossible : ${explainError(toState.error)}`)
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  const warnings: string[] = []
  const lossIssue =
    q &&
    toState.data &&
    T &&
    swapLossProblem(
      swapLoss(q.sellAmount, sides.collateral, q.buyAmount, morphoSides(T, toState.data.price).collateral),
      C.symbol,
      T.collateral.symbol,
      q.simulated,
    )
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (hf !== undefined && hf < hfThresholds(correlated).ok) warnings.push(`Health factor ${fmtHf(hf)} sur le nouveau marché.`)
  if (T && !T.listed) warnings.push('Le nouveau marché n’est pas listé par Morpho : vérifier son oracle.')

  const plan = (fresh = q): MorphoRollPlan | undefined =>
    executor && account && T
      ? {
          net,
          executor,
          user: account,
          authorized: user.authorized,
          minHealthFactor: worstHf !== undefined && Number.isFinite(worstHf) ? BigInt(Math.floor(worstHf * 0.98 * 1e6)) * 10n ** 12n : 0n,
          from: M.params,
          to: T.params,
          repayAmount: REPAY_ALL,
          collateralToMove: coll,
          quote: fresh,
        }
      : undefined
  const preview = (() => {
    try {
      const p = plan()
      return p && (same || q) ? encodeAction(rollAction(p)) : undefined
    } catch {
      return undefined
    }
  })()
  const stale = quote.isFetching
  const canSign = !!executor && !!account && !!T && (same || (!!q && !q.simulated)) && !!preview && problems.length === 0 && !stale && !busy && hf !== undefined
  const disabledReason = signBlocker({ executor, account, simulated: q?.simulated, problems })

  async function onRoll() {
    await run(async () => {
      let fresh = q
      if (quoteReq) {
        setBusy('Nouvelle cotation…')
        fresh = await getQuote(quoteReq)
        if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      }
      const p = plan(fresh)!
      const hash = await executeMorpho(p, rollAction(p), { batch: ctx.batch, nonce: user.nonce }, setBusy)
      const outcome = await readMorphoOutcome(net.chain.id, hash, p.executor, p.user)
      // the position now lives on the target market: the view switches to it and shows this result there
      ctx.onMoved(T!.id, { ok: true, text: 'Position déplacée.', hash, details: outcome && morphoOutcomeLines(outcome, C, L, T!.collateral) })
    })
  }

  const steps = ctx.batch
    ? [
        ...(user.authorized ? [] : [{ label: 'Autoriser le contrat sur Morpho, le temps du lot' }]),
        { label: 'Changer de marché : flash loan, remboursement, retrait, swap, dépôt et emprunt' },
        ...(user.authorized ? [] : [{ label: 'Retirer l’autorisation Morpho' }]),
      ]
    : [
        ...(user.authorized
          ? []
          : [{ label: 'Signer deux messages Morpho (sans gas) : autoriser le contrat pour cette transaction, puis retirer cette autorisation' }]),
        { label: 'Signer la transaction : tout en une fois, la dette ne fait que changer de marché' },
      ]

  // the new collateral's USD price; the drop is against the loan token, as Morpho's oracle sees it
  const targetPrice = T && toState.data ? morphoSides(T, toState.data.price).collateral.price : 0n
  const drop = hf !== undefined && Number.isFinite(hf) ? dropToLiquidation(hf) : undefined
  const liquidation =
    T && targetPrice > 0n
      ? {
          label: `Liquidation si ${ptShortSymbol(T.collateral.symbol)} à`,
          value: hf === undefined ? undefined : drop === undefined ? NA : fmtPrice(BigInt(Math.round(Number(targetPrice) * (1 - drop)))),
          sub: drop !== undefined ? `baisse de ${fmtPct(drop, 1)} face à ${L.symbol}` : undefined,
        }
      : {
          label: 'Liquidation si baisse de',
          value: hf === undefined ? undefined : drop === undefined ? NA : fmtPct(drop, 1),
          sub: T ? `de ${ptShortSymbol(T.collateral.symbol)} face à ${L.symbol}` : undefined,
        }

  const summary = (
    <Summary
      items={[
        {
          label: 'Health factor',
          value: hf !== undefined ? fmtHf(hf) : undefined,
          sub:
            worstHf !== undefined
              ? `${hf !== undefined && fmtHf(worstHf) !== fmtHf(hf) ? `pire cas ${fmtHf(worstHf)} · ` : ''}avant ${fmtHf(hfNow)}`
              : undefined,
          tone: hf !== undefined ? hfTone(hf, correlated) : undefined,
          key: true,
        },
        liquidation,
        {
          label: 'APY net',
          value: apy2 !== undefined ? fmtPct(apy2) : undefined,
          sub: target?.pt ? `dont ${fmtPct(apy2Collateral)} fixe` : 'taux variables, hors coûts',
          tone: apyTone(apy2),
          key: true,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onRoll} title={disabledReason}>
          {busy ?? (stale ? 'Cotation…' : renew ? 'Renouveler' : 'Changer de marché')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={net} result={result} retry={{ current: slippage, set: setSlippage }} />
    </Summary>
  )

  return (
    <LoopLayout summary={summary}>
      {ctx.head}
      <Card title={renew ? 'Renouveler le PT' : 'Changer de marché'}>
        <p className="muted small">
          {renew && pt
            ? `${C.symbol} arrive à échéance le ${fmtDate(pt.expiry)}. La position passe sur un PT plus lointain en une transaction : la dette est remboursée sur ce marché et ouverte sur le nouveau, le collatéral échangé entre les deux, sans repasser par le portefeuille.`
            : 'La position passe sur un autre marché Morpho en une transaction : la dette est remboursée ici et ouverte là-bas, le collatéral déplacé (et échangé si besoin).'}
        </p>
        <label className="field">
          <span>Nouveau marché</span>
          <select value={T?.id ?? ''} onChange={(e) => setChoice(e.target.value)} disabled={targets.length === 0}>
            {targets.map((t) => (
              <option key={t.m.id} value={t.m.id}>
                {t.m.collateral.symbol} / {L.symbol} · LLTV {fmtLltv(t.m.lltv)} · emprunt {fmtPct(t.m.borrowApy)}
                {t.pt?.impliedApy !== undefined ? ` · fixe ${fmtPct(t.pt.impliedApy)}` : ''} · liquidité {fmtDollars(t.m.liquidityUsd, true)}
              </option>
            ))}
          </select>
        </label>
        <div className="metrics">
          <Metric
            label="Collatéral déplacé"
            value={`${fmtAmount(coll, C.decimals)} ${ptShortSymbol(C.symbol)}`}
            sub={same ? 'même collatéral' : q ? `via ${quoteLabel(q)}` : undefined}
          />
          <Metric
            label="Nouveau collatéral"
            value={newColl !== undefined && T ? `${fmtAmount(newColl, T.collateral.decimals)} ${ptShortSymbol(T.collateral.symbol)}` : undefined}
            sub={newCollMin !== undefined && !same && T ? `au moins ${fmtAmount(newCollMin, T.collateral.decimals)}` : undefined}
          />
          <Metric label="Dette déplacée" value={`${fmtAmount(debt, L.decimals)} ${L.symbol}`} sub={lev2 !== undefined ? `levier ${fmtX(lev2)}` : undefined} />
        </div>
        <Banners problems={problems} warnings={warnings} />
        <Fold title="Réglages" value={`${aggregatorLabel(ctx.aggregator)} · slippage ${fmtBps(slippage)}${slippageNote(autoSlip)}`}>
          {ctx.common}
          <div className="field">
            <span>Slippage max</span>
            <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtBps(s) }))} />
          </div>
        </Fold>
        {q && T && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(q.minOut, T.collateral.decimals)} ${ptShortSymbol(T.collateral.symbol)}`}>
            <QuoteCompare quote={q} token={T.collateral} />
            {q.route && (
              <p className="small">
                Route : {q.route.map((l) => `${l.sell.symbol} → ${l.buy.symbol} (${l.via === 'pendle' ? 'Pendle' : AGGREGATORS[l.via].label})`).join(', ')}.
              </p>
            )}
          </Fold>
        )}
        {preview && (
          <Fold title="Transaction" value="roll()">
            <dl className="preview">
              <dt>Contrat</dt>
              <dd>{executor}</dd>
              <dt>Calldata</dt>
              <dd className="mono">{preview}</dd>
            </dl>
          </Fold>
        )}
        <Fold title="Étapes" value={ctx.batch ? 'une seule confirmation' : `${steps.length} étape${steps.length > 1 ? 's' : ''}`}>
          <Steps steps={steps} />
        </Fold>
      </Card>
    </LoopLayout>
  )
}
