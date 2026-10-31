import { useState } from 'react'
import { encodeFunctionData, type Address, type Hash } from 'viem'
import { AGGREGATORS, TARGET_MIN_HF, type AggregatorId } from '../config'
import { executorAbi } from '../abi'
import type { Reserves, UserState } from '../lib/useMarket'
import { useQuote } from '../lib/useQuote'
import { getQuote } from '../lib/quotes'
import { collateralToSellForRepay, flashLoanOwed, toBase } from '../lib/math'
import { closeArgs, executeClose, explainError, type ClosePlan } from '../lib/execute'
import { fmtAmount, fmtHf, fmtPct, fmtUsd } from '../lib/format'
import { Card, Metric, Notice, Segmented, Steps, TxLink, hfTone } from './ui'

const FRACTIONS = ['25', '50', '75', '100'] as const
const SLIPPAGES = ['30', '50', '100'] as const

type Props = {
  reserves: Reserves
  user?: UserState
  account?: Address
  aggregator: AggregatorId
  onDone: () => void
}

export function ClosePanel({ reserves, user, account, aggregator, onDone }: Props) {
  const { market, collateral: C, debt: D, premiumBps } = reserves
  const [fraction, setFraction] = useState<(typeof FRACTIONS)[number]>('100')
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('50')
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash }>()

  if (!user) {
    return (
      <Card title="Fermer une position">
        <p className="muted">Connecte ton portefeuille pour voir ta position {C.token.symbol} / {D.token.symbol}.</p>
      </Card>
    )
  }
  if (user.debtBalance === 0n || user.aTokenBalance === 0n) {
    return (
      <Card title="Fermer une position">
        <p className="muted">
          Aucune position {C.token.symbol} / {D.token.symbol} sur Aave v3 pour cette adresse (collatéral {fmtAmount(user.aTokenBalance, C.token.decimals)}{' '}
          {C.token.symbol}, dette {fmtAmount(user.debtBalance, D.token.decimals)} {D.token.symbol}).
        </p>
        {/* a full close lands here: keep its confirmation visible */}
        {result?.ok && <Notice tone="info">{result.text} {result.hash && <TxLink market={market} hash={result.hash} />}</Notice>}
      </Card>
    )
  }

  return (
    <ClosePanelInner
      {...{ market, C, D, premiumBps, user, account, aggregator, onDone, fraction, setFraction, slippage, setSlippage, busy, setBusy, result, setResult }}
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
  aggregator: AggregatorId
  onDone: () => void
  fraction: (typeof FRACTIONS)[number]
  setFraction: (f: (typeof FRACTIONS)[number]) => void
  slippage: (typeof SLIPPAGES)[number]
  setSlippage: (s: (typeof SLIPPAGES)[number]) => void
  busy?: string
  setBusy: (s?: string) => void
  result?: { ok: boolean; text: string; hash?: Hash }
  setResult: (r?: { ok: boolean; text: string; hash?: Hash }) => void
}) {
  const { market, C, D, premiumBps, user, account, aggregator, fraction, slippage, busy, setBusy, result, setResult } = p
  const full = fraction === '100'
  const repay = (user.debtBalance * BigInt(fraction)) / 100n
  const owed = flashLoanOwed(repay, premiumBps)
  let toSell = collateralToSellForRepay(repay, premiumBps, BigInt(slippage), C.side, D.side)
  if (toSell > user.aTokenBalance) toSell = user.aTokenBalance

  const quoteReq = {
    aggregator,
    chainId: market.chain.id,
    sell: C.token,
    buy: D.token,
    sellAmount: toSell,
    taker: market.quoteTaker,
    slippageBps: BigInt(slippage),
    oracle: { sell: C.side, buy: D.side },
  }
  const quote = useQuote(quoteReq)
  const q = quote.data

  // full close: debt keeps accruing until execution, keep a small margin over what the flash loan will claim
  const required = full ? (owed * 10_005n) / 10_000n : owed
  const coversDebt = q ? q.minOut >= required : undefined

  const remainingDebtBase = user.account.debtBase - toBase(repay, D.side)
  const hfAfter =
    full || remainingDebtBase <= 0n
      ? Infinity
      : (Number(user.account.collateralBase) * Number(user.account.liquidationThresholdBps) -
          Number(toBase(toSell, C.side)) * C.config.liquidationThresholdBps) /
        10_000 /
        Number(remainingDebtBase)

  const collatBack = full ? user.aTokenBalance - toSell : 0n
  const debtBack = q && q.buyAmount > owed ? q.buyAmount - owed : 0n

  const problems: string[] = []
  if (q && coversDebt === false) problems.push(`Le minimum garanti du swap (${fmtAmount(q.minOut, D.token.decimals)} ${D.token.symbol}) ne couvre pas le remboursement (${fmtAmount(required, D.token.decimals)}). Baisse le slippage ou réessaie.`)
  if (D.config.paused || C.config.paused) problems.push('Marché en pause sur Aave.')
  if (!D.config.flashLoanEnabled) problems.push(`Flash loan désactivé sur ${D.token.symbol}.`)

  const warnings: string[] = []
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${AGGREGATORS[aggregator].label} : ${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)
  if (!full && hfAfter < TARGET_MIN_HF) warnings.push(`Health factor après réduction : ${fmtHf(hfAfter)}.`)
  if (user.account.collateralBase > toBase(user.aTokenBalance, C.side) + 100n * 10n ** 8n)
    warnings.push('Ton compte Aave a d’autres collatéraux : le health factor affiché tient compte de tout le compte.')

  const aTokensNeeded = full ? user.aTokenBalance : toSell
  const needsPermit = user.aTokenAllowance < aTokensNeeded

  const makePlan = (quoteOverride = q): ClosePlan | undefined =>
    quoteOverride && account
      ? {
          chainId: market.chain.id,
          executor: market.executor ?? market.quoteTaker,
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
    ? encodeFunctionData({
        abi: executorAbi,
        functionName: 'close',
        args: [
          closeArgs({
            collateral: C.token.address,
            debt: D.token.address,
            full,
            repayAmount: repay,
            collateralToWithdraw: toSell,
            collateralToSell: toSell,
            quote: q,
          } as ClosePlan),
        ],
      })
    : undefined

  const canSign = !!market.executor && !!account && !!q && !q.simulated && problems.length === 0 && !quote.isFetching && !busy
  const disabledReason = !market.executor ? 'Contrat pas encore déployé' : q?.simulated ? 'Devis simulé' : problems.length ? 'Corrige les points ci-dessus' : undefined

  async function onClose() {
    setResult(undefined)
    try {
      setBusy('Nouvelle cotation…')
      const fresh = await getQuote(quoteReq)
      if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      if (fresh.minOut < required) throw new Error('Le nouveau devis ne couvre plus le remboursement')
      const hash = await executeClose(makePlan(fresh)!, setBusy)
      setResult({ ok: true, text: full ? 'Position fermée.' : 'Position réduite.', hash })
      p.onDone()
    } catch (e) {
      setResult({ ok: false, text: explainError(e) })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Card title="Fermer ou réduire">
      <div className="metrics">
        <Metric label="Collatéral" value={`${fmtAmount(user.aTokenBalance, C.token.decimals)} ${C.token.symbol}`} sub={fmtUsd(toBase(user.aTokenBalance, C.side))} />
        <Metric label="Dette" value={`${fmtAmount(user.debtBalance, D.token.decimals)} ${D.token.symbol}`} sub={fmtUsd(toBase(user.debtBalance, D.side))} />
        <Metric label="Health factor actuel" value={fmtHf(user.healthFactor)} tone={hfTone(user.healthFactor, TARGET_MIN_HF)} />
      </div>

      <div className="grid2">
        <div className="field">
          <span>Part de la dette à rembourser</span>
          <Segmented value={p.fraction} onChange={p.setFraction} options={FRACTIONS.map((f) => ({ value: f, label: f === '100' ? 'Tout' : `${f} %` }))} />
        </div>
        <div className="field">
          <span>Slippage max</span>
          <Segmented value={slippage} onChange={p.setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtPct(Number(s) / 10_000, 1) }))} />
        </div>
      </div>

      <div className="metrics">
        <Metric label="Remboursé" value={`${fmtAmount(repay, D.token.decimals)} ${D.token.symbol}`} sub={`+ prime flash loan ${fmtPct(Number(premiumBps) / 10_000)}`} />
        <Metric label="Collatéral vendu" value={`${fmtAmount(toSell, C.token.decimals)} ${C.token.symbol}`} sub={q && `→ ${fmtAmount(q.buyAmount, D.token.decimals)} ${D.token.symbol}`} />
        {full ? (
          <Metric label="Tu récupères" value={`${fmtAmount(collatBack, C.token.decimals)} ${C.token.symbol}`} sub={q && `+ ≈ ${fmtAmount(debtBack, D.token.decimals)} ${D.token.symbol}`} />
        ) : (
          <Metric label="Health factor après" value={fmtHf(hfAfter)} tone={hfTone(hfAfter, TARGET_MIN_HF)} sub={q && `+ ≈ ${fmtAmount(debtBack, D.token.decimals)} ${D.token.symbol} rendus`} />
        )}
      </div>

      {quote.isError && <Notice tone="bad">Cotation impossible : {(quote.error as Error).message}</Notice>}
      {problems.map((x) => (
        <Notice key={x} tone="bad">{x}</Notice>
      ))}
      {warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}

      <Steps
        steps={[
          ...(needsPermit ? [{ label: `Signer l’autorisation sur tes a${C.token.symbol} (signature, sans gas)` }] : []),
          { label: 'Signer la transaction : flash loan, remboursement, retrait et swap en une fois' },
        ]}
      />

      <div className="actions">
        <button className="btn primary" disabled={!canSign} onClick={onClose} title={disabledReason}>
          {busy ?? (quote.isFetching ? 'Cotation…' : full ? 'Fermer la position' : 'Réduire la position')}
        </button>
        {disabledReason && !busy && <span className="muted small">{disabledReason}</span>}
      </div>
      {result && <Notice tone={result.ok ? 'info' : 'bad'}>{result.text} {result.hash && <TxLink market={market} hash={result.hash} />}</Notice>}

      {preview && (
        <details className="preview">
          <summary>Transaction envoyée au contrat</summary>
          <dl>
            <dt>Routeur</dt>
            <dd>{q!.router}</dd>
            <dt>Calldata close()</dt>
            <dd className="mono">{preview}</dd>
          </dl>
        </details>
      )}
    </Card>
  )
}
