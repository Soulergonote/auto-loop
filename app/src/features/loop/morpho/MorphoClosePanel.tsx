import { dropToLiquidation, morphoHf } from '../../../protocols/morpho/markets'
import {
  REPAY_ALL,
  closeAction,
  encodeAction,
  executeMorpho,
  morphoOutcomeLines,
  readMorphoOutcome,
  type MorphoClosePlan,
} from '../../../protocols/morpho/execute'
import { getQuote, quoteLabel } from '../../../services/quotes/quotes'
import { daysToMaturity, isExpired } from '../../../protocols/pendle/pt'
import { toBase } from '../../../domain/math'
import { swapLoss, swapLossProblem } from '../../../domain/economics'
import { fmtAmount, fmtDate, fmtHf, fmtPct, fmtUsd, fmtX, ptShortSymbol } from '../../../ui/format'
import { isCorrelated } from '../../../domain/pairs'
import { hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LeverageSlider, LoopLayout, Metric, NA, QuoteCompare, Summary, TxResult } from '../../../ui/primitives'
import type { MorphoCtx } from './MorphoView'
import { pairKind, useSlippage } from '../../../domain/slippage'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { QuoteRoute, SettingsFold, SlippageField, StepsFold } from '../shared/folds'
import { useCloseSizing } from '../shared/useCloseSizing'

export function MorphoClosePanel({ ctx, seedTarget }: { ctx: MorphoCtx; seedTarget?: number }) {
  const { net, market: M, state, pt, sides, account } = ctx
  const C = M.collateral
  const L = M.loan
  const executor = net.executor
  const user = state.user
  const coll = user?.collateral ?? 0n
  const debt = user?.debt ?? 0n
  const {
    slippage,
    setSlippage,
    auto: autoSlip,
  } = useSlippage(pairKind({ symbol: C.symbol, usd: M.collateralUsd }, { symbol: L.symbol, usd: M.loanUsd }, { pt: !!pt }))
  const { busy, setBusy, result, setResult, run } = useTxAction()
  // a matured PT is all redeemed on a full close (nothing to hold any more)
  const ptExpired = !!pt && isExpired(pt)
  const { target, setTarget, currentLev, sliderMax, full, repay, toSell, withdraw, quoteReq, quote, q, stale } = useCloseSizing({
    coll,
    debt,
    price: state.price,
    sides,
    slippage,
    seedTarget,
    sellAllOnFull: ptExpired,
    swap: { aggregator: ctx.aggregator, chainId: net.chain.id, sell: C, buy: L, taker: net.quoteTaker },
  })

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
            needs="wallet"
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
              ? `Aucune position ${ptShortSymbol(C.symbol)} / ${L.symbol} sur ce marché Morpho pour cette adresse. Pour en ouvrir une : onglet « Ouvrir / augmenter » ; toutes les positions de l’adresse : onglet Positions.`
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
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
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
  const canSign = !!executor && !!account && (toSell === 0n || (!!q && !q.simulated)) && !!preview && problems.length === 0 && !stale && !busy
  const disabledReason = signBlocker({ executor, account, simulated: q?.simulated, problems })

  async function onClose() {
    await run(async () => {
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
    })
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
      <TxResult market={net} result={result} retry={{ current: slippage, set: setSlippage }} />
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
          <LeverageSlider
            label="Levier visé"
            value={Math.min(target, sliderMax)}
            min={1}
            max={sliderMax}
            onChange={setTarget}
            aside={full ? 'tout fermer' : undefined}
            floor={`${fmtX(1)} : tout fermer`}
          />
        )}
        <div className="metrics">
          <Metric label="Collatéral vendu" value={`${fmtAmount(toSell, C.decimals)} ${ptShortSymbol(C.symbol)}`} sub={q ? `via ${quoteLabel(q)}` : undefined} />
          <Metric label="Collatéral retiré" value={`${fmtAmount(withdraw, C.decimals)} ${ptShortSymbol(C.symbol)}`} sub={full ? 'tout' : 'autant que vendu'} />
          <Metric label="Flash loan" value="gratuit" sub="Morpho Blue" />
        </div>
        <Banners problems={problems} warnings={warnings} />
        <SettingsFold aggregator={ctx.aggregator} slippage={slippage} auto={autoSlip}>
          {ctx.common}
          <SlippageField slippage={slippage} setSlippage={setSlippage} />
        </SettingsFold>
        {q && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(q.minOut, L.decimals)} ${L.symbol}`}>
            <QuoteCompare quote={q} token={L} />
            <QuoteRoute quote={q} />
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
        <StepsFold steps={steps} batch={ctx.batch} />
      </Card>
    </LoopLayout>
  )
}
