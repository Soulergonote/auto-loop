import { useState, type ReactNode } from 'react'
import { useGasPrice, useReadContract } from 'wagmi'
import type { Address, Hash } from 'viem'
import { MORPHO_BLUE, type AggregatorChoice, type Token } from '../config'
import { erc20Abi } from '../abi'
import { useAllReserves, type EModeCategory, type Reserve, type Reserves, type UserState } from '../lib/useMarket'
import { headlineRewards, type Campaign } from '../lib/merkl'
import { useQuote } from '../lib/useQuote'
import { getQuote, quoteLabel } from '../lib/quotes'
import { flashLoanOwed, pairPosition, positionLeverage, roundSignificant, toBase } from '../lib/math'
import { GAS_UNITS, GAS_UNITS_PT, swapCostBase, swapLoss, swapLossProblem } from '../lib/economics'
import { encodeCall, executeSwapCollateral, explainError, swapCollateralCall } from '../lib/execute'
import { executeSwapCollateralBatch, useAtomicBatch } from '../lib/oneClick'
import { aTokensToApprove, flashAmountFor, projectSwap, rollTargets, swapTargets, thresholdIn, type SwapCollateralPlan } from '../lib/swapCollateral'
import { fmtBps, fmtAmount, fmtDate, fmtHf, fmtMaturity, fmtPct, fmtUsd, fmtX } from '../lib/format'
import { isExpired } from '../lib/pendle'
import { outcomeLines, readOutcome } from '../lib/outcome'
import { isCorrelated } from '../lib/scan'
import { apyTone, hfThresholds, hfTone } from '../lib/tone'
import { Banners, Card, Fold, LoopLayout, Metric, Notice, QuoteCompare, Segmented, Steps, Summary, TxResult, aggregatorLabel } from './ui'
import { SLIPPAGES, pairKind, reserveAsset, slippageNote, useSlippage } from '../lib/slippage'

const PARTS = ['25', '50', '100'] as const

type Props = {
  /** the pair, inside the account's current eMode when it applies */
  reserves: Reserves
  /** the account's eMode category, when it is in one */
  emode?: EModeCategory
  tokens?: Token[]
  campaigns?: Campaign[]
  user: UserState
  account: Address
  aggregator: AggregatorChoice
  onDone: () => void
  /** shows the pair with the new collateral */
  onShowPair: (collateral: Token) => void
  common: ReactNode
  head: ReactNode
  /** roll a PT collateral into a later PT (« Renouveler ») instead of any collateral */
  renew?: boolean
  /** shows the close panel (a roll that needs another eMode goes through a close and a new open) */
  onClose?: () => void
  /** a roll in two steps, when the new PT cannot be flash-borrowed: close, then open it with what the close gives back */
  onTwoStep?: (to: Token, leverage: number) => void
}

/** Yield of a collateral: Aave supply rate, the token's own yield and the headline Merkl supply reward. */
const supplyYield = (r: Reserve) => r.supplyApy + (r.native?.apy ?? 0) + r.supplyRewardApr

export function SwapCollateralPanel({
  reserves,
  emode,
  tokens,
  campaigns,
  user,
  account,
  aggregator,
  onDone,
  onShowPair,
  common,
  head,
  renew,
  onClose,
  onTwoStep,
}: Props) {
  const { market, collateral: C, debt: D } = reserves
  const all = useAllReserves(market, tokens)
  const anyTarget = swapTargets(all.reserves ?? [], C.token.address, D.token.address, emode)
  const targets = renew ? rollTargets(anyTarget, C) : anyTarget
  const [targetChoice, setTargetChoice] = useState<Address>()
  // default: the next PT of the same underlying for a roll, else a collateral of the same family (WETH → wstETH), else the first one
  const T0 = targets.find((t) => t.token.address === targetChoice) ?? (renew ? targets[0] : (targets.find((t) => isCorrelated(t, C)) ?? targets[0]))
  const T: Reserve | undefined = T0 && { ...T0, supplyRewardApr: headlineRewards(campaigns, T0).supply }
  const [part, setPart] = useState<(typeof PARTS)[number]>('100')
  const { slippage, setSlippage, auto: autoSlip } = useSlippage(T ? pairKind(reserveAsset(C), reserveAsset(T), { pt: !!(C.pt || T.pt) }) : 'other')
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash; to?: Token; details?: string[] }>()
  const batch = useAtomicBatch(market.chain.id, account) === true
  const gasPrice = useGasPrice({ chainId: market.chain.id, query: { refetchInterval: 30_000 } })

  const full = part === '100'
  // rounded so that the interest the aTokens earn does not re-quote at every block; a full switch withdraws the
  // whole balance at inclusion and the unsold rest (interest since the quote) goes back to the wallet
  const fromAmount = roundSignificant((user.aTokenBalance * BigInt(part)) / 100n, full ? 6 : 5)

  const quoteReq =
    T && fromAmount > 0n
      ? {
          aggregator,
          chainId: market.chain.id,
          sell: C.token,
          buy: T.token,
          sellAmount: fromAmount,
          taker: market.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: C.side, buy: T.side },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = T && quote.data?.sellAmount === fromAmount && quote.data.sellAmount > 0n ? quote.data : undefined

  // flash loan of the new collateral: Morpho (no premium) when it holds enough of it, else the Aave pool
  const morpho = MORPHO_BLUE[market.chain.id]
  const morphoCash = useReadContract({
    chainId: market.chain.id,
    address: T?.token.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: morpho ? [morpho] : undefined,
    query: { enabled: !!morpho && !!T, refetchInterval: 60_000 },
  })
  const viaMorpho = !!morpho && !!q && morphoCash.data !== undefined && morphoCash.data >= (q.minOut * 102n) / 100n
  const flashLender: Address = viaMorpho ? morpho! : market.pool
  const premiumBps = viaMorpho ? 0n : reserves.premiumBps
  const toAmount = q ? flashAmountFor(q.minOut, premiumBps) : 0n
  const premium = flashLoanOwed(toAmount, premiumBps) - toAmount

  const removedBase = toBase(fromAmount, C.side)
  const ltT = T ? thresholdIn(T, emode) : 0
  const addedBase = q && T ? toBase(q.buyAmount - premium, T.side) : 0n
  const proj = q && T ? projectSwap(user.account, removedBase, C.config.liquidationThresholdBps, addedBase, ltT) : undefined
  const worst = q && T ? projectSwap(user.account, removedBase, C.config.liquidationThresholdBps, toBase(toAmount, T.side), ltT) : undefined
  const correlated = T ? isCorrelated(T, D) : false

  // the pair's position before and after, priced on today's rates (headline Merkl rewards included)
  const posC = toBase(user.aTokenBalance, C.side)
  const posD = toBase(user.debtBalance, D.side)
  const debtCost = D.borrowApy + (D.native?.apy ?? 0) - D.borrowRewardApr
  const apyOf = (parts: [number, bigint][]) => {
    const equity = parts.reduce((s, [, b]) => s + Number(b), 0) - Number(posD)
    return equity > 0 ? (parts.reduce((s, [y, b]) => s + y * Number(b), 0) - debtCost * Number(posD)) / equity : undefined
  }
  const apyBefore = apyOf([[supplyYield(C), posC]])
  const apyAfter =
    T && q
      ? apyOf([
          [supplyYield(C), posC - removedBase],
          [supplyYield(T), addedBase],
        ])
      : undefined
  const whole = pairPosition(user, C.side, D.side)
  const levAfter = q ? positionLeverage({ collateralBase: whole.collateralBase - removedBase + addedBase, debtBase: whole.debtBase }) : undefined

  const gas =
    gasPrice.data !== undefined && reserves.nativePrice !== undefined
      ? ((C.pt || T?.pt ? GAS_UNITS_PT : GAS_UNITS).swapCollateral * gasPrice.data * reserves.nativePrice) / 10n ** 18n
      : undefined
  const swapCost = q && T ? swapCostBase(fromAmount, C.side, q.buyAmount, T.side) : undefined
  const premiumBase = T ? toBase(premium, T.side) : 0n
  const total = swapCost !== undefined ? swapCost + premiumBase + (gas ?? 0n) : undefined

  const problems: string[] = []
  if (C.config.paused) problems.push(`${C.token.symbol} est en pause sur Aave.`)
  if (market.executor && market.executorVersion === 1) problems.push('Le contrat v1 ne change pas de collatéral : déployer le contrat v2.')
  else if ((C.pt || T?.pt) && market.executor && !market.executorPendle)
    problems.push('Ce contrat n’autorise pas le routeur Pendle : déployer le nouveau contrat (bandeau en haut).')
  // Aave lists recent PTs without flash loans: the roll then goes through a close and a new open
  const noFlash = !!q && !!T && !viaMorpho && !T.config.flashLoanEnabled
  if (noFlash && !(renew && onTwoStep))
    problems.push(`Flash loan désactivé sur ${T!.token.symbol} et Morpho n’en détient pas assez : changement impossible pour l’instant.`)
  if (worst && worst.healthFactor < 1.01)
    problems.push(`Health factor du pire cas ${fmtHf(worst.healthFactor)} : la position serait liquidable. Choisir un autre collatéral.`)
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  const warnings: string[] = []
  if (renew && T?.pt && C.pt && T.pt.sy.toLowerCase() !== C.pt.sy.toLowerCase())
    warnings.push(`${T.token.symbol} n’a pas le même actif sous-jacent que ${C.token.symbol} : le renouvellement passe par un swap entre les deux.`)
  if (renew && T?.native && T.native.apy < D.borrowApy)
    warnings.push(
      `APY fixe de ${T.token.symbol} (${fmtPct(T.native.apy)}) sous le taux d’emprunt de ${D.token.symbol} (${fmtPct(D.borrowApy)}) : la boucle perd de l’argent.`,
    )
  const lossIssue = q && T && swapLossProblem(swapLoss(fromAmount, C.side, q.buyAmount, T.side), C.token.symbol, T.token.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (proj && Number.isFinite(proj.healthFactor) && proj.healthFactor < hfThresholds(correlated).ok)
    warnings.push(`Health factor après changement : ${fmtHf(proj.healthFactor)}, proche de la liquidation.`)
  if (user.account.collateralBase > posC + 100n * 10n ** 8n)
    warnings.push('Le compte Aave a d’autres collatéraux : le health factor affiché tient compte de tout le compte.')

  const plan = (fresh = q): SwapCollateralPlan | undefined =>
    fresh && T
      ? {
          chainId: market.chain.id,
          executor: market.executor ?? market.quoteTaker,
          user: account,
          from: C.token.address,
          to: T.token.address,
          fromAToken: C.aToken,
          full,
          fromAmount,
          quote: fresh,
          toAmount: flashAmountFor(fresh.minOut, premiumBps),
          flashLender,
          // a little room for prices moving between the quote and inclusion
          minHealthFactor: worst && Number.isFinite(worst.healthFactor) ? BigInt(Math.floor(worst.healthFactor * 0.98 * 1e6)) * 10n ** 12n : 0n,
          aTokenAllowance: user.aTokenAllowance,
        }
      : undefined

  const preview = (() => {
    try {
      const p = plan()
      return p && !p.quote.simulated ? encodeCall(swapCollateralCall(p)) : undefined
    } catch {
      return undefined
    }
  })()

  const empty = user.aTokenBalance === 0n
  const twoStep = renew && noFlash && !!onTwoStep
  const canSign = !twoStep && !empty && !!market.executor && !!q && !q.simulated && !!preview && problems.length === 0 && !quote.isFetching && !busy
  const disabledReason = empty
    ? `Aucun ${C.token.symbol} en collatéral`
    : !market.executor
      ? 'Contrat pas encore déployé'
      : q?.simulated
        ? 'Devis simulé'
        : problems.length
          ? 'Bloqué : voir le bandeau rouge'
          : undefined

  async function onSwap() {
    setResult(undefined)
    try {
      setBusy('Nouvelle cotation…')
      const fresh = await getQuote(quoteReq!)
      if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      const p = plan(fresh)!
      const hash = batch ? await executeSwapCollateralBatch(p, setBusy) : await executeSwapCollateral(p, setBusy)
      // what the contract really withdrew and supplied, instead of the estimate
      const outcome = await readOutcome(market.chain.id, hash, p.executor, p.user)
      const expected = fresh.buyAmount - (flashLoanOwed(p.toAmount, premiumBps) - p.toAmount)
      const details = outcome && outcomeLines(outcome, [C.token, D.token, T!.token], { supplied: expected })
      setResult({ ok: true, text: renew ? `PT renouvelé : ${T!.token.symbol}.` : `Collatéral changé : ${T!.token.symbol}.`, hash, to: T!.token, details })
      onDone()
    } catch (e) {
      setResult({ ok: false, text: explainError(e) })
    } finally {
      setBusy(undefined)
    }
  }

  const needsPermit = user.aTokenAllowance < aTokensToApprove({ full, fromAmount })
  const steps = batch
    ? [
        ...(needsPermit ? [{ label: `Autoriser le contrat à prendre ces a${C.token.symbol} (montant exact)` }] : []),
        { label: `${renew ? 'Renouveler le PT' : 'Changer de collatéral'} : flash loan, dépôt, retrait et swap` },
        ...(needsPermit ? [{ label: `Remettre l’autorisation des a${C.token.symbol} à sa valeur` }] : []),
      ]
    : [
        ...(needsPermit ? [{ label: `Signer l’autorisation sur les a${C.token.symbol} (signature, sans gas)` }] : []),
        { label: 'Signer la transaction : flash loan, dépôt, retrait et swap en une fois' },
      ]

  const summary = (
    <Summary
      items={[
        {
          label: 'Health factor après',
          value: proj && fmtHf(proj.healthFactor),
          sub:
            worst &&
            `${proj && fmtHf(worst.healthFactor) !== fmtHf(proj.healthFactor) ? `pire cas ${fmtHf(worst.healthFactor)} · ` : ''}avant ${fmtHf(user.healthFactor)}`,
          tone: proj && hfTone(proj.healthFactor, correlated),
          key: true,
        },
        {
          label: 'Liquidation si baisse de',
          value: proj ? (Number.isFinite(proj.healthFactor) ? fmtPct(proj.dropToLiquidation, 1) : '—') : undefined,
          sub: `collatéraux face à ${D.token.symbol}`,
        },
        {
          label: 'APY net après',
          value: apyAfter !== undefined ? fmtPct(apyAfter) : undefined,
          sub: apyBefore !== undefined ? `avant ${fmtPct(apyBefore)}` : undefined,
          tone: apyTone(apyAfter),
          key: true,
        },
        {
          label: 'Coût total',
          value: total !== undefined ? fmtUsd(total) : undefined,
          sub: swapCost !== undefined && `swap ${fmtUsd(swapCost)} · prime ${fmtUsd(premiumBase)} · gas ${gas !== undefined ? fmtUsd(gas) : 'non estimé'}`,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onSwap} title={disabledReason}>
          {busy ?? (quote.isFetching ? 'Cotation…' : renew ? 'Renouveler le PT' : 'Changer de collatéral')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={market} result={result} retry={{ current: slippage, set: setSlippage }} />
      {result?.ok && result.to && (
        <button className="btn" onClick={() => onShowPair(result.to!)}>
          Afficher la paire {result.to.symbol} / {D.token.symbol}
        </button>
      )}
    </Summary>
  )

  // after a full switch: the result and the way to the new pair stay on screen
  if (empty)
    return (
      <LoopLayout summary={summary}>
        {head}
        <Card title={renew ? 'Renouveler le PT' : 'Changer de collatéral'}>
          <p className="muted">Aucun {C.token.symbol} en collatéral sur Aave pour cette adresse. Choisir la paire du collatéral actuel dans « Marché ».</p>
        </Card>
      </LoopLayout>
    )

  return (
    <LoopLayout summary={summary}>
      {head}
      <Card title={renew ? 'Renouveler le PT' : 'Changer de collatéral'}>
        <div className="metrics">
          <Metric label="Collatéral" value={`${fmtAmount(user.aTokenBalance, C.token.decimals)} ${C.token.symbol}`} sub={fmtUsd(posC)} />
          <Metric label="Dette" value={`${fmtAmount(user.debtBalance, D.token.decimals)} ${D.token.symbol}`} sub="inchangée" />
          <Metric label="Levier actuel" value={fmtX(positionLeverage(whole))} />
          <Metric label="Health factor" value={fmtHf(user.healthFactor)} tone={hfTone(user.healthFactor, isCorrelated(C, D))} />
        </div>

        {renew && C.pt && (
          <p className="muted small">
            {C.token.symbol}{' '}
            {isExpired(C.pt)
              ? `échu le ${fmtDate(C.pt.expiry)} : racheté 1 pour 1 par Pendle`
              : `échéance le ${fmtDate(C.pt.expiry)} (${fmtMaturity(C.pt.expiry)})`}
            , puis remplacé par un PT plus long, dans la même transaction. La dette ne change pas.
          </p>
        )}
        {renew && all.reserves && targets.length === 0 ? (
          <Notice tone="bad">
            <span>
              Aucun PT plus long accepté {emode ? `par l’eMode « ${emode.label} » du compte` : 'sur ce marché'}. Pour en prendre un dans un autre eMode : fermer
              la position, puis l’ouvrir sur le nouveau PT.
            </span>
            {onClose && (
              <button className="btn" onClick={onClose}>
                Fermer la position
              </button>
            )}
          </Notice>
        ) : all.reserves && targets.length === 0 ? (
          <p className="muted">
            Aucun autre collatéral accepté {emode ? `par l’eMode « ${emode.label} » du compte` : 'sur ce marché'}. Pour changer d’eMode : fermer la position,
            puis l’ouvrir avec un autre eMode.
          </p>
        ) : (
          <div className="grid2">
            <label className="field">
              <span>{renew ? 'Nouveau PT' : 'Nouveau collatéral'}</span>
              <select value={T?.token.address ?? ''} onChange={(e) => setTargetChoice(e.target.value as Address)} disabled={!T}>
                {targets.map((t) => (
                  <option key={t.token.address} value={t.token.address}>
                    {t.pt
                      ? `${t.token.symbol} (${fmtMaturity(t.pt.expiry)}, APY fixe ${fmtPct(t.native?.apy ?? 0)})`
                      : `${t.token.symbol} (seuil ${fmtPct(thresholdIn(t, emode) / 10_000, 0)}, dépôt ${fmtPct(supplyYield(t))})`}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Part à changer</span>
              <Segmented value={part} onChange={setPart} options={PARTS.map((x) => ({ value: x, label: x === '100' ? 'Tout' : `${x} %` }))} />
            </div>
          </div>
        )}

        {T && (
          <div className="metrics">
            <Metric label="Retiré" value={`${fmtAmount(fromAmount, C.token.decimals)} ${C.token.symbol}`} sub={fmtUsd(removedBase)} />
            <Metric
              label="Déposé"
              value={q ? `${fmtAmount(q.buyAmount - premium, T.token.decimals)} ${T.token.symbol}` : undefined}
              sub={q && `minimum ${fmtAmount(toAmount, T.token.decimals)}`}
            />
            <Metric label="Levier après" value={levAfter !== undefined ? fmtX(levAfter) : undefined} sub="dette inchangée" />
          </div>
        )}

        {twoStep && T && (
          <Notice>
            <span>
              Aave ne prête pas {T.token.symbol} en flash loan et Morpho n’en détient pas assez : le renouvellement se fait en deux transactions. Fermer la
              position (le {C.token.symbol} restant revient au portefeuille), puis ouvrir {T.token.symbol} au même levier avec ce {C.token.symbol} comme
              capital. Entre les deux, aucune position n’est ouverte.
            </span>
            <button className="btn" onClick={() => onTwoStep!(T.token, positionLeverage(whole))}>
              Fermer, puis ouvrir {T.token.symbol}
            </button>
          </Notice>
        )}
        {all.error && <Notice>Lecture des réserves Aave impossible : {all.error.message.split('\n')[0]}</Notice>}
        <Banners problems={problems} warnings={warnings} />

        <Fold
          title="Réglages"
          value={`${aggregatorLabel(aggregator)} · slippage ${fmtBps(slippage)}${slippageNote(autoSlip)} · ${viaMorpho ? 'flash loan Morpho sans prime' : `prime flash loan Aave ${fmtPct(Number(reserves.premiumBps) / 10_000)}`}`}
        >
          {common}
          <div className="field">
            <span>Slippage max</span>
            <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtBps(s) }))} />
          </div>
        </Fold>

        {q && T && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(q.minOut, T.token.decimals)} ${T.token.symbol}`}>
            <QuoteCompare quote={q} token={T.token} />
            {preview && (
              <dl className="preview">
                <dt>{q.route ? 'Routeurs' : 'Routeur'}</dt>
                <dd>{q.route ? q.route.map((l) => l.router).join(' puis ') : q.router}</dd>
                <dt>Calldata swapCollateral()</dt>
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
