import { useMemo, useState } from 'react'
import { parseUnits } from 'viem'
import { QUOTE_MODE } from '../../../config'
import {
  collateralInLoan,
  debtForMorphoLeverage,
  dropToLiquidation,
  leverageAtMorphoHf,
  maxMorphoLeverage,
  morphoHf,
  morphoLeverage,
} from '../../../protocols/morpho/markets'
import { encodeV4Action, executeV4Open, readV4Outcome, v4OpenAction, v4OutcomeLines, type V4OpenPlan } from '../../../protocols/aavev4/execute'
import { v4EndingRewards } from '../../../protocols/aavev4/reserves'
import { useQuote } from '../../../services/quotes/useQuote'
import { useDebounced } from '../../../ui/useDebounced'
import { getQuote, quoteLabel } from '../../../services/quotes/quotes'
import { roundSignificant, toBase } from '../../../domain/math'
import { GAS_UNITS_PT, breakEvenDays, horizonApy, loopCosts, swapCostBase, swapLoss, swapLossProblem } from '../../../domain/economics'
import { fmtAmount, fmtBonusEnd, fmtDays, fmtHf, fmtLltv, fmtPct, fmtPrice, fmtUsd, fmtX } from '../../../ui/format'
import { isCorrelated } from '../../../domain/pairs'
import { exitIssues, exitSellAmount } from '../../../domain/exitCheck'
import { apyTone, hfThresholds, hfTone } from '../../../ui/tone'
import { RiskPanel } from '../shared/RiskPanel'
import { PositionBar } from '../../../ui/PositionBar'
import { projectHealthFactor } from '../../../domain/projection'
import { ApyBreakdown } from '../shared/ApyBreakdown'
import { useRiskSignals } from '../shared/RiskSignals'
import { Banners, Card, Fold, LeverageSlider, LoopLayout, Metric, NA, QuoteCompare, Summary, TxResult } from '../../../ui/primitives'
import type { V4Ctx } from './V4View'
import { pairKind, useSlippage } from '../../../domain/slippage'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { CapitalField, SlippageHorizonFields, YieldMetrics } from '../shared/OpenFields'
import { defaultCapital, v4SetupOf, v4SetupSteps } from './setup'
import { QuoteRoute, SettingsFold, StepsFold } from '../shared/folds'

/** The slider stops at this health factor: the spoke liquidates at 1. */
const SLIDER_MIN_HF = 1.02
const MAX_SLIDER = 15

export function V4OpenPanel({ ctx, seedLeverage, seedAmount }: { ctx: V4Ctx; seedLeverage?: number; seedAmount?: string }) {
  const { net, pair, state, sides, account } = ctx
  const C = pair.collateral.token
  const L = pair.debt.token
  const cf = pair.collateral.collateralFactor
  const executor = net.executor
  const user = state.user
  const [capitalIsLoan, setCapitalIsLoan] = useState(false)
  const K = capitalIsLoan ? L : C
  const capSide = capitalIsLoan ? sides.loan : sides.collateral
  const capBalance = capitalIsLoan ? user?.debtBalance : user?.collateralBalance
  const capAllowance = capitalIsLoan ? (user?.debtAllowance ?? 0n) : (user?.collateralAllowance ?? 0n)
  // starts near 1 000 $ of collateral, whatever the token is worth
  const [amountText, setAmountText] = useState(() => seedAmount ?? defaultCapital(Number(state.collateralPrice) / 1e8))
  const [leverage, setLeverage] = useState(seedLeverage ? Math.floor(seedLeverage * 20) / 20 : 3)
  const usdOf = (price: bigint) => Number(price) / 1e8
  const {
    slippage,
    setSlippage,
    auto: autoSlip,
  } = useSlippage(pairKind({ symbol: C.symbol, usd: usdOf(state.collateralPrice) }, { symbol: L.symbol, usd: usdOf(state.debtPrice) }))
  const [horizonText, setHorizon] = useState('90')
  const tx = useTxAction()
  const { busy, setBusy, result, setResult, run } = tx
  const horizon = Number(horizonText)

  // the existing position on this pair: the slider sets the leverage of the whole position
  const coll0 = user?.collateral ?? 0n
  const debt0 = user?.debt ?? 0n
  const hasPosition = coll0 > 0n
  const currentLev = hasPosition ? morphoLeverage(coll0, debt0, state.price) : 1
  const maxLev = maxMorphoLeverage(cf)
  const sliderMax = Math.max(1.1, Math.min(Math.floor(leverageAtMorphoHf(cf, SLIDER_MIN_HF) * 20) / 20, MAX_SLIDER))
  const sliderMin = hasPosition && Number.isFinite(currentLev) ? Math.min(sliderMax, Math.max(1.1, Math.ceil(currentLev * 20) / 20)) : 1.1
  const lev = Math.max(sliderMin, Math.min(leverage, sliderMax))
  const augment = hasPosition && debt0 > 0n

  const initial = useMemo(() => {
    try {
      return parseUnits(amountText.replace(',', '.') || '0', K.decimals)
    } catch {
      return undefined
    }
  }, [amountText, K.decimals])
  const debouncedInitial = useDebounced(initial)
  const debouncedLevBps = useDebounced(BigInt(Math.round(lev * 10_000)))

  // capital and position in debt units at the oracle price; rounded so that interest does not re-quote every block
  const capitalLoan = debouncedInitial === undefined ? undefined : capitalIsLoan ? debouncedInitial : collateralInLoan(debouncedInitial, state.price)
  const debtAmount =
    capitalLoan !== undefined ? roundSignificant(debtForMorphoLeverage(collateralInLoan(coll0, state.price), debt0, capitalLoan, debouncedLevBps), 5) : 0n
  const sold = debtAmount + (capitalIsLoan ? (debouncedInitial ?? 0n) : 0n)
  const quoteReq =
    sold > 0n
      ? {
          aggregator: ctx.aggregator,
          chainId: net.chain.id,
          sell: L,
          buy: C,
          sellAmount: sold,
          taker: net.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: sides.loan, buy: sides.collateral },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = quote.data
  const capColl = capitalIsLoan ? 0n : (debouncedInitial ?? 0n)

  // what a full close would sell to repay the whole debt is quoted against the debt token before opening
  const exitSell = q ? exitSellAmount(toBase(debt0 + debtAmount, sides.loan), sides.collateral) : 0n
  const exitReq =
    exitSell > 0n && QUOTE_MODE !== 'mock'
      ? {
          aggregator: ctx.aggregator,
          chainId: net.chain.id,
          sell: C,
          buy: L,
          sellAmount: exitSell,
          taker: net.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: sides.collateral, buy: sides.loan },
        }
      : undefined
  const exitQuote = useQuote(exitReq)
  const exitPending = !!exitReq && !exitQuote.data && !exitQuote.isError
  const exitRead =
    exitReq && !exitPending
      ? {
          noRoute: exitQuote.isError || !!exitQuote.data?.simulated,
          loss:
            exitQuote.data && !exitQuote.data.simulated
              ? swapLoss(exitQuote.data.sellAmount, sides.collateral, exitQuote.data.buyAmount, sides.loan)
              : undefined,
        }
      : undefined
  const exit = exitRead
    ? exitIssues({
        sell: C.symbol,
        buy: L.symbol,
        ...exitRead,
        reason: exitQuote.isError ? (exitQuote.error as Error).message : exitQuote.data?.fallbackReason,
      })
    : undefined

  const supplied = q ? capColl + q.buyAmount : undefined
  const newColl = q ? coll0 + capColl + q.buyAmount : undefined
  const newCollMin = q ? coll0 + capColl + q.minOut : undefined
  const newDebt = debt0 + debtAmount
  const hf = newColl !== undefined ? morphoHf(newColl, newDebt, state.price, state.lltv) : undefined
  const worstHf = newCollMin !== undefined ? morphoHf(newCollMin, newDebt, state.price, state.lltv) : undefined
  const loopLev = newColl !== undefined ? morphoLeverage(newColl, newDebt, state.price) : undefined
  const finite = loopLev !== undefined && Number.isFinite(loopLev)
  const rewards = finite ? ctx.supplyRewardApy * loopLev + ctx.borrowRewardApy * (loopLev - 1) : 0
  const apy = finite ? ctx.collateralApy * loopLev - ctx.borrowApy * (loopLev - 1) + rewards : undefined
  // A5: what is left once the rewards with a known end are over
  const ending = finite ? v4EndingRewards(ctx.pair.collateral, ctx.pair.debt, loopLev) : undefined
  const bonusEnd = ending?.endsAt !== undefined && apy !== undefined ? `, ${fmtBonusEnd(ending.endsAt, apy - ending.apy)}` : ''
  const correlated = isCorrelated({ price: sides.collateral.price, token: C }, { price: sides.loan.price, token: L })
  const signals = useRiskSignals({
    chainId: net.chain.id,
    collateral: C,
    debt: L,
    correlated,
    oracleRatio: Number(sides.collateral.price) / Number(sides.loan.price),
    exit: exitRead,
  })

  const problems: string[] = []
  if (initial === undefined) problems.push('Montant invalide.')
  else if (initial === 0n && !hasPosition) problems.push('Capital à déposer manquant.')
  else if (hasPosition && debtAmount === 0n && initial === debouncedInitial && BigInt(Math.round(lev * 10_000)) === debouncedLevBps && !capitalIsLoan)
    problems.push('Le levier visé ne dépasse pas le levier actuel. Pour le réduire : onglet « Fermer / réduire ».')
  if (user && initial && capBalance !== undefined && initial > capBalance) problems.push(`Solde ${K.symbol} insuffisant.`)
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  const overBorrow = debtAmount > state.borrowable
  const overFlash = debtAmount > state.flashLiquidity
  if (overBorrow)
    problems.push(
      `Liquidité du spoke insuffisante : ${fmtAmount(state.borrowable, L.decimals)} ${L.symbol} empruntables pour ${fmtAmount(debtAmount, L.decimals)} demandés.`,
    )
  else if (overFlash)
    problems.push(
      `Flash loan trop grand : Morpho Blue ne détient que ${fmtAmount(state.flashLiquidity, L.decimals)} ${L.symbol} sur ce réseau, pour ${fmtAmount(debtAmount, L.decimals)} à avancer. Baisser le levier ou le capital.`,
    )
  if (supplied !== undefined && supplied > state.suppliable)
    problems.push(
      `Plafond de dépôt du collatéral atteint : ${fmtAmount(state.suppliable, C.decimals)} ${C.symbol} encore acceptés pour ${fmtAmount(supplied, C.decimals)} à déposer.`,
    )
  if (worstHf !== undefined && worstHf < 1)
    problems.push(`Health factor projeté ${fmtHf(worstHf)} : au-delà du seuil du collatéral, Aave refuse l’emprunt. Baisser le levier.`)
  if (exit) problems.push(...exit.problems)
  const warnings: string[] = []
  const lossIssue = q && swapLossProblem(swapLoss(q.sellAmount, sides.loan, q.buyAmount, sides.collateral), L.symbol, C.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (exit) warnings.push(...exit.warnings)
  // an input Aave would refuse: values derived from it would be meaningless, they show a dash
  const unreal = (worstHf !== undefined && worstHf < 1) || overBorrow || overFlash || !!lossIssue?.block
  if (ctx.collateralApy === 0) warnings.push(`Aucun rendement connu pour ${C.symbol} : l’APY ne compte que le coût de l’emprunt.`)
  if (hf !== undefined && !unreal && hf < hfThresholds(correlated).ok)
    warnings.push(
      `Health factor ${fmtHf(hf)} : une baisse de ${fmtPct(dropToLiquidation(hf), 1)} de ${C.symbol} face à ${L.symbol} à l’oracle suffit à liquider la position.`,
    )
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (debtAmount > 0n && !overBorrow && debtAmount * 10n > state.borrowable * 9n)
    warnings.push('L’emprunt prend presque toute la liquidité du spoke : son taux va monter fortement.')

  const soldBase = toBase(debtAmount, sides.loan)
  const capitalBase = (debouncedInitial !== undefined ? toBase(debouncedInitial, capSide) : 0n) + toBase(coll0, sides.collateral) - toBase(debt0, sides.loan)
  const costs = q
    ? loopCosts({
        entrySoldBase: toBase(q.sellAmount, sides.loan),
        entrySwapBase: swapCostBase(q.sellAmount, sides.loan, q.buyAmount, sides.collateral),
        debtBase: soldBase,
        // Morpho's flash loans are free
        premiumBps: 0n,
        gasUnits: GAS_UNITS_PT.open + GAS_UNITS_PT.close,
        freeExit: false,
      })
    : undefined
  const horizonYield =
    costs && apy !== undefined && capitalBase > 0n
      ? horizonApy({ equityBase: capitalBase, ratesApy: apy, rewardsApy: 0, costsBase: costs.total, days: horizon })
      : undefined
  const breakEven = costs && apy !== undefined ? breakEvenDays(capitalBase, apy, costs.total) : undefined
  const horizonGain = horizonYield !== undefined && Number.isFinite(horizonYield) ? ((Number(capitalBase) / 1e8) * horizonYield * horizon) / 365 : undefined
  const effectiveLev = !unreal && finite && Math.abs(loopLev - lev) >= 0.05 ? loopLev : undefined
  if (costs && horizonYield !== undefined && horizonYield < 0 && apy !== undefined && apy > 0)
    warnings.push(`Les coûts (${fmtUsd(costs.total)}) dépassent le rendement sur ${fmtDays(horizon)} avec ce capital. Augmenter le capital ou la durée.`)

  const setup = v4SetupOf(user)
  // the contract checks the account's health factor: with other positions in the spoke, only the spoke's own rule applies
  const guardHf = user?.otherPositions || worstHf === undefined || !Number.isFinite(worstHf) ? 0n : BigInt(Math.floor(worstHf * 0.98 * 1e6)) * 10n ** 12n
  const plan = (fresh = q): V4OpenPlan | undefined =>
    executor && account && initial !== undefined
      ? {
          net,
          executor,
          user: account,
          spoke: pair.collateral.spoke.address,
          collateralId: pair.collateral.reserveId,
          debtId: pair.debt.reserveId,
          collateralToken: C.address,
          debtToken: L.address,
          minHealthFactor: guardHf,
          setup,
          capitalToken: K.address,
          capitalAmount: debouncedInitial ?? 0n,
          capitalAllowance: capAllowance,
          debtAmount,
          quote: fresh,
          borrowAllowance: user?.borrowAllowance ?? 0n,
        }
      : undefined
  const preview = (() => {
    try {
      const p = plan()
      return p && q ? encodeV4Action(v4OpenAction(p)) : undefined
    } catch {
      return undefined
    }
  })()

  const stale = initial !== debouncedInitial || quote.isFetching
  const canSign = !!executor && !!account && !!q && !q.simulated && !!preview && problems.length === 0 && !stale && !busy && !exitPending
  const disabledReason = signBlocker({ executor, account, simulated: q?.simulated, problems, checkingExit: exitPending })

  async function onOpen() {
    await run(async () => {
      setBusy('Nouvelle cotation…')
      const fresh = await getQuote(quoteReq!)
      if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      const p = plan(fresh)!
      const hash = await executeV4Open(p, { batch: ctx.batch, nonce: user?.permitNonce ?? 0n, permit: ctx.permit }, setBusy)
      const outcome = await readV4Outcome(net.chain.id, hash, p.executor, p.user)
      setResult({ ok: true, text: augment ? 'Position augmentée.' : 'Position ouverte.', hash, details: outcome && v4OutcomeLines(outcome, C, L) })
      ctx.onDone()
    })
  }

  const needsApprove = !!initial && capAllowance < initial
  const needsBorrow = debtAmount > 0n && (user?.borrowAllowance ?? 0n) < debtAmount
  const setupSteps = v4SetupSteps(setup, ctx.batch)
  const steps = ctx.batch
    ? [
        ...setupSteps,
        ...(needsApprove ? [{ label: `Autoriser le contrat à prendre ${fmtAmount(initial ?? 0n, K.decimals)} ${K.symbol} (montant exact)` }] : []),
        ...(needsBorrow ? [{ label: `Autoriser le contrat à emprunter ${fmtAmount(debtAmount, L.decimals)} ${L.symbol} pour ce compte (montant exact)` }] : []),
        { label: 'Ouvrir : flash loan Morpho, swap, dépôt du collatéral et emprunt sur Aave v4' },
        ...(needsBorrow ? [{ label: 'Remettre l’autorisation d’emprunt à sa valeur' }] : []),
        ...(needsApprove ? [{ label: 'Remettre l’autorisation du capital à sa valeur' }] : []),
      ]
    : [
        ...setupSteps,
        ...(needsApprove ? [{ label: `Autoriser le contrat à prendre ${fmtAmount(initial ?? 0n, K.decimals)} ${K.symbol} (transaction)` }] : []),
        ...(needsBorrow
          ? [
              {
                label: ctx.permit
                  ? 'Signer un message (sans gas) : autoriser le contrat à emprunter ce montant, pour cette transaction seulement'
                  : `Autoriser le contrat à emprunter ${fmtAmount(debtAmount, L.decimals)} ${L.symbol} pour ce compte (transaction, montant exact)`,
              },
            ]
          : []),
        { label: 'Signer la transaction : flash loan, swap, dépôt et emprunt en une fois' },
      ]

  // the price is the collateral's USD one; the drop is against the debt token, as the spoke's oracle sees it
  const drop = hf !== undefined && Number.isFinite(hf) && !unreal ? dropToLiquidation(hf) : undefined
  const liquidation = {
    label: `Liquidation si ${C.symbol} à`,
    value: hf === undefined ? undefined : drop === undefined ? NA : fmtPrice(BigInt(Math.round(Number(sides.collateral.price) * (1 - drop)))),
    sub: drop !== undefined ? `baisse de ${fmtPct(drop, 1)} face à ${L.symbol}` : undefined,
  }

  const debtUsd = (Number(newDebt) / 10 ** L.decimals) * usdOf(state.debtPrice)
  const bar =
    hf !== undefined && !unreal && newDebt > 0n && Number.isFinite(hf) ? (
      <PositionBar
        healthFactor={hf}
        liquidationThreshold={cf}
        correlated={correlated}
        projectedHf={projectHealthFactor(hf, [{ value: 1, apy: ctx.collateralApy }], [{ value: 1, apy: ctx.borrowApy }], 90)}
        amounts={debtUsd > 0 ? { collateral: (debtUsd * hf) / cf, debt: debtUsd } : undefined}
      />
    ) : undefined

  const summary = (
    <Summary
      tx={tx}
      visual={bar}
      items={[
        {
          label: 'Health factor',
          value: hf !== undefined ? fmtHf(hf) : undefined,
          sub: worstHf !== undefined && hf !== undefined && fmtHf(worstHf) !== fmtHf(hf) ? `pire cas ${fmtHf(worstHf)}` : undefined,
          tone: hf !== undefined ? hfTone(hf, correlated) : undefined,
          key: true,
        },
        liquidation,
        {
          label: 'APY net',
          value: unreal || (q && apy === undefined) ? NA : apy !== undefined ? fmtPct(apy) : undefined,
          sub: rewards > 0 ? `récompenses ${fmtPct(rewards)} comprises${bonusEnd}` : 'taux variables, hors coûts',
          tone: apyTone(apy),
          key: true,
        },
        {
          label: 'Coût total',
          value: unreal ? NA : costs ? fmtUsd(costs.total) : undefined,
          sub: !unreal && costs && `entrée ${fmtUsd(costs.entrySwap)} · sortie ${fmtUsd(costs.exitSwap)} · flash loan gratuit · gas non compté`,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onOpen} title={disabledReason}>
          {busy ?? (stale ? 'Cotation…' : augment ? 'Augmenter la position' : 'Ouvrir la position')}
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
      <Card title={augment ? 'Augmenter la position' : 'Ouvrir une position'}>
        {hasPosition && (
          <p className="muted small">
            Position actuelle : {fmtAmount(coll0, C.decimals)} {C.symbol}, dette {fmtAmount(debt0, L.decimals)} {L.symbol}, levier {fmtX(currentLev)}
            {augment && user && `, health factor ${fmtHf(user.healthFactor)}`}. Le levier choisi s’applique à toute la position ; le capital ajouté peut être 0.
          </p>
        )}
        <div className="grid2">
          <CapitalField
            label="Capital"
            balance={capBalance}
            decimals={K.decimals}
            amountText={amountText}
            setAmountText={setAmountText}
            tokenSelect={
              <select
                aria-label="Token du capital"
                value={capitalIsLoan ? 'loan' : 'collateral'}
                onChange={(e) => {
                  setCapitalIsLoan(e.target.value === 'loan')
                  setAmountText('')
                }}
              >
                <option value="collateral">{C.symbol}</option>
                <option value="loan">{L.symbol}</option>
              </select>
            }
            usd={initial !== undefined ? fmtUsd(toBase(initial, capSide)) : undefined}
          />
          <LeverageSlider
            value={lev}
            min={sliderMin}
            max={sliderMax}
            onChange={setLeverage}
            aside={
              <>
                {effectiveLev !== undefined && `effectif ${fmtX(effectiveLev)} · `}max {fmtX(maxLev)} (seuil {fmtLltv(cf)})
              </>
            }
            floor={sliderMin > 1.1 ? `${fmtX(sliderMin)} : levier actuel` : undefined}
          />
        </div>

        <div className="metrics">
          <Metric label="Emprunt" value={`${fmtAmount(debtAmount, L.decimals)} ${L.symbol}`} sub={fmtUsd(soldBase)} />
          <Metric
            label="Collatéral déposé"
            value={q ? `${fmtAmount(capColl + q.buyAmount, C.decimals)} ${C.symbol}` : undefined}
            sub={q && `dont ${fmtAmount(q.buyAmount, C.decimals)} via ${quoteLabel(q)}`}
          />
          <YieldMetrics
            ptExpired={false}
            expiredHint=""
            horizon={horizon}
            horizonYield={horizonYield}
            horizonGain={horizonGain}
            breakEven={breakEven}
            hasCosts={!!costs}
            unreal={unreal}
          />
        </div>

        <Banners problems={problems} warnings={warnings} />

        <SettingsFold aggregator={ctx.aggregator} slippage={slippage} auto={autoSlip} extras={[fmtDays(horizon)]}>
          {ctx.common}
          <SlippageHorizonFields slippage={slippage} setSlippage={setSlippage} pt={false} horizonText={horizonText} setHorizon={setHorizon} />
        </SettingsFold>

        {hf !== undefined && loopLev !== undefined && (
          <RiskPanel
            collateral={C.symbol}
            debt={L.symbol}
            healthFactor={hf}
            leverage={loopLev}
            supplyApy={ctx.collateralApy}
            borrowApy={ctx.borrowApy}
            rewardsApy={rewards}
            correlated={correlated}
            apy={apy}
            signals={signals}
          />
        )}

        {finite && !unreal && (
          <ApyBreakdown
            leverage={loopLev}
            collateralYield={ctx.collateralApy}
            collateralLabel={C.symbol}
            rewards={rewards}
            rewardsLabel="Récompenses Merkl"
            borrowCost={ctx.borrowApy}
            debtLabel={ctx.riskPremium > 0 ? `${L.symbol} (prime de risque comprise)` : L.symbol}
            withCosts={horizonYield}
            horizon={horizon}
          />
        )}

        {q && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(capColl + q.minOut, C.decimals)} ${C.symbol}`}>
            <QuoteCompare quote={q} token={C} />
            <QuoteRoute quote={q} />
            {preview && (
              <dl className="preview">
                <dt>Contrat</dt>
                <dd>{executor}</dd>
                <dt>Routeur</dt>
                <dd>{[...new Set(q.route?.map((l) => l.router) ?? [q.router])].join(' puis ')}</dd>
                <dt>Calldata open()</dt>
                <dd className="mono">{preview}</dd>
              </dl>
            )}
          </Fold>
        )}

        <StepsFold steps={steps} batch={ctx.batch}>
          <p className="muted small">
            Le contrat passe par les gestionnaires de position d’Aave. L’emprunt n’est autorisé que pour ce montant et cette transaction : ce qu’il en reste est
            rendu à la fin.
          </p>
        </StepsFold>
      </Card>
    </LoopLayout>
  )
}
