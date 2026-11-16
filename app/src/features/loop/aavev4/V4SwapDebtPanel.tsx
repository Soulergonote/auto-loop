import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address, Hash } from 'viem'
import { encodeV4Action, executeV4SwapDebt, readV4Outcome, v4OutcomeLines, v4SwapDebtAction, type V4SwapDebtPlan } from '../../../protocols/aavev4/execute'
import { readV4ReserveUser, usdToUnits, v4BorrowApy } from '../../../protocols/aavev4/state'
import { v4DebtTargets, v4Hf } from '../../../protocols/aavev4/switch'
import { fullDebtTarget, quoteDebtSwap } from '../../../protocols/aave/swapDebt'
import { dropToLiquidation } from '../../../protocols/morpho/markets'
import { quoteLabel, type QuoteRequest } from '../../../services/quotes/quotes'
import { fromBase, roundSignificant, toBase, type Side } from '../../../domain/math'
import { swapCostBase, swapLoss, swapLossProblem } from '../../../domain/economics'
import { isCorrelated } from '../../../domain/pairs'
import { pairKind, reserveAsset, useSlippage } from '../../../domain/slippage'
import { fmtAmount, fmtHf, fmtPct, fmtUsd } from '../../../ui/format'
import { apyTone, hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LoopLayout, Metric, NA, QuoteCompare, Segmented, Summary, TxResult } from '../../../ui/primitives'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { QuoteRoute, SettingsFold, SlippageField, StepsFold } from '../shared/folds'
import { v4SetupOf, v4SetupSteps } from './setup'
import type { V4Ctx } from './V4View'

const PARTS = ['25', '50', '100'] as const
const BPS = 10_000n

/** « Changer de dette »: the position's debt becomes another reserve of the spoke, the collateral unchanged. */
export function V4SwapDebtPanel({ ctx }: { ctx: V4Ctx }) {
  const { net, pair, state, sides, account } = ctx
  const C = pair.collateral
  const D = pair.debt
  const executor = net.executor
  const user = state.user
  const coll = user?.collateral ?? 0n
  const debt = user?.debt ?? 0n
  const others = !!user?.otherPositions
  // the account's risk premium applies to every debt of the spoke
  const costOf = (r: { borrowApy: number; borrowRewardApy: number }) => v4BorrowApy(r.borrowApy, ctx.riskPremium) - r.borrowRewardApy
  const costD = costOf(D)

  // cheapest first: the point is to follow the cheapest asset to borrow
  const targets = v4DebtTargets(ctx.reserves, pair).sort((a, b) => costOf(a) - costOf(b))
  const [choice, setChoice] = useState<number>()
  // default: the cheapest of the same family as the debt (a stablecoin for a stablecoin), else the cheapest
  const T =
    targets.find((t) => t.reserveId === choice) ??
    targets.find((t) => isCorrelated({ price: t.price, token: t.token }, { price: sides.loan.price, token: D.token })) ??
    targets[0]
  const [part, setPart] = useState<(typeof PARTS)[number]>('100')
  const full = part === '100'
  const { slippage, setSlippage, auto: autoSlip } = useSlippage(T ? pairKind(reserveAsset(T), reserveAsset(D)) : 'other')
  const { busy, setBusy, result, setResult, run } = useTxAction<{ ok: boolean; text: string; hash?: Hash; details?: string[]; to?: number }>()

  const target = useQuery({
    queryKey: ['v4-reserve-user', net.id, T?.spoke.address, T?.reserveId, account, executor],
    queryFn: () => readV4ReserveUser(net, T!, account!, executor),
    enabled: !!T && !!account,
    refetchInterval: 30_000,
  })
  const tu = target.data
  const tSide: Side | undefined = T && { price: tu?.price ?? T.price, decimals: T.token.decimals }

  // old debt to repay, rounded so that the interest does not re-quote at every block; a full switch aims a little
  // above the debt and the contract repays the exact debt at inclusion, the rest of the old asset going back
  const repayTarget = full ? roundSignificant(fullDebtTarget(debt), 6) : roundSignificant((debt * BigInt(part)) / 100n, 5)
  // first estimate of the new debt at the oracle price, with room for the slippage
  const firstAmount = tSide ? roundSignificant(fromBase((toBase(repayTarget, sides.loan) * (BPS + BigInt(slippage) + 20n)) / BPS, tSide), 5) : 0n
  const req: Omit<QuoteRequest, 'sellAmount'> | undefined = T &&
    tSide && {
      aggregator: ctx.aggregator,
      chainId: net.chain.id,
      sell: T.token,
      buy: D.token,
      taker: net.quoteTaker,
      slippageBps: BigInt(slippage),
      oracle: { sell: tSide, buy: sides.loan },
    }
  const quote = useQuery({
    queryKey: [
      'v4-debt-swap-quote',
      ctx.aggregator,
      net.chain.id,
      T?.token.address,
      D.token.address,
      firstAmount.toString(),
      repayTarget.toString(),
      full,
      slippage,
    ],
    queryFn: ({ signal }) => quoteDebtSwap(req!, firstAmount, full ? repayTarget : undefined, signal),
    enabled: !!req && firstAmount > 0n,
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: false,
  })
  const q = T ? quote.data : undefined
  const newDebt = q?.sellAmount ?? 0n
  const repaid = q ? (full ? debt : q.buyAmount) : 0n
  const returned = q && full && q.buyAmount > debt ? q.buyAmount - debt : 0n

  const collValue = toBase(coll, sides.collateral)
  const debtValue = toBase(debt, sides.loan)
  const repaidValue = toBase(repaid, sides.loan)
  const newValue = tSide ? toBase(newDebt, tSide) : 0n
  const returnedValue = toBase(returned, sides.loan)
  const hfBefore = v4Hf([{ value: collValue, factor: C.collateralFactor }], debtValue)
  const hfAfter = q ? v4Hf([{ value: collValue, factor: C.collateralFactor }], debtValue - repaidValue + newValue) : undefined
  const correlated = T ? isCorrelated({ price: sides.collateral.price, token: C.token }, { price: tSide!.price, token: T.token }) : false
  const own = C.supplyApy + C.underlyingApy + C.supplyRewardApy
  const equity = Number(collValue - debtValue)
  const apyBefore = equity > 0 ? (own * Number(collValue) - costD * Number(debtValue)) / equity : undefined
  const equityAfter = Number(collValue) - Number(debtValue - repaidValue) - Number(newValue) + Number(returnedValue)
  const apyAfter =
    T && q && equityAfter > 0 ? (own * Number(collValue) - costD * Number(debtValue - repaidValue) - costOf(T) * Number(newValue)) / equityAfter : undefined
  const savedPerYear = T && q ? (costD * Number(repaidValue) - costOf(T) * Number(newValue - returnedValue)) / 1e8 : undefined

  const problems: string[] = []
  const warnings: string[] = []
  if (T && tu && newDebt > tu.flashLiquidity)
    problems.push(`Flash loan trop grand : Morpho Blue ne détient que ${fmtAmount(tu.flashLiquidity, T.token.decimals)} ${T.token.symbol} sur ce réseau.`)
  if (T && tSide && newDebt > usdToUnits(T.borrowableUsd, tSide.price, T.token.decimals))
    problems.push(`Pas assez de ${T.token.symbol} à emprunter dans ce spoke (liquidité ou plafond).`)
  if (!others && hfAfter !== undefined && hfAfter < 1.01) problems.push(`Health factor après ${fmtHf(hfAfter)} : la position serait liquidable.`)
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  if (q && full && !q.simulated && q.minOut < debt) problems.push('Le devis ne couvre pas toute la dette : relancer la cotation.')
  const lossIssue = q && T && tSide && swapLossProblem(swapLoss(newDebt, tSide, q.buyAmount, sides.loan), T.token.symbol, D.token.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (target.isError) problems.push(`Lecture de la réserve ${T?.token.symbol} impossible : ${(target.error as Error).message.split('\n')[0]}`)
  if (T && costOf(T) >= costD)
    warnings.push(`${T.token.symbol} coûte autant ou plus à emprunter que ${D.token.symbol} (${fmtPct(costOf(T))} contre ${fmtPct(costD)}).`)
  if (T && !isCorrelated({ price: tSide!.price, token: T.token }, { price: sides.loan.price, token: D.token }))
    warnings.push(`${T.token.symbol} et ${D.token.symbol} n’évoluent pas ensemble : la dette, et donc le health factor, suit désormais ${T.token.symbol}.`)
  if (!others && hfAfter !== undefined && Number.isFinite(hfAfter) && hfAfter < hfThresholds(correlated).ok)
    warnings.push(`Health factor après changement : ${fmtHf(hfAfter)}, proche de la liquidation.`)
  if (others)
    warnings.push('Ce compte a d’autres positions dans ce spoke : le contrat ne vérifie que la règle du spoke (health factor du compte au-dessus de 1).')

  const plan = (fresh = q): V4SwapDebtPlan | undefined =>
    executor && account && T && fresh
      ? {
          net,
          executor,
          user: account,
          spoke: C.spoke.address,
          collateralId: C.reserveId,
          debtId: T.reserveId,
          collateralToken: C.token.address,
          debtToken: T.token.address,
          minHealthFactor: others || hfAfter === undefined ? 0n : BigInt(Math.floor(Math.min(hfAfter, 1e6) * 0.98 * 1e6)) * 10n ** 12n,
          setup: v4SetupOf(user),
          fromId: D.reserveId,
          fromToken: D.token.address,
          full,
          newDebtAmount: fresh.sellAmount,
          minRepaid: full ? 0n : fresh.minOut,
          quote: fresh,
          borrowAllowance: tu?.borrowAllowance ?? 0n,
        }
      : undefined
  const preview = (() => {
    try {
      const p = plan()
      return p && encodeV4Action(v4SwapDebtAction(p))
    } catch {
      return undefined
    }
  })()
  const canSign = !!preview && !!tu && problems.length === 0 && !quote.isFetching && !busy
  const disabledReason = debt === 0n ? `Aucune dette en ${D.token.symbol} dans ce spoke` : signBlocker({ executor, account, simulated: q?.simulated, problems })

  async function onSwap() {
    await run(async () => {
      setBusy('Nouvelle cotation…')
      const fresh = await quoteDebtSwap(req!, firstAmount, full ? repayTarget : undefined)
      if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      const p = plan(fresh)!
      const hash = await executeV4SwapDebt(p, { batch: ctx.batch, nonce: user?.permitNonce ?? 0n, permit: ctx.permit }, setBusy)
      const outcome = await readV4Outcome(net.chain.id, hash, p.executor, p.user)
      setResult({
        ok: true,
        text: `Dette changée : ${T!.token.symbol}.`,
        hash,
        details: outcome && v4OutcomeLines(outcome, C.token, T!.token, D.token),
        to: T!.reserveId,
      })
      ctx.onDone()
    })
  }

  const needsBorrow = (tu?.borrowAllowance ?? 0n) < newDebt
  const setupSteps = v4SetupSteps(v4SetupOf(user), ctx.batch, { collateral: false })
  const steps = ctx.batch
    ? [
        ...setupSteps,
        ...(needsBorrow && T ? [{ label: `Autoriser le contrat à emprunter le ${T.token.symbol} (montant exact)` }] : []),
        { label: 'Changer de dette : flash loan Morpho, swap, remboursement de l’ancienne dette, emprunt de la nouvelle' },
        ...(needsBorrow ? [{ label: 'Remettre l’autorisation d’emprunt à sa valeur' }] : []),
      ]
    : [
        ...setupSteps,
        ...(needsBorrow && T
          ? [
              {
                label: ctx.permit
                  ? `Signer un message (sans gas) : autoriser le contrat à emprunter le ${T.token.symbol}, pour cette transaction seulement`
                  : `Autoriser le contrat à emprunter le ${T.token.symbol} (transaction)`,
              },
            ]
          : []),
        { label: 'Signer la transaction : flash loan, swap, remboursement et emprunt en une fois' },
      ]

  const summary = (
    <Summary
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
          tone: apyTone(apyAfter),
          key: true,
        },
        {
          label: 'Économie par an',
          value: savedPerYear !== undefined ? fmtUsd(BigInt(Math.round(savedPerYear * 1e8))) : undefined,
          sub: q && tSide ? `aux taux actuels · swap ${fmtUsd(swapCostBase(newDebt, tSide, q.buyAmount, sides.loan))}` : 'aux taux actuels',
          tone: savedPerYear !== undefined ? apyTone(savedPerYear) : undefined,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onSwap} title={disabledReason}>
          {busy ?? (quote.isFetching ? 'Cotation…' : 'Changer de dette')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={net} result={result} retry={{ current: slippage, set: setSlippage }} />
      {result?.ok && result.to !== undefined && T && (
        <button className="btn" onClick={() => ctx.onPick({ spoke: C.spoke.address, collateralId: C.reserveId, debtId: result.to! }, 'close')}>
          Afficher la paire {C.token.symbol} / {T.token.symbol}
        </button>
      )}
    </Summary>
  )

  if (debt === 0n)
    return (
      <LoopLayout summary={summary}>
        {ctx.head}
        <Card title="Changer de dette">
          <p className="muted">
            {account
              ? `Aucune dette en ${D.token.symbol} dans le spoke ${C.spoke.name} pour cette adresse. Choisir la paire de la position dans « Marché ».`
              : 'Portefeuille non connecté : la position n’est pas lisible.'}
          </p>
        </Card>
      </LoopLayout>
    )

  return (
    <LoopLayout summary={summary}>
      {ctx.head}
      <Card title="Changer de dette">
        <div className="metrics">
          <Metric label="Collatéral" value={`${fmtAmount(coll, C.token.decimals)} ${C.token.symbol}`} sub="inchangé" />
          <Metric label="Dette" value={`${fmtAmount(debt, D.token.decimals)} ${D.token.symbol}`} sub={`coût ${fmtPct(costD)} par an`} />
          <Metric label="Health factor" value={fmtHf(user?.healthFactor ?? Infinity)} />
        </div>
        {targets.length === 0 ? (
          <p className="muted">Aucun autre actif empruntable dans ce spoke.</p>
        ) : (
          <div className="grid2">
            <label className="field">
              <span>Nouvelle dette</span>
              <select value={T?.reserveId ?? ''} onChange={(e) => setChoice(Number(e.target.value))}>
                {targets.map((t) => (
                  <option key={t.reserveId} value={t.reserveId}>
                    {`${t.token.symbol}${targets.filter((x) => x.token.symbol === t.token.symbol).length > 1 ? ` (${t.hub})` : ''} (coût ${fmtPct(costOf(t))}${costOf(t) < costD ? `, ${fmtPct(costD - costOf(t))} de moins` : ''})`}
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
            <Metric label="Remboursé" value={q ? `${fmtAmount(repaid, D.token.decimals)} ${D.token.symbol}` : undefined} sub={q && fmtUsd(repaidValue)} />
            <Metric
              label="Nouvelle dette"
              value={q ? `${fmtAmount(newDebt, T.token.decimals)} ${T.token.symbol}` : undefined}
              sub={q && `${fmtUsd(newValue)} · flash loan gratuit`}
            />
            <Metric
              label="Rendu"
              value={returned > 0n ? `${fmtAmount(returned, D.token.decimals)} ${D.token.symbol}` : '—'}
              sub="ce que le swap donne au-delà de la dette"
            />
          </div>
        )}
        <Banners problems={problems} warnings={warnings} />
        <SettingsFold aggregator={ctx.aggregator} slippage={slippage} auto={autoSlip}>
          {ctx.common}
          <SlippageField slippage={slippage} setSlippage={setSlippage} />
        </SettingsFold>
        {q && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(q.minOut, D.token.decimals)} ${D.token.symbol}`}>
            <QuoteCompare quote={q} token={D.token} />
            <QuoteRoute quote={q} />
            {preview && (
              <dl className="preview">
                <dt>Contrat</dt>
                <dd>{executor as Address}</dd>
                <dt>Calldata swapDebt()</dt>
                <dd className="mono">{preview}</dd>
              </dl>
            )}
          </Fold>
        )}
        <StepsFold steps={steps} batch={ctx.batch}>
          <p className="muted small">
            Le contrat emprunte la nouvelle dette en flash loan Morpho (gratuit), la vend contre l’ancienne et rembourse celle-ci, puis emprunte la nouvelle sur
            le compte pour rendre le prêt, dans la même transaction. Le collatéral ne bouge pas. Pour tout changer, le montant emprunté couvre la dette même au
            pire du slippage : ce que le swap rend en plus revient au portefeuille. Le coût tient compte de la prime de risque du compte et des récompenses
            Merkl.
          </p>
        </StepsFold>
      </Card>
    </LoopLayout>
  )
}
