import { useMemo, useState } from 'react'
import { useGasPrice } from 'wagmi'
import { encodeFunctionData, parseUnits, type Address, type Hash } from 'viem'
import { AGGREGATORS, TARGET_MIN_HF, type AggregatorChoice } from '../config'
import { executorAbi } from '../abi'
import { campaignYields, campaignsForPair, daysLeft, eligibleForPosition, rewardsOverHorizon } from '../lib/merkl'
import { CampaignTable } from './CampaignTable'
import { RiskPanel } from './RiskPanel'
import { eligibleEModes, withEMode, type EModeCategory, type Reserves, type UserState } from '../lib/useMarket'
import { useQuote } from '../lib/useQuote'
import { useDebounced } from '../lib/useDebounced'
import { getQuote } from '../lib/quotes'
import { extraDebtForTarget, maxLeverage, netApy, positionLeverage, project, roundSignificant, toBase, EMPTY_ACCOUNT, NO_POSITION } from '../lib/math'
import { HORIZONS, breakEvenDays, horizonApy, loopCosts, swapCostBase } from '../lib/economics'
import { executeOpen, explainError, openArgs, type OpenPlan } from '../lib/execute'
import { fmtAmount, fmtHf, fmtPct, fmtPrice, fmtUsd, fmtX } from '../lib/format'
import { Card, QuoteCompare, Metric, Notice, Segmented, Steps, TxLink, hfTone } from './ui'

const SLIPPAGES = ['30', '50', '100'] as const
const HORIZON_LABELS: Record<(typeof HORIZONS)[number], string> = { 30: '30 j', 90: '90 j', 180: '6 mois', 365: '1 an' }

type Props = {
  reserves: Reserves
  /** all eMode categories of the market */
  emodes: EModeCategory[]
  user?: UserState
  account?: Address
  aggregator: AggregatorChoice
  onDone: () => void
  /** eMode and leverage to start with (pair picked in the scanner) */
  seed?: { emode: number; leverage: number }
}

export function OpenPanel({ reserves: base, emodes, user, account, aggregator, onDone, seed }: Props) {
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
  const reserves = withEMode(base, eligible.find((c) => c.id === emodeId))
  const { market, collateral: C, debt: D } = reserves
  const executor = market.executor
  const [amountText, setAmountText] = useState('1')
  const [leverage, setLeverage] = useState(seed ? Math.floor(seed.leverage * 20) / 20 : 2)
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('50')
  const [horizonText, setHorizon] = useState('90')
  const horizon = Number(horizonText)
  const gasPrice = useGasPrice({ chainId: market.chain.id, query: { refetchInterval: 30_000 } })
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash }>()

  // an existing position on the pair is levered further: the slider then sets the leverage of the whole position
  const position = user ? { collateralBase: toBase(user.aTokenBalance, C.side), debtBase: toBase(user.debtBalance, D.side) } : NO_POSITION
  const hasPosition = position.collateralBase > 0n
  const currentLev = positionLeverage(position)

  const maxLev = maxLeverage(C.config.ltvBps)
  const sliderMax = Math.max(1.1, Math.min(Math.floor(maxLev * 0.95 * 20) / 20, 15))
  const sliderMin = hasPosition && Number.isFinite(currentLev) ? Math.min(sliderMax, Math.max(1.1, Math.ceil(currentLev * 20) / 20)) : 1.1
  const lev = Math.max(sliderMin, Math.min(leverage, sliderMax))

  const initial = useMemo(() => {
    try {
      return parseUnits(amountText.replace(',', '.') || '0', C.token.decimals)
    } catch {
      return undefined
    }
  }, [amountText, C.token.decimals])

  const debouncedInitial = useDebounced(initial)
  const debouncedLevBps = useDebounced(BigInt(Math.round(lev * 10_000)))
  // rounded so that interest accruing on the existing debt does not re-quote at every block
  const debtAmount =
    debouncedInitial !== undefined ? roundSignificant(extraDebtForTarget(position, toBase(debouncedInitial, C.side), debouncedLevBps, D.side), 5) : 0n

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
  else if (initial === 0n && !hasPosition) problems.push('Entre le capital à déposer.')
  else if (hasPosition && debtAmount === 0n && initial === debouncedInitial && BigInt(Math.round(lev * 10_000)) === debouncedLevBps)
    problems.push('Le levier visé ne dépasse pas ton levier actuel : pour le réduire, passe par « Fermer / réduire ».')
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
  if (q?.simulated) warnings.push(`Devis simulé au prix de l’oracle${q.fallbackReason ? ` (${q.fallbackReason})` : ''}. Il ne peut pas être exécuté.`)

  const needsApprove = !!user && !!initial && user.collateralAllowance < initial
  const needsDelegation = !user || user.borrowAllowance < debtAmount
  const soldBase = toBase(debtAmount, D.side)
  const addedCollBase = q && debouncedInitial !== undefined ? toBase(debouncedInitial + q.buyAmount, C.side) : 0n
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
  const ratesApy = loopLev !== undefined ? netApy(loopLev, C.supplyApy, D.borrowApy) : undefined
  const apy = ratesApy !== undefined ? ratesApy + rewardsApy : undefined

  // one-off costs, and the yield once they are paid, over the planned holding time
  const capitalBase = (debouncedInitial !== undefined ? toBase(debouncedInitial, C.side) : 0n) + position.collateralBase - position.debtBase
  const costs =
    q && debouncedInitial !== undefined
      ? loopCosts({
          entrySoldBase: soldBase,
          entrySwapBase: swapCostBase(debtAmount, D.side, q.buyAmount, C.side),
          debtBase: soldBase,
          premiumBps: reserves.premiumBps,
          gasPriceWei: gasPrice.data,
          nativePriceBase: reserves.nativePrice,
        })
      : undefined
  // the APYs above are on the equity left after the swap; over the horizon everything is measured against the
  // capital put in, so the swap loss counts once, as a cost
  const toCapital =
    proj && capitalBase > 0n
      ? (Number(position.collateralBase + addedCollBase) - Number(position.debtBase + soldBase)) / Number(capitalBase)
      : 0
  const horizonYield =
    costs && ratesApy !== undefined && capitalBase > 0n
      ? horizonApy({ equityBase: capitalBase, ratesApy: ratesApy * toCapital, rewardsApy: rewardsOverHorizon(yields, horizon) * toCapital, costsBase: costs.total, days: horizon })
      : undefined
  const breakEven =
    costs && ratesApy !== undefined
      ? breakEvenDays(capitalBase, ratesApy * toCapital, costs.total, yields.map((y) => ({ apy: y.apy * toCapital, days: daysLeft(y.campaign) })))
      : undefined
  for (const c of [...pairCampaigns.supply, ...pairCampaigns.borrow].filter((c) => c.conditional))
    warnings.push(`Bonus Merkl « ${c.name} » : certaines conditions ne sont pas lisibles par l’app, vérifie la description sur Merkl.`)
  for (const x of eligibility?.excluded ?? []) warnings.push(`Bonus Merkl « ${x.campaign.name} » non compté : ${x.reasons.join(', ')}.`)

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
      setResult({ ok: true, text: hasPosition ? 'Position augmentée.' : 'Position ouverte.', hash })
      onDone()
    } catch (e) {
      setResult({ ok: false, text: explainError(e) })
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Card title={hasPosition ? 'Augmenter ta position' : 'Ouvrir une position'}>
      {hasPosition && user && (
        <Notice tone="info">
          Position actuelle : {fmtAmount(user.aTokenBalance, C.token.decimals)} {C.token.symbol} déposés, {fmtAmount(user.debtBalance, D.token.decimals)}{' '}
          {D.token.symbol} empruntés, levier {fmtX(currentLev)}, health factor {fmtHf(user.healthFactor)}. Le levier choisi s’applique à toute la position ; le
          capital ajouté peut être 0.
        </Notice>
      )}
      <div className="grid2">
        <label className="field">
          <span>
            {hasPosition ? 'Capital ajouté' : 'Capital initial'} en {C.token.symbol}
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
        <input type="range" min={sliderMin} max={sliderMax} step={0.05} value={lev} onChange={(e) => setLeverage(Number(e.target.value))} />
      </label>

      <div className="field">
        <span>Durée prévue de la position (pour amortir les coûts)</span>
        <Segmented value={horizonText} onChange={setHorizon} options={HORIZONS.map((h) => ({ value: String(h), label: HORIZON_LABELS[h] }))} />
      </div>

      <div className="metrics">
        <Metric label="Emprunt (flash loan)" value={`${fmtAmount(debtAmount, D.token.decimals)} ${D.token.symbol}`} sub={proj && fmtUsd(proj.debtBase - account0.debtBase)} />
        <Metric
          label="Collatéral déposé"
          value={q && debouncedInitial !== undefined ? `${fmtAmount(debouncedInitial + q.buyAmount, C.token.decimals)} ${C.token.symbol}` : '…'}
          sub={q && `dont ${fmtAmount(q.buyAmount, C.token.decimals)} via ${AGGREGATORS[q.aggregator].label}`}
        />
        <Metric label="Levier effectif" value={loopLev !== undefined ? fmtX(loopLev) : '…'} sub={hasPosition ? 'de toute la position, après swap' : 'après coût du swap'} />
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
        <Metric label="APY net (taux actuels)" value={apy !== undefined ? fmtPct(apy) : '…'} sub={rewardsApy !== 0 && ratesApy !== undefined ? `dont ${fmtPct(rewardsApy)} Merkl · sans Merkl ${fmtPct(ratesApy)}` : 'taux variables, hors coûts'} tone={apy !== undefined && apy < 0 ? 'warn' : undefined} />
        <Metric
          label="Coûts estimés"
          value={costs ? fmtUsd(costs.total) : '…'}
          sub={
            costs &&
            `swap ${fmtUsd(costs.entrySwap)} + sortie ${fmtUsd(costs.exitPremium + costs.exitSwap)}${costs.gas !== undefined ? ` + gas ${fmtUsd(costs.gas)}` : ' (gas non estimé)'}`
          }
        />
        <Metric
          label={`APY tout compris sur ${HORIZON_LABELS[horizon as (typeof HORIZONS)[number]]}`}
          value={horizonYield !== undefined ? fmtPct(horizonYield) : '…'}
          sub={
            breakEven === undefined
              ? undefined
              : `${Number.isFinite(breakEven) ? `rentable après ${Math.ceil(breakEven)} jours` : 'pas rentable aux taux actuels'}${yields.length ? ', bonus Merkl compté jusqu’à sa fin annoncée' : ''}`
          }
          tone={horizonYield !== undefined && horizonYield < 0 ? 'warn' : undefined}
        />
      </div>

      {proj && loopLev !== undefined && (
        <RiskPanel
          collateral={C.token.symbol}
          debt={D.token.symbol}
          healthFactor={proj.healthFactor}
          leverage={loopLev}
          supplyApy={C.supplyApy}
          borrowApy={D.borrowApy}
          rewardsApy={rewardsApy}
        />
      )}

      <CampaignTable campaigns={[...pairCampaigns.supply, ...pairCampaigns.borrow]} yields={yields} excluded={eligibility?.excluded ?? []} borrowed={D} />

      <QuoteCompare quote={q} token={C.token} />
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
          {busy ?? (stale ? 'Cotation…' : hasPosition ? 'Augmenter la position' : 'Ouvrir la position')}
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
