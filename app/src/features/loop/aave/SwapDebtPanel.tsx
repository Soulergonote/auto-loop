import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useGasPrice, useReadContracts } from 'wagmi'
import type { Address, Hash } from 'viem'
import type { AggregatorChoice, Token } from '../../../config'
import { debtTokenAbi, erc20Abi } from '../../../chain/abi'
import { useAllReserves, type EModeCategory, type Reserve, type Reserves, type UserState } from '../../../protocols/aave/useMarket'
import { headlineRewards, type Campaign } from '../../../services/merkl'
import { quoteLabel, type QuoteRequest } from '../../../services/quotes/quotes'
import { fromBase, pairPosition, positionLeverage, roundSignificant, toBase } from '../../../domain/math'
import { GAS_UNITS, swapCostBase, swapLoss, swapLossProblem } from '../../../domain/economics'
import { encodeCall, executeSwapDebt, swapDebtCall } from '../../../protocols/aave/execute'
import { executeSwapDebtBatch } from '../../../protocols/aave/batch'
import { useAtomicBatch } from '../../../chain/batch'
import { borrowCost, borrowRoom, debtTargets, fullDebtTarget, projectDebtSwap, quoteDebtSwap, type SwapDebtPlan } from '../../../protocols/aave/swapDebt'
import { fmtBps, fmtAmount, fmtDays, fmtHf, fmtPct, fmtUsd, fmtX } from '../../../ui/format'
import { outcomeLines, readOutcome } from '../../../chain/outcome'
import { isCorrelated } from '../../../domain/pairs'
import { apyTone, hfThresholds, hfTone } from '../../../ui/tone'
import { Banners, Card, Fold, LoopLayout, Metric, QuoteCompare, Segmented, Steps, Summary, TxResult, aggregatorLabel } from '../../../ui/primitives'
import { SLIPPAGES, pairKind, reserveAsset, slippageNote, useSlippage } from '../../../domain/slippage'
import { useTxAction } from '../shared/useTxAction'
import { signBlocker } from '../shared/signing'
import { DeployPanel } from '../shared/DeployPanel'

const PARTS = ['25', '50', '100'] as const
const BPS = 10_000n

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
  /** shows the pair with the new debt asset */
  onShowPair: (debt: Token) => void
  /** keeps a newly deployed executor for this market (contract deployed before swapDebt) */
  onExecutor: (a: Address) => void
  common: ReactNode
  head: ReactNode
}

/** Yield of a collateral: Aave supply rate, the token's own yield and the headline Merkl supply reward. */
const supplyYield = (r: Reserve) => r.supplyApy + (r.native?.apy ?? 0) + r.supplyRewardApr

export function SwapDebtPanel({ reserves, emode, tokens, campaigns, user, account, aggregator, onDone, onShowPair, onExecutor, common, head }: Props) {
  const { market, collateral: C, debt: D } = reserves
  const all = useAllReserves(market, tokens)
  const withRewards = (r: Reserve): Reserve => ({ ...r, borrowRewardApr: headlineRewards(campaigns, r).borrow })
  // cheapest first: the point is to follow the cheapest asset to borrow
  const targets = debtTargets(all.reserves ?? [], D.token.address, C.token.address, emode)
    .map(withRewards)
    .sort((a, b) => borrowCost(a) - borrowCost(b))
  const [targetChoice, setTargetChoice] = useState<Address>()
  // default: the cheapest asset of the same family as the current debt (a stablecoin for a stablecoin), else the cheapest
  const T = targets.find((t) => t.token.address === targetChoice) ?? targets.find((t) => isCorrelated(t, D)) ?? targets[0]
  const [part, setPart] = useState<(typeof PARTS)[number]>('100')
  const { slippage, setSlippage, auto: autoSlip } = useSlippage(T ? pairKind(reserveAsset(T), reserveAsset(D)) : 'other')
  const { busy, setBusy, result, setResult, run } = useTxAction<{ ok: boolean; text: string; hash?: Hash; to?: Token; details?: string[] }>()
  const batch = useAtomicBatch(market.chain.id, account) === true
  const gasPrice = useGasPrice({ chainId: market.chain.id, query: { refetchInterval: 30_000 } })
  const executor = market.executor ?? market.quoteTaker

  // the new asset's room (cash and borrow cap) and the account's current delegation of it to the contract
  const reads = useReadContracts({
    contracts: T
      ? [
          { chainId: market.chain.id, address: T.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [T.aToken] },
          { chainId: market.chain.id, address: T.variableDebtToken, abi: erc20Abi, functionName: 'totalSupply' },
          { chainId: market.chain.id, address: T.variableDebtToken, abi: debtTokenAbi, functionName: 'borrowAllowance', args: [account, executor] },
        ]
      : [],
    allowFailure: true,
    query: { enabled: !!T, refetchInterval: 60_000 },
  })
  const cash = reads.data?.[0]?.result as bigint | undefined
  const totalDebt = reads.data?.[1]?.result as bigint | undefined
  const borrowAllowance = (reads.data?.[2]?.result as bigint | undefined) ?? 0n
  const room = T && cash !== undefined && totalDebt !== undefined ? borrowRoom(cash, totalDebt, T.config.borrowCap, T.token.decimals) : undefined

  const full = part === '100'
  // old debt to repay, rounded so that the interest does not re-quote at every block; a full switch aims a little
  // above the debt and the contract repays the exact debt at inclusion, the rest of the old asset going back
  const repayTarget = full ? roundSignificant(fullDebtTarget(user.debtBalance), 6) : roundSignificant((user.debtBalance * BigInt(part)) / 100n, 5)
  // first estimate of the new debt at the oracle price, with room for the slippage
  const firstAmount = T ? roundSignificant(fromBase((toBase(repayTarget, D.side) * (BPS + BigInt(slippage) + 20n)) / BPS, T.side), 5) : 0n
  const req: Omit<QuoteRequest, 'sellAmount'> | undefined = T && {
    aggregator,
    chainId: market.chain.id,
    sell: T.token,
    buy: D.token,
    taker: market.quoteTaker,
    slippageBps: BigInt(slippage),
    oracle: { sell: T.side, buy: D.side },
  }
  const quote = useQuery({
    queryKey: [
      'debt-swap-quote',
      aggregator,
      market.chain.id,
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
  // a full switch repays the whole debt; a partial one repays everything the swap buys (at least its minimum)
  const repaid = q ? (full ? user.debtBalance : q.buyAmount) : 0n
  const returned = q && full && q.buyAmount > user.debtBalance ? q.buyAmount - user.debtBalance : 0n

  const repaidBase = toBase(repaid, D.side)
  const newDebtBase = T ? toBase(newDebt, T.side) : 0n
  const proj = q ? projectDebtSwap(user.account, repaidBase, newDebtBase) : undefined
  const correlated = T ? isCorrelated(C, T) : false

  // the pair's position before and after, priced on today's rates (headline Merkl rewards included)
  const posC = toBase(user.aTokenBalance, C.side)
  const posD = toBase(user.debtBalance, D.side)
  const equity = Number(posC) - Number(posD)
  const costD = borrowCost(D)
  const apyBefore = equity > 0 ? (supplyYield(C) * Number(posC) - costD * Number(posD)) / equity : undefined
  // what the swap bought above the debt goes back to the wallet: it stays the user's money, counted with the equity
  const returnedBase = toBase(returned, D.side)
  const equityAfter = Number(posC) - Number(posD - repaidBase) - Number(newDebtBase) + Number(returnedBase)
  const apyAfter =
    T && q && equityAfter > 0
      ? (supplyYield(C) * Number(posC) - costD * Number(posD - repaidBase) - borrowCost(T) * Number(newDebtBase)) / equityAfter
      : undefined
  const whole = pairPosition(user, C.side, D.side)

  const gas =
    gasPrice.data !== undefined && reserves.nativePrice !== undefined ? (GAS_UNITS.swapDebt * gasPrice.data * reserves.nativePrice) / 10n ** 18n : undefined
  const swapCost = q && T ? swapCostBase(newDebt, T.side, q.buyAmount, D.side) : undefined
  const total = swapCost !== undefined ? swapCost + (gas ?? 0n) : undefined
  // what the lower rate saves per year, against the one-off cost: days to get it back
  const savedPerYear = T && q ? (costD * Number(repaidBase) - borrowCost(T) * Number(newDebtBase - returnedBase)) / 1e8 : undefined
  const paybackDays = total !== undefined && savedPerYear !== undefined && savedPerYear > 0 ? ((Number(total) / 1e8) * 365) / savedPerYear : undefined

  const oldContract = !!market.executor && market.executorVersion === 2 && !market.executorDebtSwap
  const problems: string[] = []
  if (market.executor && market.executorVersion === 1) problems.push('Le contrat v1 ne change pas de dette : déployer le contrat v2 (bandeau en haut).')
  else if (oldContract) problems.push('Ce contrat date d’avant le changement de dette : déployer le contrat actuel (bandeau ci-dessus).')
  if (D.config.paused) problems.push(`${D.token.symbol} est en pause sur Aave.`)
  if (T && room !== undefined && newDebt > room)
    problems.push(`Pas assez de ${T.token.symbol} à emprunter sur Aave (${fmtAmount(room, T.token.decimals)} disponibles, plafond compris).`)
  if (proj && proj.healthFactor < 1.01) problems.push(`Health factor après ${fmtHf(proj.healthFactor)} : la position serait liquidable.`)
  if (quote.isError) problems.push(`Cotation impossible : ${(quote.error as Error).message}`)
  if (q && full && !q.simulated && q.minOut < user.debtBalance) problems.push('Le devis ne couvre pas toute la dette : relancer la cotation.')
  const warnings: string[] = []
  const lossIssue = q && T && swapLossProblem(swapLoss(newDebt, T.side, q.buyAmount, D.side), T.token.symbol, D.token.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (T && borrowCost(T) >= costD)
    warnings.push(`${T.token.symbol} coûte autant ou plus à emprunter que ${D.token.symbol} (${fmtPct(borrowCost(T))} contre ${fmtPct(costD)}).`)
  if (T && !isCorrelated(T, D))
    warnings.push(`${T.token.symbol} et ${D.token.symbol} n’évoluent pas ensemble : la dette, et donc le health factor, suit désormais ${T.token.symbol}.`)
  if (paybackDays !== undefined && paybackDays > 365)
    warnings.push(`L’écart de taux met ${fmtDays(Math.ceil(paybackDays))} à rembourser le coût du changement, aux taux actuels.`)
  if (proj && Number.isFinite(proj.healthFactor) && proj.healthFactor < hfThresholds(correlated).ok)
    warnings.push(`Health factor après changement : ${fmtHf(proj.healthFactor)}, proche de la liquidation.`)
  if (user.account.debtBase > posD + 100n * 10n ** 8n)
    warnings.push('Le compte Aave a d’autres dettes : le health factor affiché tient compte de tout le compte.')

  const plan = (fresh = q): SwapDebtPlan | undefined =>
    fresh && T
      ? {
          chainId: market.chain.id,
          executor,
          user: account,
          from: D.token.address,
          to: T.token.address,
          toDebtToken: T.variableDebtToken,
          full,
          newDebtAmount: fresh.sellAmount,
          quote: fresh,
          minRepaid: full ? 0n : fresh.minOut,
          // a little room for prices moving between the quote and inclusion
          minHealthFactor: proj && Number.isFinite(proj.healthFactor) ? BigInt(Math.floor(proj.healthFactor * 0.98 * 1e6)) * 10n ** 12n : 0n,
          borrowAllowance,
        }
      : undefined

  const preview = (() => {
    try {
      const p = plan()
      return p && !p.quote.simulated ? encodeCall(swapDebtCall(p)) : undefined
    } catch {
      return undefined
    }
  })()

  const empty = user.debtBalance === 0n
  const canSign = !empty && !!market.executor && !!q && !q.simulated && !!preview && problems.length === 0 && !quote.isFetching && !busy
  const disabledReason = empty ? `Aucune dette en ${D.token.symbol}` : signBlocker({ executor: market.executor, simulated: q?.simulated, problems })

  async function onSwap() {
    await run(async () => {
      setBusy('Nouvelle cotation…')
      const fresh = await quoteDebtSwap(req!, firstAmount, full ? repayTarget : undefined)
      if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      const p = plan(fresh)!
      const hash = batch ? await executeSwapDebtBatch(p, setBusy) : await executeSwapDebt(p, setBusy)
      // what the contract really repaid and borrowed, instead of the estimate
      const outcome = await readOutcome(market.chain.id, hash, p.executor, p.user)
      const expected = full && fresh.buyAmount > user.debtBalance ? fresh.buyAmount - user.debtBalance : undefined
      const details = outcome && outcomeLines(outcome, [C.token, D.token, T!.token], { debtReturned: expected })
      setResult({ ok: true, text: `Dette changée : ${T!.token.symbol}.`, hash, to: T!.token, details })
      onDone()
    })
  }

  const needsDelegation = borrowAllowance < newDebt
  const steps = batch
    ? [
        ...(needsDelegation && T ? [{ label: `Déléguer l’emprunt de ${T.token.symbol} au contrat (montant exact)` }] : []),
        { label: 'Changer de dette : flash loan, swap et remboursement' },
        ...(needsDelegation ? [{ label: 'Remettre la délégation d’emprunt à sa valeur' }] : []),
      ]
    : [
        ...(needsDelegation && T ? [{ label: `Signer la délégation d’emprunt de ${T.token.symbol} (signature, sans gas)` }] : []),
        { label: 'Signer la transaction : flash loan, swap et remboursement en une fois' },
      ]

  const summary = (
    <Summary
      items={[
        {
          label: 'Health factor après',
          value: proj && fmtHf(proj.healthFactor),
          sub: `avant ${fmtHf(user.healthFactor)}`,
          tone: proj && hfTone(proj.healthFactor, correlated),
          key: true,
        },
        {
          label: 'Liquidation si baisse de',
          value: proj ? (Number.isFinite(proj.healthFactor) ? fmtPct(proj.dropToLiquidation, 1) : '—') : undefined,
          sub: T && `${C.token.symbol} face aux dettes`,
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
          sub:
            swapCost !== undefined &&
            `swap ${fmtUsd(swapCost)} · gas ${gas !== undefined ? fmtUsd(gas) : 'non estimé'}${paybackDays !== undefined ? ` · remboursé en ${fmtDays(Math.ceil(paybackDays))}` : ''}`,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onSwap} title={disabledReason}>
          {busy ?? (quote.isFetching ? 'Cotation…' : 'Changer de dette')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={market} result={result} retry={{ current: slippage, set: setSlippage }} />
      {result?.ok && result.to && (
        <button className="btn" onClick={() => onShowPair(result.to!)}>
          Afficher la paire {C.token.symbol} / {result.to.symbol}
        </button>
      )}
    </Summary>
  )

  // after a full switch: the result and the way to the new pair stay on screen
  if (empty)
    return (
      <LoopLayout summary={summary}>
        {head}
        <Card title="Changer de dette">
          <p className="muted">Aucune dette en {D.token.symbol} sur Aave pour cette adresse. Choisir la paire de la dette actuelle dans « Marché ».</p>
        </Card>
      </LoopLayout>
    )

  return (
    <LoopLayout summary={summary}>
      {head}
      {oldContract && <DeployPanel market={market} upgrade="debt" onReady={onExecutor} />}
      <Card title="Changer de dette">
        <div className="metrics">
          <Metric label="Collatéral" value={`${fmtAmount(user.aTokenBalance, C.token.decimals)} ${C.token.symbol}`} sub="inchangé" />
          <Metric label="Dette" value={`${fmtAmount(user.debtBalance, D.token.decimals)} ${D.token.symbol}`} sub={`coût ${fmtPct(costD)} par an`} />
          <Metric label="Levier actuel" value={fmtX(positionLeverage(whole))} />
          <Metric label="Health factor" value={fmtHf(user.healthFactor)} tone={hfTone(user.healthFactor, isCorrelated(C, D))} />
        </div>

        {all.reserves && targets.length === 0 ? (
          <p className="muted">
            Aucun autre actif empruntable {emode ? `dans l’eMode « ${emode.label} » du compte` : 'sur ce marché'}. Pour changer d’eMode : fermer la position,
            puis l’ouvrir avec un autre eMode.
          </p>
        ) : (
          <div className="grid2">
            <label className="field">
              <span>Nouvelle dette</span>
              <select value={T?.token.address ?? ''} onChange={(e) => setTargetChoice(e.target.value as Address)} disabled={!T}>
                {targets.map((t) => (
                  <option key={t.token.address} value={t.token.address}>
                    {`${t.token.symbol} (coût ${fmtPct(borrowCost(t))}${borrowCost(t) < costD ? `, ${fmtPct(costD - borrowCost(t))} de moins` : ''})`}
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
            <Metric label="Remboursé" value={q ? `${fmtAmount(repaid, D.token.decimals)} ${D.token.symbol}` : undefined} sub={q && fmtUsd(repaidBase)} />
            <Metric
              label="Nouvelle dette"
              value={q ? `${fmtAmount(newDebt, T.token.decimals)} ${T.token.symbol}` : undefined}
              sub={q && `${fmtUsd(newDebtBase)} · sans prime de flash loan`}
            />
            <Metric
              label="Économie par an"
              value={savedPerYear !== undefined ? fmtUsd(BigInt(Math.round(savedPerYear * 1e8))) : undefined}
              tone={savedPerYear !== undefined ? apyTone(savedPerYear) : undefined}
              sub={returned > 0n ? `aux taux actuels · ${fmtAmount(returned, D.token.decimals)} ${D.token.symbol} rendus au portefeuille` : 'aux taux actuels'}
            />
          </div>
        )}

        {all.error && <p className="muted small">Lecture des réserves Aave impossible : {all.error.message.split('\n')[0]}</p>}
        <Banners problems={problems} warnings={warnings} />

        <Fold title="Réglages" value={`${aggregatorLabel(aggregator)} · slippage ${fmtBps(slippage)}${slippageNote(autoSlip)}`}>
          {common}
          <div className="field">
            <span>Slippage max</span>
            <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtBps(s) }))} />
          </div>
        </Fold>

        {q && (
          <Fold title="Devis" value={`${quoteLabel(q)} · minimum ${fmtAmount(q.minOut, D.token.decimals)} ${D.token.symbol}`}>
            <QuoteCompare quote={q} token={D.token} />
            {preview && (
              <dl className="preview">
                <dt>{q.route ? 'Routeurs' : 'Routeur'}</dt>
                <dd>{q.route ? q.route.map((l) => l.router).join(' puis ') : q.router}</dd>
                <dt>Calldata swapDebt()</dt>
                <dd className="mono">{preview}</dd>
              </dl>
            )}
          </Fold>
        )}

        <Fold title="Étapes" value={batch ? 'une seule confirmation' : `${steps.length} étape${steps.length > 1 ? 's' : ''}`}>
          <Steps steps={steps} />
          <p className="muted small">
            Le contrat emprunte la nouvelle dette en flash loan Aave sans prime (elle devient la dette du compte), la vend contre l’ancienne et rembourse
            celle-ci, dans la même transaction. Le collatéral ne bouge pas. Pour tout changer, le montant emprunté couvre la dette même au pire du slippage : ce
            que le swap rend en plus revient au portefeuille. Coût = taux d’emprunt + rendement propre du token − récompense Merkl.
            {batch && ' Le portefeuille envoie ces opérations en un seul lot : toutes passent ou aucune.'}
          </p>
        </Fold>
      </Card>
    </LoopLayout>
  )
}
