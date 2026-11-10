import { useEffect, useState, type ReactNode } from 'react'
import { type Address, type Hash } from 'viem'
import { useReadContract } from 'wagmi'
import { MORPHO_BLUE, type AggregatorChoice } from '../config'
import { erc20Abi } from '../abi'
import type { Reserves, UserState } from '../lib/useMarket'
import { useQuote } from '../lib/useQuote'
import { getQuote, quoteLabel } from '../lib/quotes'
import { daysToMaturity, isExpired } from '../lib/pendle'
import { collateralToSellForRepay, flashLoanOwed, pairPosition, positionLeverage, repayForTarget, roundSignificant, toBase } from '../lib/math'
import { useDebounced } from '../lib/useDebounced'
import { swapLoss, swapLossProblem } from '../lib/economics'
import { closeCall, encodeCall, executeClose, explainError, type ClosePlan } from '../lib/execute'
import { executeCloseBatch, useAtomicBatch } from '../lib/oneClick'
import { fmtBps, fmtAmount, fmtDate, fmtHf, fmtPct, fmtUsd, fmtX } from '../lib/format'
import { outcomeLines, readOutcome } from '../lib/outcome'
import { isCorrelated } from '../lib/scan'
import { hfThresholds, hfTone } from '../lib/tone'
import { Banners, Card, Fold, LeverageSlider, LoopLayout, QuoteCompare, Metric, NA, Segmented, Steps, Summary, TxResult, aggregatorLabel } from './ui'

/** slippage choices in bps; 1 (0,01 %) by default, Azerty's choice: a tighter swap reverts sooner when the price moves */
const SLIPPAGES = ['1', '10', '50', '100'] as const

type Props = {
  reserves: Reserves
  user?: UserState
  account?: Address
  aggregator: AggregatorChoice
  onDone: () => void
  /** settings shared with the open panel, shown in the "Réglages" block */
  common: ReactNode
  /** market card and open / close tabs */
  head: ReactNode
  /** next step offered after a full close (a PT roll in two steps: open the new PT with the collateral given back) */
  then?: { label: string; run: (back: { collateral: bigint; debt: bigint }) => void }
}

/** Summary while there is nothing to close: the button stays, disabled, with the reason. */
const idleSummary = (reason: string, children?: ReactNode) => (
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
    reason={reason}
  >
    {children}
  </Summary>
)

export function ClosePanel({ reserves, user, account, aggregator, onDone, common, head, then }: Props) {
  const { market, collateral: C, debt: D, premiumBps } = reserves
  // target leverage of the pair's position; 1 = close everything
  const [target, setTarget] = useState(1)
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('1')
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash; details?: string[]; back?: { collateral: bigint; debt: bigint } }>()

  if (!user) {
    return (
      <LoopLayout summary={idleSummary('Connecter le portefeuille')}>
        {head}
        <Card title="Fermer ou réduire">
          <p className="muted">
            Portefeuille non connecté : la position {C.token.symbol} / {D.token.symbol} n’est pas lisible.
          </p>
        </Card>
      </LoopLayout>
    )
  }
  if (user.debtBalance === 0n || user.aTokenBalance === 0n) {
    return (
      // a full close lands here: its confirmation stays visible under the button
      <LoopLayout
        summary={idleSummary(
          'Aucune position à fermer',
          <>
            <TxResult market={market} result={result?.ok ? result : undefined} />
            {result?.ok && then && (
              <button className="btn" onClick={() => then.run(result.back ?? { collateral: 0n, debt: 0n })}>
                {then.label}
              </button>
            )}
          </>,
        )}
      >
        {head}
        <Card title="Fermer ou réduire">
          <p className="muted">
            Aucune position {C.token.symbol} / {D.token.symbol} sur Aave v3 pour cette adresse. Pour en ouvrir une : onglet « Ouvrir / augmenter » ; toutes les
            positions de l’adresse : onglet Positions.
          </p>
        </Card>
      </LoopLayout>
    )
  }

  return (
    <ClosePanelInner
      {...{
        market,
        C,
        D,
        premiumBps,
        user,
        account,
        aggregator,
        onDone,
        common,
        head,
        target,
        setTarget,
        slippage,
        setSlippage,
        busy,
        setBusy,
        result,
        setResult,
      }}
    />
  )
}

function ClosePanelInner(p: {
  market: Reserves['market']
  C: Reserves['collateral']
  D: Reserves['debt']
  premiumBps: bigint
  user: UserState
  account?: Address
  aggregator: AggregatorChoice
  onDone: () => void
  common: ReactNode
  head: ReactNode
  target: number
  setTarget: (x: number) => void
  slippage: (typeof SLIPPAGES)[number]
  setSlippage: (s: (typeof SLIPPAGES)[number]) => void
  busy?: string
  setBusy: (s?: string) => void
  result?: { ok: boolean; text: string; hash?: Hash; details?: string[] }
  setResult: (r?: { ok: boolean; text: string; hash?: Hash; details?: string[]; back?: { collateral: bigint; debt: bigint } }) => void
}) {
  const { market, C, D, user, account, aggregator, slippage, busy, setBusy, result, setResult } = p
  // a wallet that sends atomic batches: approval, close and approval back in one confirmation
  const batch = useAtomicBatch(market.chain.id, account) === true
  const position = pairPosition(user, C.side, D.side)
  const currentLev = positionLeverage(position)
  const sliderMax = Number.isFinite(currentLev) ? Math.max(1, Math.floor(currentLev * 20) / 20) : 15
  const lev = Math.max(1, Math.min(p.target, sliderMax))
  const debouncedLev = useDebounced(lev)
  const full = debouncedLev <= 1
  // rounded so that interest accruing on the debt does not re-quote at every block
  const repay = full ? user.debtBalance : roundSignificant(repayForTarget(position, BigInt(Math.round(debouncedLev * 10_000)), D.side), 5)
  // v2 executor: borrow the repayment from Morpho (no premium) when it holds enough of the debt asset, else from Aave
  const morpho = market.executorVersion === 2 ? MORPHO_BLUE[market.chain.id] : undefined
  const morphoCash = useReadContract({
    chainId: market.chain.id,
    address: D.token.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: morpho ? [morpho] : undefined,
    query: { enabled: !!morpho, refetchInterval: 60_000 },
  })
  const viaMorpho = !!morpho && morphoCash.data !== undefined && morphoCash.data >= (repay * 102n) / 100n
  const flashLender: Address = viaMorpho ? morpho! : market.pool
  const premiumBps = viaMorpho ? 0n : p.premiumBps
  const owed = flashLoanOwed(repay, premiumBps)
  // a PT trades at Pendle's price, not Aave's: the amount to sell is first sized at Aave's price, then corrected by the
  // quote (see the effect below) until its minimum just covers the flash loan
  const pt = C.pt
  const ptExpired = !!pt && isExpired(pt)
  const [ptScale, setPtScale] = useState(1)
  let toSell = collateralToSellForRepay(repay, premiumBps, BigInt(slippage), C.side, D.side)
  // a matured PT earns nothing more: a full close redeems all of it and the rest comes back in the debt asset
  if (pt) toSell = full && ptExpired ? user.aTokenBalance : (toSell * BigInt(Math.round(ptScale * 1e6))) / 1_000_000n
  if (toSell > user.aTokenBalance) toSell = user.aTokenBalance

  const quoteReq =
    repay > 0n
      ? {
          aggregator,
          chainId: market.chain.id,
          sell: C.token,
          buy: D.token,
          sellAmount: toSell,
          taker: market.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: C.side, buy: D.side },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = quote.data

  // full close: debt keeps accruing until execution, keep a small margin over what the flash loan will claim
  const required = full ? (owed * 10_005n) / 10_000n : owed
  const coversDebt = q ? q.minOut >= required : undefined
  useEffect(() => {
    if (!pt || (full && ptExpired) || !q || q.simulated || q.sellAmount !== toSell || q.minOut === 0n) return
    const ratio = Number(required) / Number(q.minOut)
    // short of the repayment, or selling more than 1 % too much: resize (0,1 % of room), at most the whole balance
    if (ratio > 1 || (ratio < 0.99 && !full)) setPtScale((x) => Math.min(x * ratio * 1.001, 10))
  }, [pt, ptExpired, q, toSell, required, full])

  const remainingDebtBase = user.account.debtBase - toBase(repay, D.side)
  const hfAfter =
    full || remainingDebtBase <= 0n
      ? Infinity
      : (Number(user.account.collateralBase) * Number(user.account.liquidationThresholdBps) -
          Number(toBase(toSell, C.side)) * C.config.liquidationThresholdBps) /
        10_000 /
        Number(remainingDebtBase)

  const levAfter = full
    ? 1
    : positionLeverage({ collateralBase: position.collateralBase - toBase(toSell, C.side), debtBase: position.debtBase - toBase(repay, D.side) })
  const collatBack = full ? user.aTokenBalance - toSell : 0n
  const debtBack = q && q.buyAmount > owed ? q.buyAmount - owed : 0n

  const problems: string[] = []
  // part of the debt is backed by another collateral of the account: this one alone cannot repay it all
  const shortOfCollateral = toBase(user.aTokenBalance, C.side) * 10_000n < toBase(owed, D.side) * (10_000n + BigInt(slippage) + 30n)
  if (shortOfCollateral)
    problems.push(
      `Le ${C.token.symbol} déposé ne couvre pas ce remboursement : une partie de la dette repose sur un autre collatéral. Réduire moins, ou ramener d’abord tout le collatéral en ${C.token.symbol} (onglet « Changer de collatéral »).`,
    )
  if (q && coversDebt === false && !shortOfCollateral)
    problems.push(
      `Le minimum garanti du swap (${fmtAmount(q.minOut, D.token.decimals)} ${D.token.symbol}) ne couvre pas le remboursement (${fmtAmount(required, D.token.decimals)}). Baisser le slippage ou réessayer.`,
    )
  if (repay === 0n) problems.push(`Le levier visé n’est pas sous le levier actuel (${fmtX(currentLev)}). Pour l’augmenter : onglet « Ouvrir / augmenter ».`)
  if (D.config.paused || C.config.paused) problems.push('Marché en pause sur Aave.')
  if (!D.config.flashLoanEnabled) problems.push(`Flash loan désactivé sur ${D.token.symbol}.`)
  if (pt && market.executor && market.executorVersion === 1) problems.push('Le contrat v1 ne fait qu’un swap : vendre un PT demande le contrat v2.')
  else if (pt && market.executor && !market.executorPendle)
    problems.push('Ce contrat n’autorise pas le routeur Pendle : déployer le nouveau contrat (bandeau en haut).')

  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  const warnings: string[] = []
  const lossIssue = q && swapLossProblem(swapLoss(toSell, C.side, q.buyAmount, D.side), C.token.symbol, D.token.symbol, q.simulated, 0.1) // leaving stays possible at a cost, not at any cost
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  const correlated = isCorrelated(C, D)
  if (!full && hfAfter < hfThresholds(correlated).ok) warnings.push(`Health factor après réduction : ${fmtHf(hfAfter)}, encore proche de la liquidation.`)
  // a PT sold before maturity: the exit costs the pool's price, against what holding it to maturity would still earn
  const exitCostBase = q && !q.simulated ? toBase(toSell, C.side) - toBase(q.buyAmount, D.side) : undefined
  const ptDays = pt ? daysToMaturity(pt) : 0
  const accretion = pt && !ptExpired ? (pt.discount ?? pt.impliedApy ?? 0) * (ptDays / 365) : 0
  const remainingGainBase =
    pt && !ptExpired
      ? Number(toBase(user.aTokenBalance, C.side)) * (accretion / Math.max(1e-9, 1 - accretion)) -
        Number(toBase(user.debtBalance, D.side)) * D.borrowApy * (ptDays / 365)
      : undefined
  if (exitCostBase !== undefined && remainingGainBase !== undefined && full && Number(exitCostBase) > remainingGainBase && remainingGainBase > 0)
    warnings.push(
      `Sortir avant l’échéance coûte ${fmtUsd(exitCostBase > 0n ? exitCostBase : 0n)}, plus que ce que le PT rapporterait encore d’ici le ${fmtDate(pt!.expiry)} (${fmtUsd(BigInt(Math.round(remainingGainBase)))}).`,
    )
  if (user.account.collateralBase > toBase(user.aTokenBalance, C.side) + 100n * 10n ** 8n)
    warnings.push('Le compte Aave a d’autres collatéraux : le health factor affiché tient compte de tout le compte.')

  const aTokensNeeded = full ? user.aTokenBalance : toSell
  const needsPermit = user.aTokenAllowance < aTokensNeeded

  const makePlan = (quoteOverride = q): ClosePlan | undefined =>
    quoteOverride && account
      ? {
          chainId: market.chain.id,
          executor: market.executor ?? market.quoteTaker,
          version: market.executorVersion,
          flashLender,
          // the health factor may end a little lower than shown (prices move between quote and inclusion), not much
          minHealthFactor: full || !Number.isFinite(hfAfter) ? 0n : BigInt(Math.floor(hfAfter * 0.98 * 1e6)) * 10n ** 12n,
          user: account,
          collateral: C.token.address,
          debt: D.token.address,
          aToken: C.aToken,
          full,
          repayAmount: repay,
          collateralToWithdraw: toSell,
          collateralToSell: toSell,
          aTokensNeeded,
          aTokenAllowance: user.aTokenAllowance,
          quote: quoteOverride,
        }
      : undefined

  const preview = q
    ? encodeCall(
        closeCall({
          version: market.executorVersion,
          flashLender,
          collateral: C.token.address,
          debt: D.token.address,
          full,
          repayAmount: repay,
          collateralToWithdraw: toSell,
          collateralToSell: toSell,
          quote: q,
        } as ClosePlan),
      )
    : undefined

  const canSign = !!market.executor && !!account && !!q && !q.simulated && problems.length === 0 && !quote.isFetching && !busy && lev === debouncedLev
  const disabledReason = !market.executor
    ? 'Contrat pas encore déployé'
    : q?.simulated
      ? 'Devis simulé'
      : problems.length
        ? 'Bloqué : voir le bandeau rouge'
        : undefined

  async function onClose() {
    setResult(undefined)
    try {
      setBusy('Nouvelle cotation…')
      const fresh = await getQuote(quoteReq!)
      if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      if (fresh.minOut < required) throw new Error('Le nouveau devis ne couvre plus le remboursement')
      const plan = makePlan(fresh)!
      const hash = batch ? await executeCloseBatch(plan, setBusy) : await executeClose(plan, setBusy)
      // v2 emits what it really repaid, withdrew and sent back: shown instead of the estimate
      const outcome = market.executorVersion === 2 ? await readOutcome(market.chain.id, hash, plan.executor, plan.user) : undefined
      const details =
        outcome &&
        outcomeLines(outcome, [C.token, D.token], {
          collateralReturned: full ? collatBack : undefined,
          debtReturned: fresh.buyAmount > owed ? fresh.buyAmount - owed : undefined,
        })
      const back =
        outcome?.kind === 'close'
          ? { collateral: outcome.collateralReturned, debt: outcome.debtReturned }
          : { collateral: full ? collatBack : 0n, debt: fresh.buyAmount > owed ? fresh.buyAmount - owed : 0n }
      setResult({ ok: true, text: full ? 'Position fermée.' : 'Position réduite.', hash, details, back })
      p.onDone()
    } catch (e) {
      setResult({ ok: false, text: explainError(e) })
    } finally {
      setBusy(undefined)
    }
  }

  const steps = batch
    ? [
        ...(needsPermit ? [{ label: `Autoriser le contrat à prendre ces a${C.token.symbol} (montant exact)` }] : []),
        { label: 'Fermer : flash loan, remboursement, retrait et swap' },
        ...(needsPermit ? [{ label: `Remettre l’autorisation des a${C.token.symbol} à sa valeur` }] : []),
      ]
    : [
        ...(needsPermit ? [{ label: `Signer l’autorisation sur les a${C.token.symbol} (signature, sans gas)` }] : []),
        { label: 'Signer la transaction : flash loan, remboursement, retrait et swap en une fois' },
      ]

  const summary = (
    <Summary
      items={[
        {
          label: 'Dette remboursée',
          value: `${fmtAmount(repay, D.token.decimals)} ${D.token.symbol}`,
          sub: `${fmtAmount(toSell, C.token.decimals)} ${C.token.symbol} vendus`,
        },
        full
          ? { label: 'Health factor après', value: '∞', sub: 'plus de dette', key: true }
          : { label: 'Health factor après', value: fmtHf(hfAfter), tone: hfTone(hfAfter, correlated), sub: `levier ${fmtX(levAfter)}`, key: true },
        {
          label: 'Rendu',
          value:
            full && collatBack > 0n
              ? `${fmtAmount(collatBack, C.token.decimals)} ${C.token.symbol}`
              : q
                ? `${fmtAmount(debtBack, D.token.decimals)} ${D.token.symbol}`
                : undefined,
          sub:
            full && collatBack > 0n
              ? q
                ? `+ ${fmtAmount(debtBack, D.token.decimals)} ${D.token.symbol}`
                : undefined
              : full
                ? `tout le ${C.token.symbol} racheté`
                : 'surplus du swap',
        },
        ...(pt
          ? [
              {
                label: 'Coût de sortie',
                value: exitCostBase !== undefined ? fmtUsd(exitCostBase > 0n ? exitCostBase : 0n) : undefined,
                sub: ptExpired ? 'rachat 1 pour 1 par Pendle' : 'vente dans le pool Pendle',
              },
            ]
          : []),
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onClose} title={disabledReason}>
          {busy ?? (quote.isFetching ? 'Cotation…' : full ? 'Fermer la position' : 'Réduire la position')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={market} result={result} />
    </Summary>
  )

  return (
    <LoopLayout summary={summary}>
      {p.head}
      <Card title="Fermer ou réduire">
        <div className="metrics">
          <Metric
            label="Collatéral"
            value={`${fmtAmount(user.aTokenBalance, C.token.decimals)} ${C.token.symbol}`}
            sub={fmtUsd(toBase(user.aTokenBalance, C.side))}
          />
          <Metric label="Dette" value={`${fmtAmount(user.debtBalance, D.token.decimals)} ${D.token.symbol}`} sub={fmtUsd(toBase(user.debtBalance, D.side))} />
          <Metric label="Levier actuel" value={fmtX(currentLev)} />
          <Metric label="Health factor" value={fmtHf(user.healthFactor)} tone={hfTone(user.healthFactor, correlated)} />
        </div>

        <LeverageSlider
          label="Levier visé"
          value={lev}
          min={1}
          max={sliderMax}
          onChange={p.setTarget}
          aside={lev <= 1 ? 'tout fermer' : undefined}
          floor={`${fmtX(1)} : tout fermer`}
        />

        <Banners problems={problems} warnings={warnings} />

        <Fold
          title="Réglages"
          value={`${aggregatorLabel(aggregator)} · slippage ${fmtBps(slippage)} · ${viaMorpho ? 'flash loan Morpho sans prime' : `prime flash loan Aave ${fmtPct(Number(premiumBps) / 10_000)}`}`}
        >
          {p.common}
          {/* after maturity the PT is redeemed 1 for 1: no pool, nothing to slip */}
          {!ptExpired && (
            <div className="field">
              <span>Slippage max</span>
              <Segmented value={slippage} onChange={p.setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtBps(s) }))} />
            </div>
          )}
        </Fold>

        {q && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(q.minOut, D.token.decimals)} ${D.token.symbol}`}>
            <QuoteCompare quote={q} token={D.token} />
            {q.route && (
              <p className="small">
                Route :{' '}
                {q.route
                  .map(
                    (l) =>
                      `${l.sell.symbol} → ${l.buy.symbol} (${l.via === 'pendle' ? (q.pendle?.kind === 'redeem' ? 'rachat Pendle' : 'Pendle') : quoteLabel({ ...q, route: undefined, aggregator: l.via })})`,
                  )
                  .join(', ')}
                .
              </p>
            )}
            {preview && (
              <dl className="preview">
                <dt>Routeur</dt>
                <dd>{q.route ? [...new Set(q.route.map((l) => l.router))].join(' puis ') : q.router}</dd>
                <dt>Calldata close()</dt>
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
