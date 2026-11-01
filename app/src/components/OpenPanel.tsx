import { useMemo, useState } from 'react'
import { encodeFunctionData, parseUnits, type Address, type Hash } from 'viem'
import { AGGREGATORS, TARGET_MIN_HF, type AggregatorId } from '../config'
import { executorAbi } from '../abi'
import { campaignsForPair, rewardsOnEquity } from '../lib/merkl'
import { eligibleEModes, withEMode, type EModeCategory, type Reserves, type UserState } from '../lib/useMarket'
import { useQuote } from '../lib/useQuote'
import { useDebounced } from '../lib/useDebounced'
import { getQuote } from '../lib/quotes'
import { debtForLeverage, maxLeverage, netApy, project, EMPTY_ACCOUNT } from '../lib/math'
import { executeOpen, explainError, openArgs, type OpenPlan } from '../lib/execute'
import { fmtAmount, fmtHf, fmtPct, fmtPrice, fmtUsd, fmtX } from '../lib/format'
import { Card, Metric, Notice, Segmented, Steps, TxLink, hfTone } from './ui'

const SLIPPAGES = ['30', '50', '100'] as const

type Props = {
  reserves: Reserves
  /** all eMode categories of the market */
  emodes: EModeCategory[]
  user?: UserState
  account?: Address
  aggregator: AggregatorId
  onDone: () => void
}

export function OpenPanel({ reserves: base, emodes, user, account, aggregator, onDone }: Props) {
  const eligible = eligibleEModes(emodes, base.collateral, base.debt)
  // default: the account's current category when it fits the pair, otherwise the best one (highest LTV)
  const [chosenEMode, setChosenEMode] = useState<number>()
  const currentEMode = user?.eModeCategory ?? 0
  const emodeId =
    chosenEMode !== undefined && (chosenEMode === 0 || eligible.some((c) => c.id === chosenEMode))
      ? chosenEMode
      : eligible.some((c) => c.id === currentEMode)
        ? currentEMode
        : (eligible[0]?.id ?? 0)
  const reserves = withEMode(base, eligible.find((c) => c.id === emodeId))
  const { market, collateral: C, debt: D } = reserves
  const executor = market.executor
  const [amountText, setAmountText] = useState('1')
  const [leverage, setLeverage] = useState(2)
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('50')
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash }>()

  const maxLev = maxLeverage(C.config.ltvBps)
  const sliderMax = Math.max(1.1, Math.min(Math.floor(maxLev * 0.95 * 20) / 20, 15))
  const lev = Math.min(leverage, sliderMax)

  const initial = useMemo(() => {
    try {
      return parseUnits(amountText.replace(',', '.') || '0', C.token.decimals)
    } catch {
      return undefined
    }
  }, [amountText, C.token.decimals])

  const debouncedInitial = useDebounced(initial)
  const debouncedLevBps = useDebounced(BigInt(Math.round(lev * 10_000)))
  const debtAmount = debouncedInitial ? debtForLeverage(debouncedInitial, debouncedLevBps, C.side, D.side) : 0n

  const quoteReq =
    debtAmount > 0n
      ? {
          aggregator,
          chainId: market.chain.id,
          sell: D.token,
          buy: C.token,
          sellAmount: debtAmount,
          taker: market.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: D.side, buy: C.side },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = quote.data

  const account0 = user?.account ?? EMPTY_ACCOUNT
  const proj =
    q && debouncedInitial !== undefined
      ? project(account0, debouncedInitial + q.buyAmount, C.side, C.config.liquidationThresholdBps, debtAmount, D.side)
      : undefined
  const worst =
    q && debouncedInitial !== undefined
      ? project(account0, debouncedInitial + q.minOut, C.side, C.config.liquidationThresholdBps, debtAmount, D.side)
      : undefined
  // Aave checks the borrow against the LTV (not the liquidation threshold) when it mints the debt
  const maxLtv = C.config.ltvBps / 10_000

  const problems: string[] = []
  if (initial === undefined) problems.push('Montant invalide.')
  if (!C.config.active || C.config.paused || C.config.frozen) problems.push(`${C.token.symbol} est gelé ou en pause sur Aave.`)
  if (!D.config.borrowingEnabled || D.config.paused || D.config.frozen) problems.push(`${D.token.symbol} ne peut pas être emprunté.`)
  if (!D.config.flashLoanEnabled) problems.push(`Flash loan désactivé sur ${D.token.symbol}.`)
  if (C.config.ltvBps === 0) problems.push(`${C.token.symbol} n’est pas accepté comme collatéral (LTV 0).`)
  if (C.config.isolated) problems.push(`${C.token.symbol} est en isolation mode : non supporté par le contrat v1.`)
  if (worst && worst.ltv > maxLtv) problems.push(`LTV projetée ${fmtPct(worst.ltv)} au-dessus du maximum ${fmtPct(maxLtv)} : baisse le levier.`)
  if (user && initial && initial > user.collateralBalance) problems.push(`Solde ${C.token.symbol} insuffisant.`)

  const warnings: string[] = []
  if (proj && proj.healthFactor < TARGET_MIN_HF) warnings.push(`Health factor sous ${TARGET_MIN_HF} : une petite baisse suffit à te faire liquider.`)
  const switchEMode = !!user && currentEMode !== emodeId
  if (switchEMode && currentEMode !== 0 && (user.account.debtBase > 0n || user.account.collateralBase > 0n))
    warnings.push(`Ton compte Aave est en eMode « ${emodes.find((c) => c.id === currentEMode)?.label ?? currentEMode} » : le changer s’applique à toutes tes positions sur ce marché.`)
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${AGGREGATORS[aggregator].label} : ${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)

  const needsApprove = !!user && !!initial && user.collateralAllowance < initial
  const needsDelegation = !user || user.borrowAllowance < debtAmount
  const pairCampaigns = campaignsForPair(reserves.campaigns, C, D)
  const rewardsApy = proj ? rewardsOnEquity(pairCampaigns, proj.leverage, C.token.symbol, D.token.symbol) : 0
  const apy = proj ? netApy(proj.leverage, C.supplyApy, D.borrowApy) + rewardsApy : undefined
  for (const c of [...pairCampaigns.supply, ...pairCampaigns.borrow].filter((c) => c.conditional))
    warnings.push(`Rewards Merkl « ${c.name} » comptés dans l’APY, mais soumis à des conditions (par exemple health factor maximum ou actifs empruntés) : vérifie-les sur Merkl.`)

  const plan = (quoteOverride = q): OpenPlan | undefined =>
    quoteOverride && account && initial !== undefined
      ? {
          chainId: market.chain.id,
          executor: executor ?? market.quoteTaker,
          user: account,
          collateral: C.token.address,
          debt: D.token.address,
          variableDebtToken: D.variableDebtToken,
          initialCollateral: debouncedInitial ?? 0n,
          debtAmount,
          quote: quoteOverride,
          collateralAllowance: user?.collateralAllowance ?? 0n,
          borrowAllowance: user?.borrowAllowance ?? 0n,
          pool: market.pool,
          eModeTarget: switchEMode ? emodeId : undefined,
        }
      : undefined

  const preview = q
    ? encodeFunctionData({
        abi: executorAbi,
        functionName: 'open',
        args: [
          openArgs({
            collateral: C.token.address,
            debt: D.token.address,
            initialCollateral: debouncedInitial ?? 0n,
            debtAmount,
            quote: q,
          } as OpenPlan),
        ],
      })
    : undefined

  const stale = initial !== debouncedInitial || quote.isFetching
  const canSign = !!executor && !!account && !!q && !q.simulated && problems.length === 0 && !stale && !busy
  const disabledReason = !executor
    ? 'Contrat pas encore déployé'
    : !account
      ? 'Connecte ton portefeuille'
      : q?.simulated
        ? 'Devis simulé'
        : problems.length
          ? 'Corrige les points ci-dessus'
          : undefined

  async function onOpen() {
    setResult(undefined)
    try {
      setBusy('Nouvelle cotation…')
      // quotes expire within a few blocks: always re-quote right before signing
      const fresh = await getQuote(quoteReq!)
      if (fresh.simulated) throw new Error('Plus de devis réel disponible')
      const hash = await executeOpen(plan(fresh)!, setBusy)
      setResult({ ok: true, text: 'Position ouverte.', hash })
      onDone()
    } catch (e) {
      setResult({ ok: false, text: explainError(e) })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Card title="Ouvrir une position">
      <div className="grid2">
        <label className="field">
          <span>
            Capital initial en {C.token.symbol}
            {user && (
              <button className="link" onClick={() => setAmountText(fmtAmount(user.collateralBalance, C.token.decimals, 8).replace(/\s/g, '').replace(',', '.'))}>
                solde {fmtAmount(user.collateralBalance, C.token.decimals)}
              </button>
            )}
          </span>
          <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
          {initial !== undefined && <small className="muted">≈ {fmtUsd((initial * C.price) / 10n ** BigInt(C.token.decimals))}</small>}
        </label>
        <div className="field">
          <span>Slippage max</span>
          <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtPct(Number(s) / 10_000, 1) }))} />
        </div>
      </div>

      {eligible.length > 0 && (
        <label className="field">
          <span>eMode Aave (actifs corrélés : LTV plus haute)</span>
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

      <label className="field">
        <span>
          Levier <strong className="lev">{fmtX(lev)}</strong>
          <small className="muted"> max théorique {fmtX(maxLev)} (LTV {fmtPct(maxLtv, 0)})</small>
        </span>
        <input type="range" min={1.1} max={sliderMax} step={0.05} value={lev} onChange={(e) => setLeverage(Number(e.target.value))} />
      </label>

      <div className="metrics">
        <Metric label="Emprunt (flash loan)" value={`${fmtAmount(debtAmount, D.token.decimals)} ${D.token.symbol}`} sub={proj && fmtUsd(proj.debtBase - account0.debtBase)} />
        <Metric
          label="Collatéral déposé"
          value={q && debouncedInitial !== undefined ? `${fmtAmount(debouncedInitial + q.buyAmount, C.token.decimals)} ${C.token.symbol}` : '…'}
          sub={q && `dont ${fmtAmount(q.buyAmount, C.token.decimals)} via ${AGGREGATORS[aggregator].label}`}
        />
        <Metric label="Levier effectif" value={proj ? fmtX(proj.leverage) : '…'} sub="après coût du swap" />
        <Metric
          label="Health factor"
          value={proj ? fmtHf(proj.healthFactor) : '…'}
          sub={worst && `pire cas ${fmtHf(worst.healthFactor)}`}
          tone={proj && hfTone(proj.healthFactor, TARGET_MIN_HF)}
        />
        <Metric
          label={`Liquidation si ${C.token.symbol} à`}
          value={proj && Number.isFinite(proj.healthFactor) ? fmtPrice(BigInt(Math.round(Number(C.price) * (1 - proj.dropToLiquidation)))) : '…'}
          sub={proj && `baisse de ${fmtPct(proj.dropToLiquidation, 1)} face à ${D.token.symbol}`}
        />
        <Metric label="APY net sur le capital" value={apy !== undefined ? fmtPct(apy) : '…'} sub={rewardsApy !== 0 ? `dont ${fmtPct(rewardsApy)} de rewards Merkl, hors coût du swap` : "taux variables, hors coût du swap"} tone={apy !== undefined && apy < 0 ? 'warn' : undefined} />
      </div>

      {quote.isError && <Notice tone="bad">Cotation impossible : {(quote.error as Error).message}</Notice>}
      {problems.map((p) => (
        <Notice key={p} tone="bad">{p}</Notice>
      ))}
      {warnings.map((w) => (
        <Notice key={w}>{w}</Notice>
      ))}

      <Steps
        steps={[
          ...(switchEMode || (!user && emodeId !== 0)
            ? [{ label: emodeId === 0 ? 'Sortir de l’eMode sur ton compte Aave (transaction, une fois)' : `Passer ton compte Aave en eMode « ${reserves.emode!.label} » (transaction, une fois)` }]
            : []),
          ...(needsApprove || !user ? [{ label: `Autoriser le contrat à prendre ${amountText || 0} ${C.token.symbol} (transaction, une fois)` }] : []),
          ...(needsDelegation ? [{ label: `Signer la délégation de crédit ${D.token.symbol} (signature, sans gas)` }] : []),
          { label: 'Signer la transaction : flash loan, swap et dépôt en une fois' },
        ]}
      />

      <div className="actions">
        <button className="btn primary" disabled={!canSign} onClick={onOpen} title={disabledReason}>
          {busy ?? (stale ? 'Cotation…' : 'Ouvrir la position')}
        </button>
        {disabledReason && !busy && <span className="muted small">{disabledReason}</span>}
      </div>
      {result && <Notice tone={result.ok ? 'info' : 'bad'}>{result.text} {result.hash && <TxLink market={market} hash={result.hash} />}</Notice>}

      {preview && (
        <details className="preview">
          <summary>Transaction envoyée au contrat</summary>
          <dl>
            <dt>Contrat</dt>
            <dd>{executor ?? `${market.quoteTaker} (adresse des tests sur fork, contrat non déployé)`}</dd>
            <dt>Routeur</dt>
            <dd>{q!.router}</dd>
            <dt>Minimum reçu</dt>
            <dd>{fmtAmount(q!.minOut, C.token.decimals)} {C.token.symbol}</dd>
            <dt>Calldata open()</dt>
            <dd className="mono">{preview}</dd>
          </dl>
        </details>
      )}
    </Card>
  )
}
