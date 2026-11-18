import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import {
  encodeV4Action,
  executeV4SwapCollateral,
  readV4Outcome,
  swapWithdrawNeed,
  v4OutcomeLines,
  v4SwapCollateralAction,
  type V4SwapCollateralPlan,
} from '../../../protocols/aavev4/execute'
import { readV4ReserveUser, usdToUnits } from '../../../protocols/aavev4/state'
import { v4CollateralTargets, v4Hf } from '../../../protocols/aavev4/switch'
import { dropToLiquidation } from '../../../protocols/morpho/markets'
import { getQuote, quoteLabel, type QuoteRequest } from '../../../services/quotes/quotes'
import { toBase, type Side } from '../../../domain/math'
import { swapCostBase, swapLoss, swapLossProblem } from '../../../domain/economics'
import { isCorrelated } from '../../../domain/pairs'
import { pairKind, reserveAsset, useSlippage } from '../../../domain/slippage'
import { fmtAmount, fmtHf, fmtLltv, fmtPct, fmtUsd } from '../../../ui/format'
import { hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LoopLayout, Metric, NA, QuoteCompare, Segmented, Summary, TxResult } from '../../../ui/primitives'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { QuoteRoute, SettingsFold, SlippageField, StepsFold } from '../shared/folds'
import { v4SetupOf, v4SetupSteps } from './setup'
import type { V4Ctx } from './V4View'

const PARTS = ['25', '50', '100'] as const
/** what a collateral yields: lending rate, the token's own yield and the Merkl reward */
const yieldOf = (r: { supplyApy: number; underlyingApy: number; supplyRewardApy: number }) => r.supplyApy + r.underlyingApy + r.supplyRewardApy

/** « Changer de collatéral »: the position's collateral becomes another reserve of the spoke, the debt unchanged. */
export function V4SwapCollateralPanel({ ctx }: { ctx: V4Ctx }) {
  const { net, pair, state, sides, account } = ctx
  const C = pair.collateral
  const D = pair.debt
  const executor = net.executor
  const user = state.user
  const coll = user?.collateral ?? 0n
  const debt = user?.debt ?? 0n
  const others = !!user?.otherPositions

  const targets = v4CollateralTargets(ctx.reserves, pair).sort((a, b) => yieldOf(b) - yieldOf(a))
  const [choice, setChoice] = useState<number>()
  // default: a collateral of the same family (an ETH for an ETH), else the best yield
  const T =
    targets.find((t) => t.reserveId === choice) ??
    targets.find((t) => isCorrelated({ price: t.price, token: t.token }, { price: sides.collateral.price, token: C.token })) ??
    targets[0]
  const [part, setPart] = useState<(typeof PARTS)[number]>('100')
  const full = part === '100'
  const { slippage, setSlippage, auto: autoSlip } = useSlippage(T ? pairKind(reserveAsset(C), reserveAsset(T)) : 'other')
  const tx = useTxAction<{ ok: boolean; text: string; hash?: `0x${string}`; details?: string[]; to?: number }>()
  const { busy, setBusy, result, setResult, run } = tx

  const target = useQuery({
    queryKey: ['v4-reserve-user', net.id, T?.spoke.address, T?.reserveId, account, executor],
    queryFn: () => readV4ReserveUser(net, T!, account!, executor),
    enabled: !!T && !!account,
    refetchInterval: 30_000,
  })
  const tu = target.data
  const tSide: Side | undefined = T && { price: tu?.price ?? T.price, decimals: T.token.decimals }

  const fromAmount = full ? coll : (coll * BigInt(part)) / 100n
  const req: QuoteRequest | undefined =
    T && tSide && fromAmount > 0n
      ? {
          aggregator: ctx.aggregator,
          chainId: net.chain.id,
          sell: C.token,
          buy: T.token,
          sellAmount: fromAmount,
          taker: net.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: sides.collateral, buy: tSide },
        }
      : undefined
  const quote = useQuery({
    queryKey: ['v4-coll-swap-quote', ctx.aggregator, net.chain.id, C.token.address, T?.token.address, fromAmount.toString(), slippage],
    queryFn: ({ signal }) => getQuote(req!, signal),
    enabled: !!req,
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: false,
  })
  const q = T ? quote.data : undefined
  // the flash loan is free: the new collateral borrowed is what the swap guarantees at least
  const toAmount = q?.minOut ?? 0n

  const collValue = toBase(coll, sides.collateral)
  const debtValue = toBase(debt, sides.loan)
  const leftValue = toBase(coll - fromAmount, sides.collateral)
  const addedValue = tSide ? toBase(q?.buyAmount ?? 0n, tSide) : 0n
  const hfBefore = v4Hf([{ value: collValue, factor: C.collateralFactor }], debtValue)
  const hfAfter =
    T && q
      ? v4Hf(
          [
            { value: leftValue, factor: C.collateralFactor },
            { value: addedValue, factor: T.collateralFactor },
          ],
          debtValue,
        )
      : undefined
  const correlatedBefore = isCorrelated({ price: sides.collateral.price, token: C.token }, { price: sides.loan.price, token: D.token })
  const correlated = T ? isCorrelated({ price: tSide!.price, token: T.token }, { price: sides.loan.price, token: D.token }) : false
  const borrowNet = ctx.borrowApy - ctx.borrowRewardApy
  const equity = Number(collValue - debtValue)
  const apyBefore = equity > 0 ? (yieldOf(C) * Number(collValue) - borrowNet * Number(debtValue)) / equity : undefined
  const apyAfter =
    T && q && equity > 0
      ? (yieldOf(C) * Number(leftValue) + yieldOf(T) * Number(addedValue) - borrowNet * Number(debtValue)) / Number(leftValue + addedValue - debtValue)
      : undefined

  const problems: string[] = []
  const warnings: string[] = []
  if (T && tu && toAmount > tu.flashLiquidity)
    problems.push(`Flash loan trop grand : Morpho Blue ne détient que ${fmtAmount(tu.flashLiquidity, T.token.decimals)} ${T.token.symbol} sur ce réseau.`)
  if (T && tSide && toAmount > usdToUnits(T.suppliableUsd, tSide.price, T.token.decimals))
    problems.push(`Plafond de dépôt de ${T.token.symbol} atteint dans ce spoke.`)
  if (!others && hfAfter !== undefined && hfAfter < 1.01) problems.push(`Health factor après ${fmtHf(hfAfter)} : la position serait liquidable.`)
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  const lossIssue =
    q && T && tSide && swapLossProblem(swapLoss(q.sellAmount, sides.collateral, q.buyAmount, tSide), C.token.symbol, T.token.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (!others && hfAfter !== undefined && Number.isFinite(hfAfter) && hfAfter < hfThresholds(correlated).ok)
    warnings.push(`Health factor après changement : ${fmtHf(hfAfter)}, proche de la liquidation.`)
  if (target.isError) problems.push(`Lecture de la réserve ${T?.token.symbol} impossible : ${(target.error as Error).message.split('\n')[0]}`)
  if (T && correlatedBefore && !correlated)
    warnings.push(`${T.token.symbol} et ${D.token.symbol} n’évoluent pas ensemble : le health factor suit désormais leur rapport.`)
  if (others)
    warnings.push('Ce compte a d’autres positions dans ce spoke : le contrat ne vérifie que la règle du spoke (health factor du compte au-dessus de 1).')

  const plan = (fresh = q): V4SwapCollateralPlan | undefined =>
    executor && account && T && fresh
      ? {
          net,
          executor,
          user: account,
          spoke: C.spoke.address,
          collateralId: T.reserveId,
          debtId: D.reserveId,
          collateralToken: T.token.address,
          debtToken: D.token.address,
          minHealthFactor: others || hfAfter === undefined ? 0n : BigInt(Math.floor(Math.min(hfAfter, 1e6) * 0.98 * 1e6)) * 10n ** 12n,
          // the new collateral's flag; the managers are those of the spoke
          setup: { ...v4SetupOf(user), collateral: !tu?.collateralEnabled },
          fromId: C.reserveId,
          fromToken: C.token.address,
          full,
          fromAmount,
          quote: fresh,
          toAmount: fresh.minOut,
          withdrawAllowance: user?.withdrawAllowance ?? 0n,
        }
      : undefined
  const preview = (() => {
    try {
      const p = plan()
      return p && encodeV4Action(v4SwapCollateralAction(p))
    } catch {
      return undefined
    }
  })()
  const canSign = !!preview && !!tu && problems.length === 0 && !quote.isFetching && !busy
  const disabledReason = coll === 0n ? `Aucun dépôt ${C.token.symbol} dans ce spoke` : signBlocker({ executor, account, simulated: q?.simulated, problems })

  async function onSwap() {
    await run(async () => {
      setBusy('Nouvelle cotation…')
      const fresh = await getQuote(req!)
      if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      const p = plan(fresh)!
      const hash = await executeV4SwapCollateral(p, { batch: ctx.batch, nonce: user?.permitNonce ?? 0n, permit: ctx.permit }, setBusy)
      const outcome = await readV4Outcome(net.chain.id, hash, p.executor, p.user)
      setResult({
        ok: true,
        text: `Collatéral changé : ${T!.token.symbol}.`,
        hash,
        details: outcome && v4OutcomeLines(outcome, T!.token, D.token, C.token),
        to: T!.reserveId,
      })
      ctx.onDone()
    })
  }

  const setup = T ? { ...v4SetupOf(user), collateral: !tu?.collateralEnabled } : v4SetupOf(user)
  const needsWithdraw = (user?.withdrawAllowance ?? 0n) < swapWithdrawNeed({ full, fromAmount })
  const steps = ctx.batch
    ? [
        ...v4SetupSteps(setup, true),
        ...(needsWithdraw ? [{ label: `Autoriser le contrat à retirer le ${C.token.symbol}, le temps du lot` }] : []),
        { label: 'Changer de collatéral : flash loan Morpho, dépôt du nouveau, retrait et swap de l’ancien' },
        ...(needsWithdraw ? [{ label: 'Remettre l’autorisation de retrait à sa valeur' }] : []),
      ]
    : [
        ...v4SetupSteps(setup, false),
        ...(needsWithdraw
          ? [
              {
                label: ctx.permit
                  ? `Signer un message (sans gas) : autoriser le contrat à retirer le ${C.token.symbol}, pour cette transaction seulement`
                  : `Autoriser le contrat à retirer le ${C.token.symbol} (transaction)`,
              },
            ]
          : []),
        { label: 'Signer la transaction : flash loan, dépôt, retrait et swap en une fois' },
        ...(needsWithdraw && !ctx.permit ? [{ label: 'Retirer l’autorisation de retrait (transaction)' }] : []),
      ]

  const summary = (
    <Summary
      tx={tx}
      items={[
        {
          label: 'Health factor après',
          value: others ? NA : hfAfter !== undefined ? fmtHf(hfAfter) : undefined,
          sub: others
            ? 'd’autres positions comptent dans ce spoke'
            : hfAfter !== undefined && Number.isFinite(hfAfter)
              ? `avant ${fmtHf(hfBefore)} · liquidation si baisse de ${fmtPct(dropToLiquidation(hfAfter), 1)}`
              : `avant ${fmtHf(hfBefore)}`,
          tone: !others && hfAfter !== undefined ? hfTone(hfAfter, correlated) : undefined,
          key: true,
        },
        {
          label: 'APY net après',
          value: apyAfter !== undefined ? fmtPct(apyAfter) : undefined,
          sub: apyBefore !== undefined ? `avant ${fmtPct(apyBefore)}` : undefined,
          key: true,
        },
        {
          label: 'Coût du swap',
          value: q && tSide ? fmtUsd(swapCostBase(q.sellAmount, sides.collateral, q.buyAmount, tSide)) : undefined,
          sub: 'flash loan Morpho gratuit',
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onSwap} title={disabledReason}>
          {busy ?? (quote.isFetching ? 'Cotation…' : 'Changer de collatéral')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={net} result={result} retry={{ current: slippage, set: setSlippage }} />
      {result?.ok && result.to !== undefined && T && (
        <button className="btn" onClick={() => ctx.onPick({ spoke: C.spoke.address, collateralId: result.to!, debtId: D.reserveId }, 'close')}>
          Afficher la paire {T.token.symbol} / {D.token.symbol}
        </button>
      )}
    </Summary>
  )

  if (coll === 0n)
    return (
      <LoopLayout summary={summary}>
        {ctx.head}
        <Card title="Changer de collatéral">
          <p className="muted">
            {account
              ? `Aucun dépôt ${C.token.symbol} dans le spoke ${C.spoke.name} pour cette adresse. Choisir la paire de la position dans « Marché ».`
              : 'Portefeuille non connecté : la position n’est pas lisible.'}
          </p>
        </Card>
      </LoopLayout>
    )

  return (
    <LoopLayout summary={summary}>
      {ctx.head}
      <Card title="Changer de collatéral">
        <div className="metrics">
          <Metric label="Collatéral" value={`${fmtAmount(coll, C.token.decimals)} ${C.token.symbol}`} sub={fmtUsd(collValue)} />
          <Metric label="Dette" value={`${fmtAmount(debt, D.token.decimals)} ${D.token.symbol}`} sub="inchangée" />
          <Metric label="Health factor" value={fmtHf(user?.healthFactor ?? Infinity)} tone={hfTone(user?.healthFactor ?? Infinity, false)} />
        </div>
        {targets.length === 0 ? (
          <p className="muted">Aucun autre collatéral accepté dans ce spoke.</p>
        ) : (
          <div className="grid2">
            <label className="field">
              <span>Nouveau collatéral</span>
              <select value={T?.reserveId ?? ''} onChange={(e) => setChoice(Number(e.target.value))}>
                {targets.map((t) => (
                  <option key={t.reserveId} value={t.reserveId}>
                    {`${t.token.symbol}${targets.filter((x) => x.token.symbol === t.token.symbol).length > 1 ? ` (${t.hub})` : ''} · rendement ${fmtPct(yieldOf(t))} · seuil ${fmtLltv(t.collateralFactor)}`}
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
            <Metric
              label="Vendu"
              value={`${fmtAmount(fromAmount, C.token.decimals)} ${C.token.symbol}`}
              sub={full ? 'tout, intérêts compris à l’inclusion' : undefined}
            />
            <Metric
              label="Déposé"
              value={q ? `${fmtAmount(q.buyAmount, T.token.decimals)} ${T.token.symbol}` : undefined}
              sub={q && `au moins ${fmtAmount(toAmount, T.token.decimals)}`}
            />
            <Metric label="Seuil" value={fmtLltv(T.collateralFactor)} sub={`avant ${fmtLltv(C.collateralFactor)}`} />
          </div>
        )}
        <Banners problems={problems} warnings={warnings} />
        <SettingsFold aggregator={ctx.aggregator} slippage={slippage} auto={autoSlip}>
          {ctx.common}
          <SlippageField slippage={slippage} setSlippage={setSlippage} />
        </SettingsFold>
        {q && T && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(q.minOut, T.token.decimals)} ${T.token.symbol}`}>
            <QuoteCompare quote={q} token={T.token} />
            <QuoteRoute quote={q} />
            {preview && (
              <dl className="preview">
                <dt>Contrat</dt>
                <dd>{executor as Address}</dd>
                <dt>Calldata swapCollateral()</dt>
                <dd className="mono">{preview}</dd>
              </dl>
            )}
          </Fold>
        )}
        <StepsFold steps={steps} batch={ctx.batch}>
          <p className="muted small">
            Le contrat emprunte le nouveau collatéral en flash loan Morpho (gratuit) et le dépose d’abord, retire l’ancien et le vend pour rembourser le prêt,
            dans la même transaction : le health factor ne passe jamais par un creux. La dette ne bouge pas ; ce que le swap donne en plus du minimum est déposé
            aussi.
          </p>
        </StepsFold>
      </Card>
    </LoopLayout>
  )
}
