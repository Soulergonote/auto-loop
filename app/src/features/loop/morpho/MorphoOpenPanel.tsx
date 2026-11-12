import { useMemo, useState } from 'react'
import { parseUnits } from 'viem'
import { AGGREGATORS, QUOTE_MODE } from '../../../config'
import {
  collateralInLoan,
  debtForMorphoLeverage,
  dropToLiquidation,
  leverageAtMorphoHf,
  maxMorphoLeverage,
  morphoHf,
  morphoLeverage,
  morphoNetApy,
} from '../../../protocols/morpho/markets'
import { encodeAction, executeMorpho, morphoOutcomeLines, openAction, readMorphoOutcome, type MorphoOpenPlan } from '../../../protocols/morpho/execute'
import { useQuote } from '../../../services/quotes/useQuote'
import { useDebounced } from '../../../ui/useDebounced'
import { getQuote, quoteLabel } from '../../../services/quotes/quotes'
import { daysToMaturity, isExpired } from '../../../protocols/pendle/pt'
import { roundSignificant, toBase } from '../../../domain/math'
import { GAS_UNITS_PT, breakEvenDays, horizonApy, loopCosts, swapCostBase, swapLoss, swapLossProblem } from '../../../domain/economics'
import { fmtLltv, fmtBps, fmtAmount, fmtDate, fmtDays, fmtHf, fmtPct, fmtPrice, fmtUsd, fmtX, ptShortSymbol } from '../../../ui/format'
import { isCorrelated } from '../../../domain/pairs'
import { exitIssues, exitSellAmount } from '../../../domain/exitCheck'
import { apyTone, hfThresholds, hfTone } from '../../../ui/tone'
import { RiskPanel } from '../shared/RiskPanel'
import { Banners, Card, Fold, LeverageSlider, LoopLayout, Metric, NA, QuoteCompare, Steps, Summary, TxResult, aggregatorLabel } from '../../../ui/primitives'
import type { MorphoCtx } from './MorphoView'
import { pairKind, slippageNote, useSlippage } from '../../../domain/slippage'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { CapitalField, SlippageHorizonFields, YieldMetrics } from '../shared/OpenFields'

/** The slider stops at this health factor: Morpho liquidates at 1, with no LTV margin below the LLTV like Aave's. */
const SLIDER_MIN_HF = 1.02
const MAX_SLIDER = 15

export function MorphoOpenPanel({ ctx, seedLeverage }: { ctx: MorphoCtx; seedLeverage?: number }) {
  const { net, market: M, state, pt, sides, account } = ctx
  const C = M.collateral
  const L = M.loan
  const executor = net.executor
  const user = state.user
  const [capitalIsLoan, setCapitalIsLoan] = useState(false)
  const K = capitalIsLoan ? L : C
  const capSide = capitalIsLoan ? sides.loan : sides.collateral
  const capBalance = capitalIsLoan ? user?.loanBalance : user?.collateralBalance
  const capAllowance = capitalIsLoan ? (user?.loanAllowance ?? 0n) : (user?.collateralAllowance ?? 0n)
  const [amountText, setAmountText] = useState('1000')
  const [leverage, setLeverage] = useState(seedLeverage ? Math.floor(seedLeverage * 20) / 20 : 3)
  const {
    slippage,
    setSlippage,
    auto: autoSlip,
  } = useSlippage(pairKind({ symbol: C.symbol, usd: M.collateralUsd }, { symbol: L.symbol, usd: M.loanUsd }, { pt: !!pt }))
  const [horizonText, setHorizon] = useState('90')
  const { busy, setBusy, result, setResult, run } = useTxAction()

  const ptDays = pt ? daysToMaturity(pt) : undefined
  const ptExpired = !!pt && isExpired(pt)
  const horizon = ptDays !== undefined ? Math.max(1, Math.floor(ptDays)) : Number(horizonText)

  // the existing position on this market: the slider sets the leverage of the whole position
  const coll0 = user?.collateral ?? 0n
  const debt0 = user?.debt ?? 0n
  const hasPosition = coll0 > 0n
  const currentLev = hasPosition ? morphoLeverage(coll0, debt0, state.price) : 1
  const maxLev = maxMorphoLeverage(M.lltv)
  const sliderMax = Math.max(1.1, Math.min(Math.floor(leverageAtMorphoHf(M.lltv, SLIDER_MIN_HF) * 20) / 20, MAX_SLIDER))
  const sliderMin = hasPosition && Number.isFinite(currentLev) ? Math.min(sliderMax, Math.max(1.1, Math.ceil(currentLev * 20) / 20)) : 1.1
  const lev = Math.max(sliderMin, Math.min(leverage, sliderMax))
  // « Augmenter » only once the market carries debt for this address
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

  // capital and position in loan units at the oracle price; rounded so that interest does not re-quote every block
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
  const fixedApy = pt && !ptExpired ? (q?.pendle?.kind === 'buy' && q.pendle.fixedApy !== undefined ? q.pendle.fixedApy : ctx.collateralApy) : undefined
  const collateralApy = pt ? (fixedApy ?? 0) : ctx.collateralApy

  // a PT whose SY gives back nothing an aggregator sells for the loan token could never be closed: checked first
  const exitByRoute = !!pt && !ptExpired && !pt.tokensOut.some((t) => t.address.toLowerCase() === L.address.toLowerCase())
  const exitReq =
    exitByRoute && q && QUOTE_MODE !== 'mock'
      ? {
          aggregator: ctx.aggregator,
          chainId: net.chain.id,
          sell: C,
          buy: L,
          sellAmount: roundSignificant(coll0 + capColl + q.buyAmount, 2),
          taker: net.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: sides.collateral, buy: sides.loan },
        }
      : undefined
  const exitQuote = useQuote(exitReq)
  const exitBlocked = !!exitReq && (exitQuote.isError || !!exitQuote.data?.simulated)
  // any other collateral: what a full close would sell to repay the whole debt is quoted against the loan token
  const plainExitSell = !pt && q ? exitSellAmount(toBase(debt0 + debtAmount, sides.loan), sides.collateral) : 0n
  const plainExitReq =
    plainExitSell > 0n && QUOTE_MODE !== 'mock'
      ? {
          aggregator: ctx.aggregator,
          chainId: net.chain.id,
          sell: C,
          buy: L,
          sellAmount: plainExitSell,
          taker: net.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: sides.collateral, buy: sides.loan },
        }
      : undefined
  const plainExit = useQuote(plainExitReq)
  const plainExitPending = !!plainExitReq && !plainExit.data && !plainExit.isError
  const exit =
    plainExitReq && !plainExitPending
      ? exitIssues({
          sell: C.symbol,
          buy: L.symbol,
          noRoute: plainExit.isError || !!plainExit.data?.simulated,
          reason: plainExit.isError ? (plainExit.error as Error).message : plainExit.data?.fallbackReason,
          loss:
            plainExit.data && !plainExit.data.simulated
              ? swapLoss(plainExit.data.sellAmount, sides.collateral, plainExit.data.buyAmount, sides.loan)
              : undefined,
        })
      : undefined
  const exitPending = (!!exitReq && !exitQuote.data && !exitQuote.isError) || plainExitPending

  const newColl = q ? coll0 + capColl + q.buyAmount : undefined
  const newCollMin = q ? coll0 + capColl + q.minOut : undefined
  const newDebt = debt0 + debtAmount
  const hf = newColl !== undefined ? morphoHf(newColl, newDebt, state.price, M.params.lltv) : undefined
  const worstHf = newCollMin !== undefined ? morphoHf(newCollMin, newDebt, state.price, M.params.lltv) : undefined
  const loopLev = newColl !== undefined ? morphoLeverage(newColl, newDebt, state.price) : undefined
  const netBorrow = ctx.borrowApy - ctx.rewardsApr
  const apy = loopLev !== undefined && Number.isFinite(loopLev) ? morphoNetApy(loopLev, collateralApy, netBorrow) : undefined
  const correlated = isCorrelated({ price: sides.collateral.price, token: C }, { price: sides.loan.price, token: L })

  const problems: string[] = []
  if (initial === undefined) problems.push('Montant invalide.')
  else if (initial === 0n && !hasPosition) problems.push('Capital à déposer manquant.')
  else if (hasPosition && debtAmount === 0n && initial === debouncedInitial && BigInt(Math.round(lev * 10_000)) === debouncedLevBps && !capitalIsLoan)
    problems.push('Le levier visé ne dépasse pas le levier actuel. Pour le réduire : onglet « Fermer / réduire ».')
  if (user && initial && capBalance !== undefined && initial > capBalance) problems.push(`Solde ${K.symbol} insuffisant.`)
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  if (debtAmount > state.liquidity)
    problems.push(
      `Liquidité du marché insuffisante : ${fmtAmount(state.liquidity, L.decimals)} ${L.symbol} disponibles pour ${fmtAmount(debtAmount, L.decimals)} empruntés.`,
    )
  if (worstHf !== undefined && worstHf < 1)
    problems.push(`Health factor projeté ${fmtHf(worstHf)} : au-delà du LLTV, Morpho refuse l’emprunt. Baisser le levier.`)
  if (ptExpired) problems.push(`${C.symbol} est échu : il ne s’achète plus. Le fermer ou changer de marché.`)
  else if (pt && !pt.market) problems.push(`Aucun marché Pendle connu pour ${C.symbol} : achat impossible.`)
  if (exitBlocked)
    problems.push(
      `Sortie impossible : aucun agrégateur ne revend ${pt!.tokensOut.map((t) => t.symbol).join(' ou ')} (ce que rend ${C.symbol}) contre ${L.symbol} pour ce montant. La position ne pourrait être fermée ni avant ni après l’échéance.`,
    )
  if (exit) problems.push(...exit.problems)
  const warnings: string[] = []
  const lossIssue = q && swapLossProblem(swapLoss(q.sellAmount, sides.loan, q.buyAmount, sides.collateral), L.symbol, C.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (exit) warnings.push(...exit.warnings)
  // an input Morpho would refuse: values derived from it would be meaningless, they show a dash
  const unreal = (worstHf !== undefined && worstHf < 1) || debtAmount > state.liquidity || !!lossIssue?.block
  if (pt && ptDays !== undefined && !ptExpired && ptDays < 14)
    warnings.push(`Échéance dans ${Math.floor(ptDays)} j : le rendement fixe ne court plus que jusqu’au ${fmtDate(pt.expiry)}.`)
  if (fixedApy !== undefined && netBorrow > fixedApy)
    warnings.push(`L’emprunt ${L.symbol} (${fmtPct(netBorrow)}) coûte plus que l’APY fixe du PT (${fmtPct(fixedApy)}) : la boucle perd chaque jour.`)
  if (!pt && ctx.collateralApy === 0) warnings.push(`Aucun rendement connu pour ${C.symbol} : l’APY ne compte que le coût de l’emprunt.`)
  if (hf !== undefined && !unreal && hf < hfThresholds(correlated).ok)
    warnings.push(
      `Health factor ${fmtHf(hf)} : une baisse de ${fmtPct(dropToLiquidation(hf), 1)} de ${C.symbol} face à ${L.symbol} à l’oracle suffit à liquider la position.`,
    )
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (debtAmount > 0n && state.liquidity > 0n && debtAmount * 10n > state.liquidity * 9n && debtAmount <= state.liquidity)
    warnings.push('L’emprunt prend presque toute la liquidité du marché : son taux va monter fortement.')

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
        freeExit: !!pt && pt.tokensOut.some((t) => t.address.toLowerCase() === L.address.toLowerCase()),
      })
    : undefined
  const horizonYield =
    costs && apy !== undefined && capitalBase > 0n
      ? horizonApy({ equityBase: capitalBase, ratesApy: apy, rewardsApy: 0, costsBase: costs.total, days: horizon })
      : undefined
  const breakEven = costs && apy !== undefined ? breakEvenDays(capitalBase, apy, costs.total) : undefined
  const horizonGain = horizonYield !== undefined && Number.isFinite(horizonYield) ? ((Number(capitalBase) / 1e8) * horizonYield * horizon) / 365 : undefined
  const effectiveLev = !unreal && loopLev !== undefined && Number.isFinite(loopLev) && Math.abs(loopLev - lev) >= 0.05 ? loopLev : undefined
  if (costs && horizonYield !== undefined && horizonYield < 0 && apy !== undefined && apy > 0)
    warnings.push(`Les coûts (${fmtUsd(costs.total)}) dépassent le rendement sur ${fmtDays(horizon)} avec ce capital. Augmenter le capital ou la durée.`)

  const plan = (fresh = q): MorphoOpenPlan | undefined =>
    executor && account && initial !== undefined
      ? {
          net,
          executor,
          user: account,
          authorized: !!user?.authorized,
          minHealthFactor: worstHf !== undefined && Number.isFinite(worstHf) ? BigInt(Math.floor(worstHf * 0.98 * 1e6)) * 10n ** 12n : 0n,
          market: M.params,
          capitalToken: K.address,
          capitalAmount: debouncedInitial ?? 0n,
          debtAmount,
          quote: fresh,
          capitalAllowance: capAllowance,
        }
      : undefined
  const preview = (() => {
    try {
      const p = plan()
      return p && q ? encodeAction(openAction(p)) : undefined
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
      const hash = await executeMorpho(
        p,
        openAction(p),
        {
          batch: ctx.batch,
          nonce: user?.nonce ?? 0n,
          capital: p.capitalAmount > 0n ? { token: K.address, amount: p.capitalAmount, allowance: capAllowance } : undefined,
        },
        setBusy,
      )
      const outcome = await readMorphoOutcome(net.chain.id, hash, p.executor, p.user)
      setResult({ ok: true, text: augment ? 'Position augmentée.' : 'Position ouverte.', hash, details: outcome && morphoOutcomeLines(outcome, C, L) })
      ctx.onDone()
    })
  }

  const authorized = !!user?.authorized
  const needsApprove = !!initial && capAllowance < initial
  const steps = ctx.batch
    ? [
        ...(needsApprove ? [{ label: `Autoriser le contrat à prendre ${fmtAmount(initial ?? 0n, K.decimals)} ${K.symbol} (montant exact)` }] : []),
        ...(authorized ? [] : [{ label: 'Autoriser le contrat sur Morpho, le temps du lot' }]),
        { label: 'Ouvrir : flash loan Morpho, swap, dépôt du collatéral et emprunt' },
        ...(authorized ? [] : [{ label: 'Retirer l’autorisation Morpho' }]),
        ...(needsApprove ? [{ label: 'Remettre l’autorisation du capital à sa valeur' }] : []),
      ]
    : [
        ...(needsApprove ? [{ label: `Autoriser le contrat à prendre ${fmtAmount(initial ?? 0n, K.decimals)} ${K.symbol} (transaction, une fois)` }] : []),
        ...(authorized
          ? []
          : [{ label: 'Signer deux messages Morpho (sans gas) : autoriser le contrat pour cette transaction, puis retirer cette autorisation à sa fin' }]),
        { label: 'Signer la transaction : flash loan, swap, dépôt et emprunt en une fois' },
      ]

  // the price is the collateral's USD one; the drop is against the loan token, as Morpho's oracle sees it
  const drop = hf !== undefined && Number.isFinite(hf) && !unreal ? dropToLiquidation(hf) : undefined
  const liquidation =
    sides.collateral.price > 0n
      ? {
          label: `Liquidation si ${ptShortSymbol(C.symbol)} à`,
          value: hf === undefined ? undefined : drop === undefined ? NA : fmtPrice(BigInt(Math.round(Number(sides.collateral.price) * (1 - drop)))),
          sub: drop !== undefined ? `baisse de ${fmtPct(drop, 1)} face à ${L.symbol}` : undefined,
        }
      : {
          label: 'Liquidation si baisse de',
          value: hf === undefined ? undefined : drop === undefined ? NA : fmtPct(drop, 1),
          sub: `de ${ptShortSymbol(C.symbol)} face à ${L.symbol}`,
        }

  const summary = (
    <Summary
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
          sub: pt
            ? `dont ${fmtPct(collateralApy)} fixe sur le collatéral`
            : ctx.rewardsApr > 0
              ? `récompenses d’emprunt ${fmtPct(ctx.rewardsApr)} comprises`
              : 'taux variables, hors coûts',
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
            Position actuelle : {fmtAmount(coll0, C.decimals)} {ptShortSymbol(C.symbol)}, dette {fmtAmount(debt0, L.decimals)} {L.symbol}, levier{' '}
            {fmtX(currentLev)}
            {augment && `, health factor ${fmtHf(morphoHf(coll0, debt0, state.price, M.params.lltv))}`}. Le levier choisi s’applique à toute la position ; le
            capital ajouté peut être 0.
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
                {effectiveLev !== undefined && `effectif ${fmtX(effectiveLev)} · `}max {fmtX(maxLev)} (LLTV {fmtLltv(M.lltv)})
              </>
            }
            floor={sliderMin > 1.1 ? `${fmtX(sliderMin)} : levier actuel` : undefined}
          />
        </div>

        <div className="metrics">
          <Metric label="Emprunt" value={`${fmtAmount(debtAmount, L.decimals)} ${L.symbol}`} sub={fmtUsd(soldBase)} />
          <Metric
            label="Collatéral déposé"
            value={q ? `${fmtAmount(capColl + q.buyAmount, C.decimals)} ${ptShortSymbol(C.symbol)}` : undefined}
            sub={q && `dont ${fmtAmount(q.buyAmount, C.decimals)} via ${quoteLabel(q)}`}
          />
          <YieldMetrics
            pt={pt}
            ptExpired={ptExpired}
            ptDays={ptDays}
            fixedApy={fixedApy}
            expiredHint="à fermer ou changer de marché"
            horizon={horizon}
            horizonYield={horizonYield}
            horizonGain={horizonGain}
            breakEven={breakEven}
            hasCosts={!!costs}
            unreal={unreal}
          />
        </div>

        <Banners problems={problems} warnings={warnings} />

        <Fold
          title="Réglages"
          value={`${aggregatorLabel(ctx.aggregator)} · slippage ${fmtBps(slippage)}${slippageNote(autoSlip)}${pt ? '' : ` · ${fmtDays(horizon)}`}`}
        >
          {ctx.common}
          <SlippageHorizonFields slippage={slippage} setSlippage={setSlippage} pt={!!pt} horizonText={horizonText} setHorizon={setHorizon} />
        </Fold>

        {hf !== undefined && loopLev !== undefined && (
          <RiskPanel
            collateral={C.symbol}
            debt={L.symbol}
            healthFactor={hf}
            leverage={loopLev}
            supplyApy={collateralApy}
            borrowApy={ctx.borrowApy}
            rewardsApy={ctx.rewardsApr * (loopLev - 1)}
            correlated={correlated}
            apy={apy}
          />
        )}

        {q && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(capColl + q.minOut, C.decimals)} ${ptShortSymbol(C.symbol)}`}>
            <QuoteCompare quote={q} token={C} />
            {q.route && (
              <p className="small">
                Route : {q.route.map((l) => `${l.sell.symbol} → ${l.buy.symbol} (${l.via === 'pendle' ? 'Pendle' : AGGREGATORS[l.via].label})`).join(', ')}.
              </p>
            )}
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

        <Fold title="Étapes" value={ctx.batch ? 'une seule confirmation' : `${steps.length} étape${steps.length > 1 ? 's' : ''}`}>
          <Steps steps={steps} />
          <p className="muted small">
            Le contrat n’agit sur le compte Morpho que pendant cette transaction : l’autorisation est donnée puis retirée dedans, et la transaction échoue si
            elle restait en place.
          </p>
        </Fold>
      </Card>
    </LoopLayout>
  )
}
