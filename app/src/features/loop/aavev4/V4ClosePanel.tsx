import { dropToLiquidation, morphoHf } from '../../../protocols/morpho/markets'
import { V4_ALL, encodeV4Action, executeV4Close, readV4Outcome, v4CloseAction, v4OutcomeLines, type V4ClosePlan } from '../../../protocols/aavev4/execute'
import { getQuote, quoteLabel } from '../../../services/quotes/quotes'
import { toBase } from '../../../domain/math'
import { swapLoss, swapLossProblem } from '../../../domain/economics'
import { fmtAmount, fmtHf, fmtPct, fmtUsd, fmtX } from '../../../ui/format'
import { isCorrelated } from '../../../domain/pairs'
import { hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LeverageSlider, LoopLayout, Metric, NA, QuoteCompare, Summary, TxResult } from '../../../ui/primitives'
import type { V4Ctx } from './V4View'
import { pairKind, useSlippage } from '../../../domain/slippage'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { v4SetupOf, v4SetupSteps } from './setup'
import { QuoteRoute, SettingsFold, SlippageField, StepsFold } from '../shared/folds'
import { useCloseSizing } from '../shared/useCloseSizing'

export function V4ClosePanel({ ctx, seedTarget }: { ctx: V4Ctx; seedTarget?: number }) {
  const { net, pair, state, sides, account } = ctx
  const C = pair.collateral.token
  const L = pair.debt.token
  const executor = net.executor
  const user = state.user
  const coll = user?.collateral ?? 0n
  const debt = user?.debt ?? 0n
  const usdOf = (price: bigint) => Number(price) / 1e8
  const {
    slippage,
    setSlippage,
    auto: autoSlip,
  } = useSlippage(pairKind({ symbol: C.symbol, usd: usdOf(state.collateralPrice) }, { symbol: L.symbol, usd: usdOf(state.debtPrice) }))
  const tx = useTxAction()
  const { busy, setBusy, result, setResult, run } = tx
  const { target, setTarget, currentLev, sliderMax, full, repay, toSell, withdraw, quoteReq, quote, q, stale } = useCloseSizing({
    coll,
    debt,
    price: state.price,
    sides,
    slippage,
    seedTarget,
    swap: { aggregator: ctx.aggregator, chainId: net.chain.id, sell: C, buy: L, taker: net.quoteTaker },
  })

  if (coll === 0n)
    return (
      // a full close lands here: its confirmation stays visible under the button
      <LoopLayout
        summary={
          <Summary
            tx={tx}
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
              ? `Aucun dépôt ${C.symbol} dans le spoke ${pair.collateral.spoke.name} pour cette adresse. Pour ouvrir une position : onglet « Ouvrir / augmenter » ; toutes les positions de l’adresse : onglet Positions.`
              : `Portefeuille non connecté : la position ${C.symbol} / ${L.symbol} n’est pas lisible.`}
          </p>
        </Card>
      </LoopLayout>
    )

  const others = !!user?.otherPositions
  const collAfter = coll - withdraw
  const debtAfter = full ? 0n : debt - repay
  const hfAfter = morphoHf(collAfter, debtAfter, state.price, state.lltv)
  const correlated = isCorrelated({ price: sides.collateral.price, token: C }, { price: sides.loan.price, token: L })
  const loanBack = q ? (q.buyAmount > repay ? q.buyAmount - repay : 0n) : undefined
  const loanBackMin = q ? (q.minOut > repay ? q.minOut - repay : 0n) : undefined

  const problems: string[] = []
  if (q && q.minOut < repay)
    problems.push(`Le minimum du devis (${fmtAmount(q.minOut, L.decimals)} ${L.symbol}) ne couvre pas la dette remboursée : augmenter le slippage ou recoter.`)
  if (!full && hfAfter < 1) problems.push('La réduction laisserait la position sous le seuil de liquidation.')
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  if (repay > state.flashLiquidity)
    problems.push(
      `Flash loan trop grand : Morpho Blue ne détient que ${fmtAmount(state.flashLiquidity, L.decimals)} ${L.symbol} sur ce réseau, pour ${fmtAmount(repay, L.decimals)} à avancer. Réduire d’abord le levier par étapes.`,
    )
  const warnings: string[] = []
  const lossIssue = q && swapLossProblem(swapLoss(q.sellAmount, sides.collateral, q.buyAmount, sides.loan), C.symbol, L.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (full && others)
    warnings.push(
      `Ce compte a d’autres positions dans ce spoke : tout le ${C.symbol} est retiré, ce qu’Aave refuse si les dettes restantes ne sont plus assez garanties.`,
    )
  if (!full && !others && Number.isFinite(hfAfter) && hfAfter < hfThresholds(correlated).ok)
    warnings.push(`Health factor après réduction ${fmtHf(hfAfter)} : encore proche de la liquidation.`)

  const plan = (fresh = q): V4ClosePlan | undefined =>
    executor && account && coll > 0n
      ? {
          net,
          executor,
          user: account,
          spoke: pair.collateral.spoke.address,
          collateralId: pair.collateral.reserveId,
          debtId: pair.debt.reserveId,
          collateralToken: C.address,
          debtToken: L.address,
          // the contract checks the account's health factor: with other positions, only the spoke's own rule applies
          minHealthFactor: full || others ? 0n : BigInt(Math.floor(Math.min(hfAfter, 1e6) * 0.98 * 1e6)) * 10n ** 12n,
          setup: v4SetupOf(user),
          repayAmount: full ? V4_ALL : repay,
          collateralToWithdraw: full ? V4_ALL : withdraw,
          collateralToSell: toSell,
          quote: fresh,
          withdrawAllowance: user?.withdrawAllowance ?? 0n,
        }
      : undefined
  const preview = (() => {
    try {
      const p = plan()
      return p && (q || toSell === 0n) ? encodeV4Action(v4CloseAction(p)) : undefined
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
      const hash = await executeV4Close(p, { batch: ctx.batch, nonce: user?.permitNonce ?? 0n, permit: ctx.permit }, setBusy)
      const outcome = await readV4Outcome(net.chain.id, hash, p.executor, p.user)
      setResult({ ok: true, text: full ? 'Position fermée.' : 'Position réduite.', hash, details: outcome && v4OutcomeLines(outcome, C, L) })
      ctx.onDone()
    })
  }

  const needsWithdraw = (user?.withdrawAllowance ?? 0n) < (full ? V4_ALL : withdraw)
  const setupSteps = v4SetupSteps(v4SetupOf(user), ctx.batch, { collateral: false })
  const steps = ctx.batch
    ? [
        ...setupSteps,
        ...(needsWithdraw ? [{ label: 'Autoriser le contrat à retirer le collatéral, le temps du lot' }] : []),
        { label: 'Fermer : flash loan Morpho, remboursement, retrait et swap' },
        ...(needsWithdraw ? [{ label: 'Remettre l’autorisation de retrait à sa valeur' }] : []),
      ]
    : [
        ...setupSteps,
        ...(needsWithdraw
          ? [
              {
                label: ctx.permit
                  ? 'Signer un message (sans gas) : autoriser le contrat à retirer le collatéral, pour cette transaction seulement'
                  : 'Autoriser le contrat à retirer le collatéral (transaction)',
              },
            ]
          : []),
        { label: 'Signer la transaction : flash loan, remboursement, retrait et swap en une fois' },
        ...(needsWithdraw && !ctx.permit ? [{ label: 'Retirer l’autorisation de retrait (transaction)' }] : []),
      ]

  const back = [
    ...(full && coll - toSell > 0n ? [`${fmtAmount(coll - toSell, C.decimals)} ${C.symbol}`] : []),
    ...(loanBack !== undefined && loanBack > 0n ? [`${fmtAmount(loanBack, L.decimals)} ${L.symbol}`] : []),
  ]
  const summary = (
    <Summary
      tx={tx}
      items={[
        { label: 'Dette remboursée', value: `${fmtAmount(repay, L.decimals)} ${L.symbol}`, sub: full ? 'toute la dette, intérêts compris' : undefined },
        {
          label: 'Health factor après',
          value: others ? NA : fmtHf(hfAfter),
          sub: others
            ? 'd’autres positions comptent dans ce spoke'
            : Number.isFinite(hfAfter)
              ? `liquidation si baisse de ${fmtPct(dropToLiquidation(hfAfter), 1)}`
              : 'plus de dette',
          tone: others ? undefined : hfTone(hfAfter, correlated),
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
          Position : {fmtAmount(coll, C.decimals)} {C.symbol} ({fmtUsd(toBase(coll, sides.collateral))}), dette {fmtAmount(debt, L.decimals)} {L.symbol}, levier{' '}
          {fmtX(currentLev)}, health factor du compte {fmtHf(user?.healthFactor ?? Infinity)}
          {user && user.riskPremium > 0 && `, prime de risque ${fmtPct(user.riskPremium, 1)} du taux de base`}.
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
          <Metric label="Collatéral vendu" value={`${fmtAmount(toSell, C.decimals)} ${C.symbol}`} sub={q ? `via ${quoteLabel(q)}` : undefined} />
          <Metric label="Collatéral retiré" value={`${fmtAmount(withdraw, C.decimals)} ${C.symbol}`} sub={full ? 'tout' : 'autant que vendu'} />
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
