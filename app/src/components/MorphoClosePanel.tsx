import { useState } from 'react'
import { type Hash } from 'viem'
import { AGGREGATORS } from '../config'
import { collateralInLoan, dropToLiquidation, morphoHf, morphoLeverage, repayForMorphoLeverage } from '../lib/morpho'
import { REPAY_ALL, closeAction, encodeAction, executeMorpho, morphoOutcomeLines, readMorphoOutcome, type MorphoClosePlan } from '../lib/morphoExecute'
import { useQuote } from '../lib/useQuote'
import { useDebounced } from '../lib/useDebounced'
import { getQuote, quoteLabel } from '../lib/quotes'
import { daysToMaturity, isExpired } from '../lib/pendle'
import { collateralToSellForRepay, roundSignificant, toBase } from '../lib/math'
import { swapLoss, swapLossProblem } from '../lib/economics'
import { explainError } from '../lib/execute'
import { fmtBps, fmtAmount, fmtDate, fmtHf, fmtPct, fmtUsd, fmtX, ptShortSymbol } from '../lib/format'
import { isCorrelated } from '../lib/scan'
import { hfThresholds, hfTone } from '../lib/tone'
import { Card, Fold, LoopLayout, Metric, NA, Notice, QuoteCompare, Segmented, Steps, Summary, TxResult, aggregatorLabel } from './ui'
import type { MorphoCtx } from './MorphoView'

const SLIPPAGES = ['1', '10', '50', '100'] as const

export function MorphoClosePanel({ ctx }: { ctx: MorphoCtx }) {
  const { net, market: M, state, pt, sides, account } = ctx
  const C = M.collateral
  const L = M.loan
  const executor = net.executor
  const user = state.user
  const coll = user?.collateral ?? 0n
  const debt = user?.debt ?? 0n
  // target leverage of the position; 1 = close everything
  const [target, setTarget] = useState(1)
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('1')
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash; details?: string[] }>()

  const ptExpired = !!pt && isExpired(pt)
  const currentLev = coll > 0n ? morphoLeverage(coll, debt, state.price) : 1
  const sliderMax = Number.isFinite(currentLev) ? Math.max(1, Math.floor(currentLev * 20) / 20 - 0.05) : 1
  const full = target <= 1 || sliderMax <= 1
  const debouncedTarget = useDebounced(target)
  const value = collateralInLoan(coll, state.price)

  // full: the whole debt (by shares at execution), collateral sold to cover it with a margin; a matured PT is all
  // redeemed (nothing to hold any more). Partial: the repayment that brings the leverage down, and what covers it.
  const repay = full ? debt : roundSignificant(repayForMorphoLeverage(value, debt, BigInt(Math.round(debouncedTarget * 10_000))), 5)
  const needed = repay > 0n ? collateralToSellForRepay(repay, 0n, BigInt(slippage), sides.collateral, sides.loan) : 0n
  const sell = full && ptExpired ? coll : roundSignificant(needed > coll ? coll : needed, 6) + (needed > 0n ? 1n : 0n)
  const toSell = sell > coll ? coll : sell
  const withdraw = full ? coll : toSell

  const quoteReq =
    toSell > 0n
      ? {
          aggregator: ctx.aggregator,
          chainId: net.chain.id,
          sell: C,
          buy: L,
          sellAmount: toSell,
          taker: net.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: sides.collateral, buy: sides.loan },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = quote.data

  if (coll === 0n)
    return (
      // a full close lands here: its confirmation stays visible under the button
      <LoopLayout
        summary={
          <Summary
            items={[
              { label: 'Dette remboursée', value: NA },
              { label: 'Health factor après', value: NA, key: true },
              { label: 'Rendu', value: NA },
            ]}
            action={
              <button className="btn primary" disabled>
                Fermer la position
              </button>
            }
            reason={account ? 'Aucune position à fermer' : 'Connecter le portefeuille'}
          >
            <TxResult market={net} result={result?.ok ? result : undefined} />
          </Summary>
        }
      >
        {ctx.head}
        <Card title="Fermer ou réduire">
          <p className="muted">
            {account
              ? `Aucune position ${ptShortSymbol(C.symbol)} / ${L.symbol} sur ce marché Morpho pour cette adresse. Pour en ouvrir une : onglet « Ouvrir / augmenter ».`
              : `Portefeuille non connecté : la position ${ptShortSymbol(C.symbol)} / ${L.symbol} n’est pas lisible.`}
          </p>
        </Card>
      </LoopLayout>
    )

  const collAfter = coll - withdraw
  const debtAfter = full ? 0n : debt - repay
  const hfAfter = morphoHf(collAfter, debtAfter, state.price, M.params.lltv)
  const correlated = isCorrelated({ price: sides.collateral.price, token: C }, { price: sides.loan.price, token: L })
  const loanBack = q ? (q.buyAmount > repay ? q.buyAmount - repay : 0n) : undefined
  const loanBackMin = q ? (q.minOut > repay ? q.minOut - repay : 0n) : undefined

  const problems: string[] = []
  if (q && q.minOut < repay)
    problems.push(`Le minimum du devis (${fmtAmount(q.minOut, L.decimals)} ${L.symbol}) ne couvre pas la dette remboursée : augmenter le slippage ou recoter.`)
  if (!full && hfAfter < 1) problems.push('La réduction laisserait la position sous le LLTV.')
  const warnings: string[] = []
  const lossIssue = q && swapLossProblem(swapLoss(q.sellAmount, sides.collateral, q.buyAmount, sides.loan), C.symbol, L.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (pt && !ptExpired && full)
    warnings.push(`${C.symbol} n’est pas encore échu (${fmtDate(pt.expiry)}) : le vendre avant l’échéance passe par le marché Pendle, au prix du moment.`)
  if (!full && Number.isFinite(hfAfter) && hfAfter < hfThresholds(correlated).ok)
    warnings.push(`Health factor après réduction ${fmtHf(hfAfter)} : encore proche de la liquidation.`)

  const plan = (fresh = q): MorphoClosePlan | undefined =>
    executor && account && coll > 0n
      ? {
          net,
          executor,
          user: account,
          authorized: !!user?.authorized,
          minHealthFactor: full ? 0n : BigInt(Math.floor(Math.min(hfAfter, 1e6) * 0.98 * 1e6)) * 10n ** 12n,
          market: M.params,
          repayAmount: full ? REPAY_ALL : repay,
          collateralToWithdraw: full ? REPAY_ALL : withdraw,
          collateralToSell: toSell,
          quote: fresh,
        }
      : undefined
  const preview = (() => {
    try {
      const p = plan()
      return p && (q || toSell === 0n) ? encodeAction(closeAction(p)) : undefined
    } catch {
      return undefined
    }
  })()
  const stale = quote.isFetching || target !== debouncedTarget
  const canSign = !!executor && !!account && (toSell === 0n || (!!q && !q.simulated)) && !!preview && problems.length === 0 && !stale && !busy
  const disabledReason = !executor
    ? 'Contrat pas encore déployé'
    : !account
      ? 'Connecter le portefeuille'
      : q?.simulated
        ? 'Devis simulé'
        : problems.length
          ? 'Bloqué : voir le bandeau rouge'
          : undefined

  async function onClose() {
    setResult(undefined)
    try {
      let fresh = q
      if (quoteReq) {
        setBusy('Nouvelle cotation…')
        fresh = await getQuote(quoteReq)
        if (fresh.simulated) throw new Error('Plus de devis réel disponible')
        if (fresh.minOut < repay) throw new Error('Le nouveau devis ne couvre plus la dette : recoter')
      }
      const p = plan(fresh)!
      const hash = await executeMorpho(p, closeAction(p), { batch: ctx.batch, nonce: user?.nonce ?? 0n }, setBusy)
      const outcome = await readMorphoOutcome(net.chain.id, hash, p.executor, p.user)
      setResult({ ok: true, text: full ? 'Position fermée.' : 'Position réduite.', hash, details: outcome && morphoOutcomeLines(outcome, C, L) })
      ctx.onDone()
    } catch (e) {
      setResult({ ok: false, text: explainError(e) })
    } finally {
      setBusy(undefined)
    }
  }

  const authorized = !!user?.authorized
  const steps = ctx.batch
    ? [
        ...(authorized ? [] : [{ label: 'Autoriser le contrat sur Morpho, le temps du lot' }]),
        { label: 'Fermer : flash loan Morpho, remboursement, retrait et swap' },
        ...(authorized ? [] : [{ label: 'Retirer l’autorisation Morpho' }]),
      ]
    : [
        ...(authorized
          ? []
          : [{ label: 'Signer deux messages Morpho (sans gas) : autoriser le contrat pour cette transaction, puis retirer cette autorisation' }]),
        { label: 'Signer la transaction : flash loan, remboursement, retrait et swap en une fois' },
      ]

  const back = [
    ...(full && coll - toSell > 0n ? [`${fmtAmount(coll - toSell, C.decimals)} ${ptShortSymbol(C.symbol)}`] : []),
    ...(loanBack !== undefined && loanBack > 0n ? [`${fmtAmount(loanBack, L.decimals)} ${L.symbol}`] : []),
  ]
  const summary = (
    <Summary
      items={[
        { label: 'Dette remboursée', value: `${fmtAmount(repay, L.decimals)} ${L.symbol}`, sub: full ? 'toute la dette, intérêts compris' : undefined },
        {
          label: 'Health factor après',
          value: fmtHf(hfAfter),
          sub: Number.isFinite(hfAfter) ? `liquidation si baisse de ${fmtPct(dropToLiquidation(hfAfter), 1)}` : 'plus de dette',
          tone: hfTone(hfAfter, correlated),
          key: true,
        },
        {
          label: 'Rendu',
          value: q || toSell === 0n ? (back.length ? back.join(' + ') : '—') : undefined,
          sub: loanBackMin !== undefined && loanBackMin !== loanBack ? `au moins ${fmtAmount(loanBackMin, L.decimals)} ${L.symbol}` : undefined,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onClose} title={disabledReason}>
          {busy ?? (stale ? 'Cotation…' : full ? 'Fermer la position' : 'Réduire le levier')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={net} result={result} />
    </Summary>
  )

  return (
    <LoopLayout summary={summary}>
      {ctx.head}
      <Card title={full ? 'Fermer la position' : 'Réduire le levier'}>
        <p className="muted small">
          Position : {fmtAmount(coll, C.decimals)} {ptShortSymbol(C.symbol)} ({fmtUsd(toBase(coll, sides.collateral))}), dette {fmtAmount(debt, L.decimals)}{' '}
          {L.symbol}, levier {fmtX(currentLev)}, health factor {fmtHf(morphoHf(coll, debt, state.price, M.params.lltv))}.
          {pt && ` ${ptExpired ? 'PT échu : racheté en totalité.' : `Échéance le ${fmtDate(pt.expiry)} (${Math.floor(daysToMaturity(pt))} j).`}`}
        </p>
        {sliderMax > 1 && (
          <label className="field">
            <span>
              Levier visé <strong className="lev">{full ? 'fermeture' : fmtX(target)}</strong>
            </span>
            <input type="range" min={1} max={sliderMax} step={0.05} value={Math.min(target, sliderMax)} onChange={(e) => setTarget(Number(e.target.value))} />
          </label>
        )}
        <div className="metrics">
          <Metric label="Collatéral vendu" value={`${fmtAmount(toSell, C.decimals)} ${ptShortSymbol(C.symbol)}`} sub={q ? `via ${quoteLabel(q)}` : undefined} />
          <Metric label="Collatéral retiré" value={`${fmtAmount(withdraw, C.decimals)} ${ptShortSymbol(C.symbol)}`} sub={full ? 'tout' : 'autant que vendu'} />
          <Metric label="Flash loan" value="gratuit" sub="Morpho Blue" />
        </div>
        {quote.isError && <Notice tone="bad">Cotation impossible : {(quote.error as Error).message}</Notice>}
        {problems.map((p) => (
          <Notice key={p} tone="bad">
            {p}
          </Notice>
        ))}
        {warnings.map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}
        <Fold title="Réglages" value={`${aggregatorLabel(ctx.aggregator)} · slippage ${fmtBps(slippage)}`}>
          {ctx.common}
          <div className="field">
            <span>Slippage max</span>
            <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtBps(s) }))} />
          </div>
        </Fold>
        {q && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(q.minOut, L.decimals)} ${L.symbol}`}>
            <QuoteCompare quote={q} token={L} />
            {q.route && (
              <p className="small">
                Route : {q.route.map((l) => `${l.sell.symbol} → ${l.buy.symbol} (${l.via === 'pendle' ? 'Pendle' : AGGREGATORS[l.via].label})`).join(', ')}.
              </p>
            )}
            {preview && (
              <dl className="preview">
                <dt>Contrat</dt>
                <dd>{executor}</dd>
                <dt>Calldata close()</dt>
                <dd className="mono">{preview}</dd>
              </dl>
            )}
          </Fold>
        )}
        <Fold title="Étapes" value={ctx.batch ? 'une seule confirmation' : `${steps.length} étape${steps.length > 1 ? 's' : ''}`}>
          <Steps steps={steps} />
        </Fold>
      </Card>
    </LoopLayout>
  )
}
