import { useState, type ReactNode } from 'react'
import { useGasPrice, useReadContract } from 'wagmi'
import type { Address, Hash } from 'viem'
import { AGGREGATORS, MORPHO_BLUE, type AggregatorChoice, type Token } from '../config'
import { erc20Abi } from '../abi'
import { useAllReserves, type EModeCategory, type Reserve, type Reserves, type UserState } from '../lib/useMarket'
import { headlineRewards, type Campaign } from '../lib/merkl'
import { useQuote } from '../lib/useQuote'
import { getQuote } from '../lib/quotes'
import { flashLoanOwed, positionLeverage, roundSignificant, toBase } from '../lib/math'
import { GAS_UNITS, swapCostBase, swapLoss, swapLossProblem } from '../lib/economics'
import { encodeCall, executeSwapCollateral, explainError, swapCollateralCall } from '../lib/execute'
import { executeSwapCollateralBatch, useAtomicBatch } from '../lib/oneClick'
import { aTokensToApprove, flashAmountFor, projectSwap, swapTargets, thresholdIn, type SwapCollateralPlan } from '../lib/swapCollateral'
import { fmtAmount, fmtHf, fmtPct, fmtUsd, fmtX } from '../lib/format'
import { isCorrelated } from '../lib/scan'
import { apyTone, hfThresholds, hfTone } from '../lib/tone'
import { Card, Fold, LoopLayout, Metric, Notice, QuoteCompare, Segmented, Steps, Summary, TxResult, aggregatorLabel } from './ui'

const SLIPPAGES = ['1', '10', '50', '100'] as const
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
}

/** Yield of a collateral: Aave supply rate, the token's own yield and the headline Merkl supply reward. */
const supplyYield = (r: Reserve) => r.supplyApy + (r.native?.apy ?? 0) + r.supplyRewardApr

export function SwapCollateralPanel({ reserves, emode, tokens, campaigns, user, account, aggregator, onDone, onShowPair, common, head }: Props) {
  const { market, collateral: C, debt: D } = reserves
  const all = useAllReserves(market, tokens)
  const targets = swapTargets(all.reserves ?? [], C.token.address, D.token.address, emode)
  const [targetChoice, setTargetChoice] = useState<Address>()
  // default: a collateral of the same family (WETH → wstETH), else the first one
  const T0 = targets.find((t) => t.token.address === targetChoice) ?? targets.find((t) => isCorrelated(t, C)) ?? targets[0]
  const T: Reserve | undefined = T0 && { ...T0, supplyRewardApr: headlineRewards(campaigns, T0).supply }
  const [part, setPart] = useState<(typeof PARTS)[number]>('100')
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('1')
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash; to?: Token }>()
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
  const levAfter = q ? positionLeverage({ collateralBase: posC - removedBase + addedBase, debtBase: posD }) : undefined

  const gas =
    gasPrice.data !== undefined && reserves.nativePrice !== undefined
      ? (GAS_UNITS.swapCollateral * gasPrice.data * reserves.nativePrice) / 10n ** 18n
      : undefined
  const swapCost = q && T ? swapCostBase(fromAmount, C.side, q.buyAmount, T.side) : undefined
  const premiumBase = T ? toBase(premium, T.side) : 0n
  const total = swapCost !== undefined ? swapCost + premiumBase + (gas ?? 0n) : undefined

  const problems: string[] = []
  if (C.config.paused) problems.push(`${C.token.symbol} est en pause sur Aave.`)
  if (q && T && !viaMorpho && !T.config.flashLoanEnabled)
    problems.push(`Flash loan désactivé sur ${T.token.symbol} et Morpho n’en détient pas assez : changement impossible pour l’instant.`)
  if (worst && worst.healthFactor < 1.01)
    problems.push(`Health factor du pire cas ${fmtHf(worst.healthFactor)} : la position serait liquidable. Choisir un autre collatéral.`)
  const warnings: string[] = []
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
  const canSign = !empty && !!market.executor && !!q && !q.simulated && !!preview && problems.length === 0 && !quote.isFetching && !busy
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
      setResult({ ok: true, text: `Collatéral changé : ${T!.token.symbol}.`, hash, to: T!.token })
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
        { label: 'Changer de collatéral : flash loan, dépôt, retrait et swap' },
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
          sub: worst && `pire cas ${fmtHf(worst.healthFactor)} · avant ${fmtHf(user.healthFactor)}`,
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
          {busy ?? (quote.isFetching ? 'Cotation…' : 'Changer de collatéral')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={market} result={result} />
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
        <Card title="Changer de collatéral">
          <p className="muted">Aucun {C.token.symbol} en collatéral sur Aave pour cette adresse. Choisir la paire du collatéral actuel dans « Marché ».</p>
        </Card>
      </LoopLayout>
    )

  return (
    <LoopLayout summary={summary}>
      {head}
      <Card title="Changer de collatéral">
        <div className="metrics">
          <Metric label="Collatéral" value={`${fmtAmount(user.aTokenBalance, C.token.decimals)} ${C.token.symbol}`} sub={fmtUsd(posC)} />
          <Metric label="Dette" value={`${fmtAmount(user.debtBalance, D.token.decimals)} ${D.token.symbol}`} sub="inchangée" />
          <Metric label="Levier actuel" value={fmtX(positionLeverage({ collateralBase: posC, debtBase: posD }))} />
          <Metric label="Health factor" value={fmtHf(user.healthFactor)} tone={hfTone(user.healthFactor, isCorrelated(C, D))} />
        </div>

        {all.reserves && targets.length === 0 ? (
          <p className="muted">
            Aucun autre collatéral accepté {emode ? `par l’eMode « ${emode.label} » du compte` : 'sur ce marché'}. Pour changer d’eMode : fermer la position,
            puis l’ouvrir avec un autre eMode.
          </p>
        ) : (
          <div className="grid2">
            <label className="field">
              <span>Nouveau collatéral</span>
              <select value={T?.token.address ?? ''} onChange={(e) => setTargetChoice(e.target.value as Address)} disabled={!T}>
                {targets.map((t) => (
                  <option key={t.token.address} value={t.token.address}>
                    {t.token.symbol} (seuil {fmtPct(thresholdIn(t, emode) / 10_000, 0)}, dépôt {fmtPct(supplyYield(t))})
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

        {all.error && <Notice>Lecture des réserves Aave impossible : {all.error.message.split('\n')[0]}</Notice>}
        {quote.isError && <Notice tone="bad">Cotation impossible : {(quote.error as Error).message}</Notice>}
        {problems.map((x) => (
          <Notice key={x} tone="bad">
            {x}
          </Notice>
        ))}
        {warnings.map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}

        <Fold
          title="Réglages"
          value={`${aggregatorLabel(aggregator)} · slippage ${fmtPct(Number(slippage) / 10_000)} · ${viaMorpho ? 'flash loan Morpho sans prime' : `prime flash loan Aave ${fmtPct(Number(reserves.premiumBps) / 10_000)}`}`}
        >
          {common}
          <div className="field">
            <span>Slippage max</span>
            <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtPct(Number(s) / 10_000) }))} />
          </div>
        </Fold>

        {q && T && (
          <Fold title="Devis" value={`${AGGREGATORS[q.aggregator].label} · minimum ${fmtAmount(q.minOut, T.token.decimals)} ${T.token.symbol}`}>
            <QuoteCompare quote={q} token={T.token} />
            {preview && (
              <dl className="preview">
                <dt>Routeur</dt>
                <dd>{q.router}</dd>
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
