import { useMemo, useState, type ReactNode } from 'react'
import { useGasPrice } from 'wagmi'
import { parseUnits, type Address } from 'viem'
import { protocolName, wrappedNative, AGGREGATORS, QUOTE_MODE, type AggregatorChoice, type Token } from '../../../config'
import { campaignYields, campaignsForPair, daysLeft, eligibleForPosition, rewardsOverHorizon } from '../../../services/merkl'
import { CampaignTable } from '../shared/CampaignTable'
import { RiskPanel } from '../shared/RiskPanel'
import { PositionBar } from '../../../ui/PositionBar'
import { projectHealthFactor } from '../../../domain/projection'
import { thresholdOf } from '../../../domain/positionBar'
import { ApyHistory } from '../shared/ApyHistory'
import { ApyBreakdown } from '../shared/ApyBreakdown'
import { useAaveRateSeries } from '../../../protocols/aave/rateSeries'
import { useRiskSignals } from '../shared/RiskSignals'
import { canBorrow, eligibleEModes, withEMode, type EModeCategory, type Reserves, type UserState } from '../../../protocols/aave/useMarket'
import { useQuote } from '../../../services/quotes/useQuote'
import { useDebounced } from '../../../ui/useDebounced'
import { getQuote, quoteLabel } from '../../../services/quotes/quotes'
import { daysToMaturity, hfAtMaturity, isExpired } from '../../../protocols/pendle/pt'
import { PtPrices } from '../shared/PtPrices'
import { loopNativeApy } from '../../../services/yield/nativeYield'
import { WINDOWS, isRateSpike, useRateAverages } from '../../../protocols/aave/rateHistory'
import {
  extraDebtForTarget,
  maxLeverage,
  netApy,
  pairPosition,
  positionLeverage,
  project,
  roundSignificant,
  toBase,
  EMPTY_ACCOUNT,
  NO_POSITION,
} from '../../../domain/math'
import { GAS_UNITS_PT, breakEvenDays, horizonApy, loopCosts, swapCostBase, swapLoss, swapLossProblem } from '../../../domain/economics'
import { encodeCall, executeOpen, openCall, type OpenPlan } from '../../../protocols/aave/execute'
import { executeOpenBatch } from '../../../protocols/aave/batch'
import { useAtomicBatch } from '../../../chain/batch'
import { capitalKind, useWalletTokens, walletValue, type WalletToken } from '../../../chain/walletTokens'
import { outcomeLines, readOutcome } from '../../../chain/outcome'
import { fmtBps, fmtAmount, fmtDate, fmtDays, fmtHf, fmtPct, fmtPrice, fmtUsd, fmtX, ptShortSymbol } from '../../../ui/format'
import { isCorrelated } from '../../../domain/pairs'
import { useQuery } from '@tanstack/react-query'
import { exitIssues, exitSellAmount, utilization } from '../../../domain/exitCheck'
import { snapshotQuery } from '../../../protocols/aave/snapshot'
import { apyTone, hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LeverageSlider, LoopLayout, QuoteCompare, Metric, NA, Steps, Summary, TxResult, aggregatorLabel } from '../../../ui/primitives'
import { pairKind, reserveAsset, slippageNote, useSlippage } from '../../../domain/slippage'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { CapitalField, SlippageHorizonFields, YieldMetrics } from '../shared/OpenFields'

type Props = {
  reserves: Reserves
  /** all eMode categories of the market */
  emodes: EModeCategory[]
  user?: UserState
  account?: Address
  aggregator: AggregatorChoice
  onDone: () => void
  /** settings shared with the close panel (aggregator, contract), shown in the "Réglages" block */
  common: ReactNode
  /** market card and open / close tabs, at the top of the left column */
  head: ReactNode
  /** eMode and leverage to start with (pair picked in the scanner) */
  /** from the scanner, the positions or the reinvest flow; amount = capital to fill in, as typed text */
  seed?: { emode: number; leverage: number; amount?: string; capital?: Address }
  /** the market's tokens, offered as capital with a v2 contract */
  tokens?: Token[]
}

/** Value of a capital choice in the token select: the native token apart from its wrapped ERC-20. */
const optionKey = (t: WalletToken) => (t.native ? 'native' : t.token.address)

export function AaveOpenPanel({ reserves: base, emodes, user, account, aggregator, onDone, seed, common, head, tokens }: Props) {
  const eligible = eligibleEModes(emodes, base.collateral, base.debt)
  // default: the account's current category when it fits the pair, otherwise the best one (highest LTV)
  const [chosenEMode, setChosenEMode] = useState<number | undefined>(seed?.emode)
  const currentEMode = user?.eModeCategory ?? 0
  const emodeId =
    chosenEMode !== undefined && (chosenEMode === 0 || eligible.some((c) => c.id === chosenEMode))
      ? chosenEMode
      : eligible.some((c) => c.id === currentEMode)
        ? currentEMode
        : (eligible[0]?.id ?? 0)
  const reserves = withEMode(
    base,
    eligible.find((c) => c.id === emodeId),
  )
  const { market, collateral: C, debt: D } = reserves
  const executor = market.executor
  const [amountText, setAmountText] = useState(seed?.amount ?? '1')
  // capital in any token (contract v2): the collateral, the debt asset or another token the wallet holds
  const v2 = market.executorVersion !== 1
  const wallet = useWalletTokens(market, tokens, C.token, D.token, account, v2, wrappedNative(tokens, market.chain))
  const [capitalChoice, setCapitalChoice] = useState<string | undefined>(seed?.capital)
  const capitalOptions = v2 ? (wallet.data ?? []) : []
  const capitalPick = capitalOptions.find((t) => optionKey(t) === capitalChoice)
  // the native token (ETH…): wrapped into its ERC-20 in the same batch, then used like it
  const native = capitalPick?.native
  const K = capitalPick?.token ?? C.token
  const kind = capitalKind(K.address, C.token.address, D.token.address)
  const capSide = kind === 'collateral' ? C.side : kind === 'debt' ? D.side : capitalPick!.side
  const capBalance = native ? capitalPick.balance : kind === 'collateral' ? user?.collateralBalance : capitalPick?.balance
  const capAllowance = native ? capitalPick.allowance : kind === 'collateral' ? (user?.collateralAllowance ?? 0n) : (capitalPick?.allowance ?? 0n)
  const capSymbol = native?.symbol ?? K.symbol
  const [leverage, setLeverage] = useState(seed ? Math.floor(seed.leverage * 20) / 20 : 2)
  const { slippage, setSlippage, auto: autoSlip } = useSlippage(pairKind(reserveAsset(C), reserveAsset(D), { pt: !!C.pt }))
  const [horizonText, setHorizon] = useState('90')
  // a Pendle PT: its fixed yield runs until maturity, which is also the holding time the costs are spread over
  const pt = C.pt
  const ptDays = pt ? daysToMaturity(pt) : undefined
  const ptExpired = !!pt && isExpired(pt)
  const horizon = ptDays !== undefined ? Math.max(1, Math.floor(ptDays)) : Number(horizonText)
  const averages = useRateAverages(market.chain.id, market.pool, [C.token.address, D.token.address]).data
  const series = useAaveRateSeries(market.chain.id, market.pool, C.token.address, D.token.address)
  const avgC = averages?.get(C.token.address.toLowerCase())
  const avgD = averages?.get(D.token.address.toLowerCase())
  const gasPrice = useGasPrice({ chainId: market.chain.id, query: { refetchInterval: 30_000 } })
  // a wallet that sends atomic batches: eMode, approval, delegation, open and allowances back in one confirmation
  const batch = useAtomicBatch(market.chain.id, account) === true
  const { busy, setBusy, result, setResult, run } = useTxAction()

  // an existing position on the pair is levered further: the slider then sets the leverage of the whole position
  const position = user ? pairPosition(user, C.side, D.side) : NO_POSITION
  const hasPosition = position.collateralBase > 0n
  const currentLev = positionLeverage(position)
  // « Augmenter » only once the pair itself carries debt; collateral alone (or other positions) is an opening
  const augment = hasPosition && !!user && user.debtBalance > 0n

  const maxLev = maxLeverage(C.config.ltvBps)
  const sliderMax = Math.max(1.1, Math.min(Math.floor(maxLev * 0.95 * 20) / 20, 15))
  const sliderMin = hasPosition && Number.isFinite(currentLev) ? Math.min(sliderMax, Math.max(1.1, Math.ceil(currentLev * 20) / 20)) : 1.1
  const lev = Math.max(sliderMin, Math.min(leverage, sliderMax))

  const initial = useMemo(() => {
    try {
      return parseUnits(amountText.replace(',', '.') || '0', K.decimals)
    } catch {
      return undefined
    }
  }, [amountText, K.decimals])

  const debouncedInitial = useDebounced(initial)
  const debouncedLevBps = useDebounced(BigInt(Math.round(lev * 10_000)))

  // another token as capital: swapped to the collateral by the contract before the loop
  const capitalReq =
    kind === 'swap' && debouncedInitial
      ? {
          aggregator,
          chainId: market.chain.id,
          sell: K,
          buy: C.token,
          sellAmount: debouncedInitial,
          taker: market.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: capSide, buy: C.side },
        }
      : undefined
  const capitalQuote = useQuote(capitalReq)
  const cq = kind === 'swap' ? capitalQuote.data : undefined
  // collateral the capital brings itself (expected, and the worst case the contract enforces); the debt asset as
  // capital is sold in the debt swap, so it brings none here
  const capColl = kind === 'collateral' ? debouncedInitial : kind === 'debt' ? 0n : cq?.buyAmount
  const capCollMin = kind === 'swap' ? cq?.minOut : capColl
  // value of the capital the leverage applies to
  const capitalAddedBase =
    debouncedInitial === undefined
      ? undefined
      : kind === 'swap'
        ? cq
          ? toBase(cq.buyAmount, C.side)
          : debouncedInitial === 0n
            ? 0n
            : undefined
        : toBase(debouncedInitial, capSide)
  // rounded so that interest accruing on the existing debt does not re-quote at every block
  const debtAmount = capitalAddedBase !== undefined ? roundSignificant(extraDebtForTarget(position, capitalAddedBase, debouncedLevBps, D.side), 5) : 0n
  const debtSold = debtAmount + (kind === 'debt' ? (debouncedInitial ?? 0n) : 0n)

  const quoteReq =
    debtAmount > 0n
      ? {
          aggregator,
          chainId: market.chain.id,
          sell: D.token,
          buy: C.token,
          sellAmount: debtSold,
          taker: market.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: D.side, buy: C.side },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = quote.data
  // a PT's yield is the one its price locks in: the quote's (price paid), the market's implied APY until it arrives
  const fixedApy = pt && !ptExpired ? (q?.pendle?.kind === 'buy' && q.pendle.fixedApy !== undefined ? q.pendle.fixedApy : C.native?.apy) : undefined
  const cNative = pt ? (fixedApy !== undefined ? { apy: fixedApy, source: 'pt' as const, fixedUntil: pt.expiry } : undefined) : C.native

  // a PT whose SY gives back a token no aggregator sells for the debt asset could not be closed by the app, before or
  // after maturity: the way out is quoted (PT → debt asset, the size of the position) before anything is signed
  const exitByRoute = !!pt && !ptExpired && !pt.tokensOut.some((t) => t.address.toLowerCase() === D.token.address.toLowerCase())
  const exitReq =
    exitByRoute && q && capColl !== undefined && QUOTE_MODE !== 'mock'
      ? {
          aggregator,
          chainId: market.chain.id,
          sell: C.token,
          buy: D.token,
          sellAmount: roundSignificant(capColl + q.buyAmount, 2),
          taker: market.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: C.side, buy: D.side },
        }
      : undefined
  const exitQuote = useQuote(exitReq)
  const exitBlocked = !!exitReq && (exitQuote.isError || !!exitQuote.data?.simulated)
  // any other collateral: what a full close would sell to repay the whole debt is quoted against the debt asset
  const plainExitSell = !pt && q ? exitSellAmount(position.debtBase + toBase(debtAmount, D.side), C.side) : 0n
  const plainExitReq =
    plainExitSell > 0n && QUOTE_MODE !== 'mock'
      ? {
          aggregator,
          chainId: market.chain.id,
          sell: C.token,
          buy: D.token,
          sellAmount: plainExitSell,
          taker: market.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: C.side, buy: D.side },
        }
      : undefined
  const plainExit = useQuote(plainExitReq)
  const plainExitPending = !!plainExitReq && !plainExit.data && !plainExit.isError
  // the collateral's Aave reserve almost all lent out: withdrawing it at close may have to wait
  const snapshot = useQuery({ ...snapshotQuery(market), enabled: !pt })
  const collSnap = snapshot.data?.reserves.find((r) => r.token.address === C.token.address)
  const exitRead =
    plainExitReq && !plainExitPending
      ? {
          noRoute: plainExit.isError || !!plainExit.data?.simulated,
          loss: plainExit.data && !plainExit.data.simulated ? swapLoss(plainExit.data.sellAmount, C.side, plainExit.data.buyAmount, D.side) : undefined,
        }
      : undefined
  const exit = exitRead
    ? exitIssues({
        sell: C.token.symbol,
        buy: D.token.symbol,
        ...exitRead,
        reason: plainExit.isError ? (plainExit.error as Error).message : plainExit.data?.fallbackReason,
        utilization: collSnap ? utilization(collSnap.totalSupplyBase, collSnap.totalDebtBase) : undefined,
      })
    : undefined
  const exitPending = (!!exitReq && !exitQuote.data && !exitQuote.isError) || plainExitPending

  const account0 = user?.account ?? EMPTY_ACCOUNT
  const proj = q && capColl !== undefined ? project(account0, capColl + q.buyAmount, C.side, C.config.liquidationThresholdBps, debtAmount, D.side) : undefined
  const worst =
    q && capCollMin !== undefined ? project(account0, capCollMin + q.minOut, C.side, C.config.liquidationThresholdBps, debtAmount, D.side) : undefined
  // Aave checks the borrow against the LTV (not the liquidation threshold) when it mints the debt
  const maxLtv = C.config.ltvBps / 10_000

  const problems: string[] = []
  if (initial === undefined) problems.push('Montant invalide.')
  else if (initial === 0n && !hasPosition) problems.push('Capital à déposer manquant.')
  else if (hasPosition && debtAmount === 0n && initial === debouncedInitial && BigInt(Math.round(lev * 10_000)) === debouncedLevBps)
    problems.push('Le levier visé ne dépasse pas le levier actuel. Pour le réduire : onglet « Fermer / réduire ».')
  // first cause first (charte v2): balance, then market state, liquidity, health factor, swap
  if (user && initial && capBalance !== undefined && initial > capBalance) problems.push(`Solde ${capSymbol} insuffisant.`)
  if (!C.config.active || C.config.paused || C.config.frozen) problems.push(`${C.token.symbol} est gelé ou en pause sur ${protocolName(market)}.`)
  if (!canBorrow(D, reserves.emode)) problems.push(`${D.token.symbol} ne peut pas être emprunté.`)
  if (!D.config.flashLoanEnabled) problems.push(`Flash loan désactivé sur ${D.token.symbol}.`)
  if (C.config.ltvBps === 0) problems.push(`${C.token.symbol} n’est pas accepté comme collatéral (LTV 0).`)
  if (C.config.isolated) problems.push(`${C.token.symbol} est en isolation mode : non supporté par le contrat v1.`)
  if (worst && worst.ltv > maxLtv) problems.push(`LTV projetée ${fmtPct(worst.ltv)} au-dessus du maximum ${fmtPct(maxLtv)}. Baisser le levier.`)
  if (ptExpired) problems.push(`${C.token.symbol} est échu : il ne s’achète plus. Le fermer ou le renouveler.`)
  else if (pt && !pt.market) problems.push(`Aucun marché Pendle connu pour ${C.token.symbol} : achat impossible.`)
  if (exitBlocked)
    problems.push(
      `Sortie impossible : aucun agrégateur ne revend ${pt!.tokensOut.map((t) => t.symbol).join(' ou ')} (ce que rend ${C.token.symbol}) contre ${D.token.symbol} pour ce montant. La position ne pourrait être fermée ni avant ni après l’échéance.`,
    )
  if (exit) problems.push(...exit.problems)
  if (pt && executor && market.executorVersion === 1) problems.push('Le contrat v1 ne fait qu’un swap : un PT demande le contrat v2.')
  else if (pt && executor && !market.executorPendle)
    problems.push('Ce contrat n’autorise pas le routeur Pendle : déployer le nouveau contrat (bandeau en haut).')

  const warnings: string[] = []
  const lossIssue = q && swapLossProblem(swapLoss(q.sellAmount, D.side, q.buyAmount, C.side), D.token.symbol, C.token.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (exit) warnings.push(...exit.warnings)
  const capLossIssue = cq && swapLossProblem(swapLoss(cq.sellAmount, capSide, cq.buyAmount, C.side), K.symbol, C.token.symbol, cq.simulated)
  if (capLossIssue) (capLossIssue.block ? problems : warnings).push(capLossIssue.text)
  // an input the protocol would refuse: values derived from it would be meaningless, they show a dash
  const unreal = (!!worst && worst.ltv > maxLtv) || !!lossIssue?.block || !!capLossIssue?.block
  const correlated = isCorrelated(C, D)
  const signals = useRiskSignals({
    chainId: market.chain.id,
    collateral: C.token,
    debt: D.token,
    correlated,
    oracleRatio: Number(C.side.price) / Number(D.side.price),
    exit: exitRead,
  })
  if (pt && ptDays !== undefined && !ptExpired && ptDays < 14)
    warnings.push(`Échéance dans ${Math.floor(ptDays)} j : le rendement fixe ne court plus que jusqu’au ${fmtDate(pt.expiry)}.`)
  if (fixedApy !== undefined && D.borrowApy + (D.native?.apy ?? 0) > fixedApy)
    warnings.push(`L’emprunt ${D.token.symbol} (${fmtPct(D.borrowApy)}) coûte plus que l’APY fixe du PT (${fmtPct(fixedApy)}) : la boucle perd chaque jour.`)
  if (proj && !unreal && proj.healthFactor < hfThresholds(correlated).ok)
    warnings.push(
      `Health factor ${fmtHf(proj.healthFactor)} : une baisse de ${fmtPct(proj.dropToLiquidation, 1)} de ${C.token.symbol} face à ${D.token.symbol} suffit à liquider la position.`,
    )
  const switchEMode = !!user && currentEMode !== emodeId
  if (switchEMode && currentEMode !== 0 && (user.account.debtBase > 0n || user.account.collateralBase > 0n))
    warnings.push(
      `Le compte Aave est en eMode « ${emodes.find((c) => c.id === currentEMode)?.label ?? currentEMode} » : le changer s’applique à toutes ses positions sur ce marché.`,
    )
  if (cq?.simulated)
    warnings.push(`Devis du capital simulé au prix de l’oracle${cq.fallbackReason ? ` (${cq.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)

  // a quote that fails blocks the transaction: it is a problem like the others, in the single red banner
  // right after a missing balance, the first cause when both happen
  problems.splice(
    problems.findIndex((p) => p.startsWith('Solde ')) + 1,
    0,
    ...(quote.isError ? [`Cotation impossible : ${(quote.error as Error).message}`] : []),
    ...(kind === 'swap' && capitalQuote.isError ? [`Cotation ${K.symbol} → ${C.token.symbol} impossible : ${(capitalQuote.error as Error).message}`] : []),
  )

  const needsApprove = !!user && !!initial && capAllowance < initial
  const needsDelegation = !user || user.borrowAllowance < debtAmount
  const soldBase = toBase(debtAmount, D.side)
  const addedCollBase = q && capColl !== undefined ? toBase(capColl + q.buyAmount, C.side) : 0n
  // leverage of the whole position on the pair once this transaction is done (existing position included)
  const loopLev = proj
    ? hasPosition
      ? positionLeverage({ collateralBase: position.collateralBase + addedCollBase, debtBase: position.debtBase + soldBase })
      : proj.leverage
    : undefined

  // Merkl: only the campaigns whose rules the projected position meets count in the APY
  const pairCampaigns = campaignsForPair(reserves.campaigns, C, D)
  const eligibility = proj ? eligibleForPosition(pairCampaigns, { healthFactor: proj.healthFactor, debtToken: D.variableDebtToken }) : undefined
  const yields = loopLev !== undefined && eligibility ? campaignYields(eligibility.pair, loopLev, C, D) : []
  const rewardsApy = yields.reduce((sum, y) => sum + y.apy, 0)
  // the intrinsic yield of yield-bearing legs lasts like the Aave rates: it counts with them over the horizon
  const nativeApy = loopLev !== undefined ? loopNativeApy(loopLev, cNative, D.native) : 0
  const ratesApy = loopLev !== undefined ? netApy(loopLev, C.supplyApy, D.borrowApy) + nativeApy : undefined
  const apy = ratesApy !== undefined ? ratesApy + rewardsApy : undefined
  // the same loop priced on the 7- and 30-day average Aave rates instead of today's
  const averageApy = Object.fromEntries(
    WINDOWS.flatMap((w) => {
      const supply = avgC?.supply[w]
      const borrow = avgD?.borrow[w]
      return loopLev !== undefined && supply !== undefined && borrow !== undefined ? [[w, netApy(loopLev, supply, borrow) + nativeApy + rewardsApy]] : []
    }),
  )
  const apyParts = [nativeApy !== 0 && `${fmtPct(nativeApy)} ${pt ? 'fixe' : 'token'}`, rewardsApy !== 0 && `${fmtPct(rewardsApy)} Merkl`].filter(Boolean)

  // one-off costs, and the yield once they are paid, over the planned holding time
  const capitalBase = (debouncedInitial !== undefined ? toBase(debouncedInitial, capSide) : 0n) + position.collateralBase - position.debtBase
  // the capital's own swap counts in the entry cost; the exit swap only sells back what the debt needs
  const capitalSwapBase = cq ? swapCostBase(cq.sellAmount, capSide, cq.buyAmount, C.side) : 0n
  const costs =
    q && capColl !== undefined
      ? loopCosts({
          entrySoldBase: toBase(q.sellAmount, D.side),
          entrySwapBase: swapCostBase(q.sellAmount, D.side, q.buyAmount, C.side) + capitalSwapBase,
          debtBase: soldBase,
          premiumBps: reserves.premiumBps,
          gasPriceWei: gasPrice.data,
          nativePriceBase: reserves.nativePrice,
          ...(pt && {
            gasUnits: GAS_UNITS_PT.open + GAS_UNITS_PT.close,
            // held to maturity, the PT is redeemed 1 for 1: no pool to cross, and no swap when its SY gives the debt asset
            freeExit: pt.tokensOut.some((t) => t.address.toLowerCase() === D.token.address.toLowerCase()),
          }),
        })
      : undefined
  // the APYs above are on the equity left after the swap; over the horizon everything is measured against the
  // capital put in, so the swap loss counts once, as a cost
  const toCapital =
    proj && capitalBase > 0n ? (Number(position.collateralBase + addedCollBase) - Number(position.debtBase + soldBase)) / Number(capitalBase) : 0
  const horizonYield =
    costs && ratesApy !== undefined && capitalBase > 0n
      ? horizonApy({
          equityBase: capitalBase,
          ratesApy: ratesApy * toCapital,
          rewardsApy: rewardsOverHorizon(yields, horizon) * toCapital,
          costsBase: costs.total,
          days: horizon,
        })
      : undefined
  const breakEven =
    costs && ratesApy !== undefined
      ? breakEvenDays(
          capitalBase,
          ratesApy * toCapital,
          costs.total,
          yields.map((y) => ({ apy: y.apy * toCapital, days: daysLeft(y.campaign) })),
        )
      : undefined
  // what the capital earns over the planned time, costs paid (horizonYield is annualised)
  const horizonGain = horizonYield !== undefined && Number.isFinite(horizonYield) ? ((Number(capitalBase) / 1e8) * horizonYield * horizon) / 365 : undefined
  // leverage once the swap is done, shown beside the slider when it differs from the chosen one
  const effectiveLev = !unreal && loopLev !== undefined && Number.isFinite(loopLev) && Math.abs(loopLev - lev) >= 0.05 ? loopLev : undefined
  // a rate far from its own average does not last: the APY above would not either
  if (isRateSpike(D.borrowApy, avgD?.borrow[30]))
    warnings.push(`Emprunt ${D.token.symbol} à ${fmtPct(D.borrowApy)}, contre ${fmtPct(avgD!.borrow[30]!)} en moyenne sur 30 j : taux en pic.`)
  if (isRateSpike(C.supplyApy, avgC?.supply[30]))
    warnings.push(`Dépôt ${C.token.symbol} à ${fmtPct(C.supplyApy)}, contre ${fmtPct(avgC!.supply[30]!)} en moyenne sur 30 j : rendement en pic.`)
  for (const c of [...pairCampaigns.supply, ...pairCampaigns.borrow].filter((c) => c.conditional))
    warnings.push(`Bonus Merkl « ${c.name} » : certaines conditions ne sont pas lisibles par l’app, à vérifier sur Merkl.`)
  for (const x of eligibility?.excluded ?? []) warnings.push(`Bonus Merkl « ${x.campaign.name} » non compté : ${x.reasons.join(', ')}.`)

  // fixed costs (gas above all) that a small capital does not earn back over the planned time
  if (costs && horizonYield !== undefined && horizonYield < 0 && apy !== undefined && apy > 0)
    warnings.push(`Les coûts fixes (${fmtUsd(costs.total)}) dépassent le rendement sur ${fmtDays(horizon)} avec ce capital. Augmenter le capital ou la durée.`)

  const plan = (quoteOverride = q, capitalOverride = cq): OpenPlan | undefined =>
    quoteOverride && account && initial !== undefined
      ? {
          chainId: market.chain.id,
          executor: executor ?? market.quoteTaker,
          version: market.executorVersion,
          // worst case of the quote (its minimum), with a little room for prices moving before inclusion
          minHealthFactor: worst && Number.isFinite(worst.healthFactor) ? BigInt(Math.floor(worst.healthFactor * 0.98 * 1e6)) * 10n ** 12n : 0n,
          user: account,
          collateral: C.token.address,
          debt: D.token.address,
          variableDebtToken: D.variableDebtToken,
          initialCollateral: debouncedInitial ?? 0n,
          capitalToken: K.address,
          wrapNative: native ? (debouncedInitial ?? 0n) : undefined,
          capitalQuote: capitalOverride,
          debtAmount,
          quote: quoteOverride,
          collateralAllowance: capAllowance,
          borrowAllowance: user?.borrowAllowance ?? 0n,
          pool: market.pool,
          eModeTarget: switchEMode ? emodeId : undefined,
        }
      : undefined

  const preview = (() => {
    try {
      return q && (kind !== 'swap' || cq)
        ? encodeCall(
            openCall({
              version: market.executorVersion,
              collateral: C.token.address,
              debt: D.token.address,
              initialCollateral: debouncedInitial ?? 0n,
              capitalToken: K.address,
              capitalQuote: cq,
              debtAmount,
              quote: q,
            } as OpenPlan),
          )
        : undefined
    } catch {
      return undefined // quotes of a previous amount, until the new ones arrive
    }
  })()

  const stale = initial !== debouncedInitial || quote.isFetching || capitalQuote.isFetching
  const canSign =
    !exitPending &&
    !!executor &&
    !!account &&
    !!q &&
    !q.simulated &&
    (kind !== 'swap' || (!!cq && !cq.simulated)) &&
    !!preview &&
    problems.length === 0 &&
    !stale &&
    !busy
  const disabledReason = signBlocker({ executor, account, simulated: q?.simulated || cq?.simulated, problems, checkingExit: exitPending })

  async function onOpen() {
    await run(async () => {
      setBusy('Nouvelle cotation…')
      // quotes expire within a few blocks: always re-quote right before signing (same debt, same capital)
      const [fresh, freshCapital] = await Promise.all([getQuote(quoteReq!), capitalReq ? getQuote(capitalReq) : undefined])
      if (fresh.simulated || freshCapital?.simulated) throw new Error('Plus de devis réel disponible')
      const p = plan(fresh, freshCapital)!
      const hash = batch ? await executeOpenBatch(p, setBusy) : await executeOpen(p, setBusy)
      // v2 emits what it really supplied and borrowed: shown instead of the estimate
      const outcome = market.executorVersion === 2 ? await readOutcome(market.chain.id, hash, p.executor, p.user) : undefined
      const expectedSupplied = (kind === 'swap' ? (freshCapital?.buyAmount ?? 0n) : kind === 'collateral' ? p.initialCollateral : 0n) + fresh.buyAmount
      const details = outcome && outcomeLines(outcome, [C.token, D.token, K], { supplied: expectedSupplied })
      setResult({ ok: true, text: augment ? 'Position augmentée.' : 'Position ouverte.', hash, details })
      onDone()
      void wallet.refetch()
    })
  }

  const emodeLabel = reserves.emode ? reserves.emode.label : 'sans eMode'
  const steps = [
    ...(switchEMode || (!user && emodeId !== 0)
      ? [
          {
            label:
              emodeId === 0
                ? `Sortir de l’eMode sur le compte ${protocolName(market)}${batch ? '' : ' (transaction, une fois)'}`
                : `Passer le compte Aave en eMode « ${reserves.emode!.label} »${batch ? '' : ' (transaction, une fois)'}`,
          },
        ]
      : []),
    ...(native
      ? [{ label: `Convertir ${fmtAmount(initial ?? 0n, K.decimals)} ${native.symbol} en ${K.symbol}${batch ? ' (montant exact)' : ' (transaction)'}` }]
      : []),
    ...(batch
      ? [
          ...(needsApprove || !user ? [{ label: `Autoriser le contrat à prendre ${fmtAmount(initial ?? 0n, K.decimals)} ${K.symbol} (montant exact)` }] : []),
          ...(needsDelegation ? [{ label: `Déléguer l’emprunt de ${D.token.symbol} au contrat (montant exact)` }] : []),
          { label: kind === 'swap' ? `Ouvrir : swap ${K.symbol} → ${C.token.symbol}, flash loan, swap et dépôt` : 'Ouvrir : flash loan, swap et dépôt' },
          ...(needsApprove || needsDelegation || !user ? [{ label: 'Remettre l’autorisation et la délégation à leur valeur' }] : []),
        ]
      : [
          ...(needsApprove || !user
            ? [{ label: `Autoriser le contrat à prendre ${fmtAmount(initial ?? 0n, K.decimals)} ${K.symbol} (transaction, une fois)` }]
            : []),
          ...(needsDelegation ? [{ label: `Signer la délégation de crédit ${D.token.symbol} (signature, sans gas)` }] : []),
          {
            label:
              kind === 'swap'
                ? `Signer la transaction : swap ${K.symbol} → ${C.token.symbol}, flash loan, swap et dépôt en une fois`
                : 'Signer la transaction : flash loan, swap et dépôt en une fois',
          },
        ]),
  ]
  const liqPrice =
    proj && Number.isFinite(proj.healthFactor) && !unreal ? fmtPrice(BigInt(Math.round(Number(C.price) * (1 - proj.dropToLiquidation)))) : proj ? NA : undefined
  const counted = yields.filter((y) => y.apy > 0).length

  // the position in one picture: today's projection, and its health factor in 90 days at today's rates
  const bar =
    proj && !unreal && proj.debtBase > 0n && Number.isFinite(proj.healthFactor) ? (
      <PositionBar
        healthFactor={proj.healthFactor}
        liquidationThreshold={thresholdOf(proj.healthFactor, Number(proj.collateralBase), Number(proj.debtBase))}
        correlated={correlated}
        projectedHf={projectHealthFactor(
          proj.healthFactor,
          [
            {
              value: Number(proj.collateralBase),
              apy: C.supplyApy + (pt ? 0 : (cNative?.apy ?? 0)),
              pt: pt && ptDays !== undefined ? { daysLeft: ptDays, discount: pt.discount } : undefined,
            },
          ],
          [{ value: Number(proj.debtBase), apy: D.borrowApy + (D.native?.apy ?? 0) }],
          90,
        )}
        amounts={{ collateral: Number(proj.collateralBase) / 1e8, debt: Number(proj.debtBase) / 1e8 }}
      />
    ) : undefined

  const summary = (
    <Summary
      visual={bar}
      items={[
        {
          label: 'Health factor',
          value: proj && fmtHf(proj.healthFactor),
          sub: worst && proj && fmtHf(worst.healthFactor) !== fmtHf(proj.healthFactor) ? `pire cas ${fmtHf(worst.healthFactor)}` : undefined,
          tone: proj && hfTone(proj.healthFactor, correlated),
          key: true,
        },
        {
          label: `Liquidation si ${C.token.symbol} à`,
          value: liqPrice,
          sub: proj && Number.isFinite(proj.healthFactor) && !unreal ? `baisse de ${fmtPct(proj.dropToLiquidation, 1)} face à ${D.token.symbol}` : undefined,
        },
        {
          label: 'APY net',
          value: unreal || (proj && apy === undefined) ? NA : apy !== undefined ? fmtPct(apy) : undefined,
          sub: apyParts.length > 0 && ratesApy !== undefined ? `dont ${apyParts.join(', ')}` : 'taux variables, hors coûts',
          tone: apyTone(apy),
          key: true,
        },
        {
          label: 'Coût total',
          value: unreal ? NA : costs ? fmtUsd(costs.total) : undefined,
          sub:
            !unreal &&
            costs &&
            `entrée ${fmtUsd(costs.entrySwap)} · sortie ${fmtUsd(costs.exitPremium + costs.exitSwap)} · gas ${costs.gas !== undefined ? fmtUsd(costs.gas) : 'non estimé'}`,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onOpen} title={disabledReason}>
          {busy ?? (stale ? 'Cotation…' : augment ? 'Augmenter la position' : 'Ouvrir la position')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={market} result={result} retry={{ current: slippage, set: setSlippage, sellUsd: Number(soldBase) / 1e8 }} />
    </Summary>
  )

  return (
    <LoopLayout summary={summary}>
      {head}
      <Card title={augment ? 'Augmenter la position' : 'Ouvrir une position'}>
        {hasPosition && user && (
          <p className="muted small">
            {augment
              ? `Position actuelle : levier ${fmtX(currentLev)}, health factor ${fmtHf(user.healthFactor)}. Le levier choisi s’applique à toute la position ; le capital ajouté peut être 0.`
              : `Le compte Aave a déjà des positions sur ${market.label} (levier ${fmtX(currentLev)}, health factor ${fmtHf(user.healthFactor)}) : le levier choisi s’applique à tout le compte.`}
          </p>
        )}
        <div className="grid2">
          <CapitalField
            label={capitalOptions.length > 1 ? 'Capital' : `Capital en ${C.token.symbol}`}
            balance={capBalance}
            decimals={K.decimals}
            amountText={amountText}
            setAmountText={setAmountText}
            tokenSelect={
              capitalOptions.length > 1 && (
                <select
                  aria-label="Token du capital"
                  value={capitalPick ? optionKey(capitalPick) : K.address}
                  onChange={(e) => {
                    setCapitalChoice(e.target.value)
                    setAmountText('')
                  }}
                >
                  {capitalOptions.map((t) => (
                    <option key={optionKey(t)} value={optionKey(t)}>
                      {t.native?.symbol ?? t.token.symbol}
                      {t.balance > 0n && walletValue(t) > 0n ? ` · ${fmtUsd(walletValue(t), true)}` : ''}
                    </option>
                  ))}
                </select>
              )
            }
            usd={initial !== undefined ? fmtUsd(toBase(initial, capSide)) : undefined}
            note={
              native &&
              `Converti en ${K.symbol} ${batch ? 'dans la même opération' : 'par une transaction juste avant'} ; le solde affiché garde 2 % des ${native.symbol} pour le gas.`
            }
          />
          <LeverageSlider
            value={lev}
            min={sliderMin}
            max={sliderMax}
            onChange={setLeverage}
            aside={
              <>
                {effectiveLev !== undefined && `effectif ${fmtX(effectiveLev)} · `}max {fmtX(maxLev)} (LTV {fmtPct(maxLtv, 0)})
              </>
            }
            floor={sliderMin > 1.1 ? `${fmtX(sliderMin)} : levier actuel` : undefined}
          />
        </div>

        <div className="metrics">
          <Metric
            label="Emprunt"
            value={`${fmtAmount(debtAmount, D.token.decimals)} ${D.token.symbol}`}
            sub={proj ? fmtUsd(proj.debtBase - account0.debtBase) : 'flash loan'}
          />
          <Metric
            label="Collatéral déposé"
            value={
              q && capColl !== undefined
                ? `${fmtAmount(capColl + q.buyAmount, C.token.decimals)} ${pt ? ptShortSymbol(C.token.symbol) : C.token.symbol}`
                : undefined
            }
            sub={
              q &&
              (pt && loopLev !== undefined
                ? `levier effectif ${fmtX(loopLev)}`
                : kind === 'swap' && cq
                  ? `dont ${fmtAmount(cq.buyAmount, C.token.decimals)} via le capital`
                  : `dont ${fmtAmount(q.buyAmount, C.token.decimals)} via ${quoteLabel(q)}`)
            }
          />
          <YieldMetrics
            pt={pt}
            ptExpired={ptExpired}
            ptDays={ptDays}
            fixedApy={fixedApy}
            expiredHint="à fermer ou renouveler"
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
          value={`${aggregatorLabel(aggregator)} · slippage ${fmtBps(slippage)}${slippageNote(autoSlip)}${pt ? '' : ` · ${fmtDays(horizon)}`} · ${emodeLabel}`}
        >
          {common}
          <SlippageHorizonFields slippage={slippage} setSlippage={setSlippage} pt={!!pt} horizonText={horizonText} setHorizon={setHorizon} />
          {eligible.length > 0 && (
            <label className="field">
              <span>eMode</span>
              <select value={emodeId} onChange={(e) => setChosenEMode(Number(e.target.value))}>
                <option value={0}>Aucun (LTV {fmtPct(base.collateral.config.ltvBps / 10_000, 0)})</option>
                {eligible.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} (LTV {fmtPct(c.ltvBps / 10_000, 0)}, seuil {fmtPct(c.liquidationThresholdBps / 10_000, 0)})
                  </option>
                ))}
              </select>
            </label>
          )}
        </Fold>

        {proj && loopLev !== undefined && (
          <RiskPanel
            collateral={C.token.symbol}
            debt={D.token.symbol}
            healthFactor={proj.healthFactor}
            leverage={loopLev}
            supplyApy={C.supplyApy + (cNative?.apy ?? 0)}
            borrowApy={D.borrowApy}
            debtNativeApy={D.native?.apy ?? 0}
            rewardsApy={rewardsApy}
            correlated={correlated}
            apy={apy}
            averageApy={averageApy}
            signals={signals}
            maturity={
              pt && pt.discount !== undefined && ptDays !== undefined && !ptExpired
                ? { days: ptDays, healthFactor: hfAtMaturity(proj.healthFactor, pt.discount, D.borrowApy, ptDays) }
                : undefined
            }
          />
        )}

        {loopLev !== undefined && !unreal && (
          <ApyBreakdown
            leverage={loopLev}
            collateralYield={C.supplyApy + (cNative?.apy ?? 0)}
            collateralLabel={pt ? `${ptShortSymbol(C.token.symbol)} (taux fixe)` : C.token.symbol}
            rewards={rewardsApy}
            rewardsLabel="Merkl"
            borrowCost={D.borrowApy + (D.native?.apy ?? 0)}
            debtLabel={D.token.symbol}
            withCosts={horizonYield}
            horizon={pt ? undefined : horizon}
          />
        )}

        {loopLev !== undefined && (
          <ApyHistory
            borrow={series.data?.borrow}
            supply={series.data?.supply}
            leverage={loopLev}
            extra={nativeApy + rewardsApy}
            pending={series.isPending && series.fetchStatus !== 'idle'}
            source="API Aave"
          />
        )}

        {pt && <PtPrices market={market} reserve={C} quote={q} />}

        {pairCampaigns.supply.length + pairCampaigns.borrow.length > 0 && (
          <Fold
            title="Bonus Merkl"
            value={rewardsApy > 0 ? `+ ${fmtPct(rewardsApy)} sur la position · ${counted} campagne${counted > 1 ? 's' : ''}` : 'aucun compté'}
          >
            <CampaignTable campaigns={[...pairCampaigns.supply, ...pairCampaigns.borrow]} yields={yields} excluded={eligibility?.excluded ?? []} borrowed={D} />
          </Fold>
        )}

        {q && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount((capCollMin ?? 0n) + q.minOut, C.token.decimals)} ${C.token.symbol}`}>
            {cq && (
              <p className="small">
                Capital : {fmtAmount(cq.sellAmount, K.decimals)} {K.symbol} → {fmtAmount(cq.buyAmount, C.token.decimals)} {C.token.symbol} via {quoteLabel(cq)},
                minimum {fmtAmount(cq.minOut, C.token.decimals)}.
              </p>
            )}
            {cq && <QuoteCompare quote={cq} token={C.token} />}
            {cq && (
              <p className="small">
                Emprunt : {fmtAmount(q.sellAmount, D.token.decimals)} {D.token.symbol} → {fmtAmount(q.buyAmount, C.token.decimals)} {C.token.symbol} via{' '}
                {quoteLabel(q)}, minimum {fmtAmount(q.minOut, C.token.decimals)}.
              </p>
            )}
            <QuoteCompare quote={q} token={C.token} />
            {q.route && (
              <p className="small">
                Route : {q.route.map((l) => `${l.sell.symbol} → ${l.buy.symbol} (${l.via === 'pendle' ? 'Pendle' : AGGREGATORS[l.via].label})`).join(', ')}.
              </p>
            )}
            {preview && (
              <dl className="preview">
                <dt>Contrat</dt>
                <dd>{executor ?? `${market.quoteTaker} (adresse des tests sur fork, contrat non déployé)`}</dd>
                <dt>Routeur</dt>
                <dd>
                  {[...new Set([...(cq?.route?.map((l) => l.router) ?? (cq ? [cq.router] : [])), ...(q.route?.map((l) => l.router) ?? [q.router])])].join(
                    ' puis ',
                  )}
                </dd>
                <dt>Calldata open()</dt>
                <dd className="mono">{preview}</dd>
              </dl>
            )}
          </Fold>
        )}

        <Fold title="Étapes" value={batch ? 'une seule confirmation' : `${steps.length} étape${steps.length > 1 ? 's' : ''}`}>
          <Steps steps={steps} />
          {batch && <p className="muted small">Le portefeuille envoie ces opérations en un seul lot : toutes passent ou aucune.</p>}
        </Fold>
      </Card>
    </LoopLayout>
  )
}
