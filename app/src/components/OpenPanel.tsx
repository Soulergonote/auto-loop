import { useMemo, useState, type ReactNode } from 'react'
import { useGasPrice } from 'wagmi'
import { encodeFunctionData, parseUnits, type Address, type Hash } from 'viem'
import { AGGREGATORS, type AggregatorChoice } from '../config'
import { executorAbi } from '../abi'
import { campaignYields, campaignsForPair, daysLeft, eligibleForPosition, rewardsOverHorizon } from '../lib/merkl'
import { CampaignTable } from './CampaignTable'
import { RiskPanel } from './RiskPanel'
import { eligibleEModes, withEMode, type EModeCategory, type Reserves, type UserState } from '../lib/useMarket'
import { useQuote } from '../lib/useQuote'
import { useDebounced } from '../lib/useDebounced'
import { getQuote } from '../lib/quotes'
import { loopNativeApy } from '../lib/nativeYield'
import { extraDebtForTarget, maxLeverage, netApy, positionLeverage, project, roundSignificant, toBase, EMPTY_ACCOUNT, NO_POSITION } from '../lib/math'
import { HORIZONS, breakEvenDays, horizonApy, loopCosts, swapCostBase, swapLoss, swapLossProblem } from '../lib/economics'
import { executeOpen, explainError, openArgs, type OpenPlan } from '../lib/execute'
import { fmtAmount, fmtDays, fmtHf, fmtPct, fmtPrice, fmtUsd, fmtX } from '../lib/format'
import { isCorrelated } from '../lib/scan'
import { apyTone, hfThresholds, hfTone } from '../lib/tone'
import { Card, Fold, LoopLayout, QuoteCompare, Metric, Notice, Segmented, Steps, Summary, TxResult, aggregatorLabel } from './ui'

/** slippage choices in bps; 1 (0,01 %) by default, Azerty's choice: a tighter swap reverts sooner when the price moves */
const SLIPPAGES = ['1', '10', '50', '100'] as const

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
  seed?: { emode: number; leverage: number }
}

export function OpenPanel({ reserves: base, emodes, user, account, aggregator, onDone, seed, common, head }: Props) {
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
  const [amountText, setAmountText] = useState('1')
  const [leverage, setLeverage] = useState(seed ? Math.floor(seed.leverage * 20) / 20 : 2)
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('1')
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
  else if (initial === 0n && !hasPosition) problems.push('Capital à déposer manquant.')
  else if (hasPosition && debtAmount === 0n && initial === debouncedInitial && BigInt(Math.round(lev * 10_000)) === debouncedLevBps)
    problems.push('Le levier visé ne dépasse pas le levier actuel. Pour le réduire : onglet « Fermer / réduire ».')
  if (!C.config.active || C.config.paused || C.config.frozen) problems.push(`${C.token.symbol} est gelé ou en pause sur Aave.`)
  if (!D.config.borrowingEnabled || D.config.paused || D.config.frozen) problems.push(`${D.token.symbol} ne peut pas être emprunté.`)
  if (!D.config.flashLoanEnabled) problems.push(`Flash loan désactivé sur ${D.token.symbol}.`)
  if (C.config.ltvBps === 0) problems.push(`${C.token.symbol} n’est pas accepté comme collatéral (LTV 0).`)
  if (C.config.isolated) problems.push(`${C.token.symbol} est en isolation mode : non supporté par le contrat v1.`)
  if (worst && worst.ltv > maxLtv) problems.push(`LTV projetée ${fmtPct(worst.ltv)} au-dessus du maximum ${fmtPct(maxLtv)}. Baisser le levier.`)
  if (user && initial && initial > user.collateralBalance) problems.push(`Solde ${C.token.symbol} insuffisant.`)

  const warnings: string[] = []
  const lossIssue = q && swapLossProblem(swapLoss(debtAmount, D.side, q.buyAmount, C.side), D.token.symbol, C.token.symbol, q.simulated)
  if (lossIssue) (lossIssue.block ? problems : warnings).push(lossIssue.text)
  const correlated = isCorrelated(C, D)
  if (proj && proj.healthFactor < hfThresholds(correlated).ok)
    warnings.push(
      `Health factor ${fmtHf(proj.healthFactor)} : une baisse de ${fmtPct(proj.dropToLiquidation, 1)} de ${C.token.symbol} face à ${D.token.symbol} suffit à liquider la position.`,
    )
  const switchEMode = !!user && currentEMode !== emodeId
  if (switchEMode && currentEMode !== 0 && (user.account.debtBase > 0n || user.account.collateralBase > 0n))
    warnings.push(
      `Le compte Aave est en eMode « ${emodes.find((c) => c.id === currentEMode)?.label ?? currentEMode} » : le changer s’applique à toutes ses positions sur ce marché.`,
    )
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
  // the intrinsic yield of yield-bearing legs lasts like the Aave rates: it counts with them over the horizon
  const nativeApy = loopLev !== undefined ? loopNativeApy(loopLev, C.native, D.native) : 0
  const ratesApy = loopLev !== undefined ? netApy(loopLev, C.supplyApy, D.borrowApy) + nativeApy : undefined
  const apy = ratesApy !== undefined ? ratesApy + rewardsApy : undefined
  const apyParts = [nativeApy !== 0 && `${fmtPct(nativeApy)} token`, rewardsApy !== 0 && `${fmtPct(rewardsApy)} Merkl`].filter(Boolean)

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
  for (const c of [...pairCampaigns.supply, ...pairCampaigns.borrow].filter((c) => c.conditional))
    warnings.push(`Bonus Merkl « ${c.name} » : certaines conditions ne sont pas lisibles par l’app, à vérifier sur Merkl.`)
  for (const x of eligibility?.excluded ?? []) warnings.push(`Bonus Merkl « ${x.campaign.name} » non compté : ${x.reasons.join(', ')}.`)

  // fixed costs (gas above all) that a small capital does not earn back over the planned time
  if (costs && horizonYield !== undefined && horizonYield < 0 && apy !== undefined && apy > 0)
    warnings.push(`Les coûts fixes (${fmtUsd(costs.total)}) dépassent le rendement sur ${fmtDays(horizon)} avec ce capital. Augmenter le capital ou la durée.`)

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
      ? 'Connecter le portefeuille'
      : q?.simulated
        ? 'Devis simulé'
        : problems.length
          ? 'Bloqué : voir le bandeau rouge'
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

  const emodeLabel = reserves.emode ? reserves.emode.label : 'sans eMode'
  const steps = [
    ...(switchEMode || (!user && emodeId !== 0)
      ? [
          {
            label:
              emodeId === 0
                ? 'Sortir de l’eMode sur le compte Aave (transaction, une fois)'
                : `Passer le compte Aave en eMode « ${reserves.emode!.label} » (transaction, une fois)`,
          },
        ]
      : []),
    ...(needsApprove || !user ? [{ label: `Autoriser le contrat à prendre ${amountText || 0} ${C.token.symbol} (transaction, une fois)` }] : []),
    ...(needsDelegation ? [{ label: `Signer la délégation de crédit ${D.token.symbol} (signature, sans gas)` }] : []),
    { label: 'Signer la transaction : flash loan, swap et dépôt en une fois' },
  ]
  const liqPrice =
    proj && Number.isFinite(proj.healthFactor) ? fmtPrice(BigInt(Math.round(Number(C.price) * (1 - proj.dropToLiquidation)))) : proj ? '—' : undefined
  const counted = yields.filter((y) => y.apy > 0).length

  const summary = (
    <Summary
      items={[
        {
          label: 'Health factor',
          value: proj && fmtHf(proj.healthFactor),
          sub: worst && `pire cas ${fmtHf(worst.healthFactor)}`,
          tone: proj && hfTone(proj.healthFactor, correlated),
          key: true,
        },
        {
          label: `Liquidation si ${C.token.symbol} à`,
          value: liqPrice,
          sub: proj && Number.isFinite(proj.healthFactor) ? `baisse de ${fmtPct(proj.dropToLiquidation, 1)} face à ${D.token.symbol}` : undefined,
        },
        {
          label: 'APY net',
          value: apy !== undefined ? fmtPct(apy) : undefined,
          sub: apyParts.length > 0 && ratesApy !== undefined ? `dont ${apyParts.join(', ')}` : 'taux variables, hors coûts',
          tone: apyTone(apy),
          key: true,
        },
        {
          label: 'Coût total',
          value: costs ? fmtUsd(costs.total) : undefined,
          sub:
            costs &&
            `entrée ${fmtUsd(costs.entrySwap)} · sortie ${fmtUsd(costs.exitPremium + costs.exitSwap)} · gas ${costs.gas !== undefined ? fmtUsd(costs.gas) : 'non estimé'}`,
        },
      ]}
      action={
        <button className="btn primary" disabled={!canSign} onClick={onOpen} title={disabledReason}>
          {busy ?? (stale ? 'Cotation…' : hasPosition ? 'Augmenter la position' : 'Ouvrir la position')}
        </button>
      }
      reason={busy ? undefined : disabledReason}
    >
      <TxResult market={market} result={result} />
    </Summary>
  )

  return (
    <LoopLayout summary={summary}>
      {head}
      <Card title={hasPosition ? 'Augmenter la position' : 'Ouvrir une position'}>
        {hasPosition && user && (
          <p className="muted small">
            Position actuelle : levier {fmtX(currentLev)}, health factor {fmtHf(user.healthFactor)}. Le levier choisi s’applique à toute la position ; le
            capital ajouté peut être 0.
          </p>
        )}
        <div className="grid2">
          <label className="field">
            <span>
              Capital en {C.token.symbol}
              {user && (
                <button
                  className="link"
                  onClick={() => setAmountText(fmtAmount(user.collateralBalance, C.token.decimals, 8).replace(/\s/g, '').replace(',', '.'))}
                >
                  solde {fmtAmount(user.collateralBalance, C.token.decimals)}
                </button>
              )}
            </span>
            <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
            {initial !== undefined && <span className="muted small">≈ {fmtUsd((initial * C.price) / 10n ** BigInt(C.token.decimals))}</span>}
          </label>
          <label className="field">
            <span>
              Levier <strong className="lev">{fmtX(lev)}</strong>
              <span className="muted small">
                max {fmtX(maxLev)} (LTV {fmtPct(maxLtv, 0)})
              </span>
            </span>
            <input type="range" min={sliderMin} max={sliderMax} step={0.05} value={lev} onChange={(e) => setLeverage(Number(e.target.value))} />
          </label>
        </div>

        <div className="metrics">
          <Metric
            label="Emprunt"
            value={`${fmtAmount(debtAmount, D.token.decimals)} ${D.token.symbol}`}
            sub={proj ? fmtUsd(proj.debtBase - account0.debtBase) : 'flash loan'}
          />
          <Metric
            label="Collatéral déposé"
            value={q && debouncedInitial !== undefined ? `${fmtAmount(debouncedInitial + q.buyAmount, C.token.decimals)} ${C.token.symbol}` : undefined}
            sub={q && `dont ${fmtAmount(q.buyAmount, C.token.decimals)} via ${AGGREGATORS[q.aggregator].label}`}
          />
          <Metric label="Levier effectif" value={loopLev !== undefined ? fmtX(loopLev) : undefined} sub={hasPosition ? 'toute la position' : 'après le swap'} />
          <Metric
            label={`APY sur ${fmtDays(horizon)}`}
            value={horizonYield !== undefined ? fmtPct(horizonYield) : undefined}
            sub={breakEven === undefined ? 'coûts compris' : Number.isFinite(breakEven) ? `rentable après ${Math.ceil(breakEven)} j` : 'jamais rentable'}
            tone={apyTone(horizonYield)}
          />
        </div>

        {quote.isError && <Notice tone="bad">Cotation impossible : {(quote.error as Error).message}</Notice>}
        {problems.map((p) => (
          <Notice key={p} tone="bad">
            {p}
          </Notice>
        ))}
        {warnings.map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}

        <Fold title="Réglages" value={`${aggregatorLabel(aggregator)} · slippage ${fmtPct(Number(slippage) / 10_000)} · ${fmtDays(horizon)} · ${emodeLabel}`}>
          {common}
          <div className="grid2">
            <div className="field">
              <span>Slippage max</span>
              <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtPct(Number(s) / 10_000) }))} />
            </div>
            <div className="field">
              <span>Durée prévue</span>
              <Segmented value={horizonText} onChange={setHorizon} options={HORIZONS.map((h) => ({ value: String(h), label: fmtDays(h) }))} />
            </div>
          </div>
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
            supplyApy={C.supplyApy + (C.native?.apy ?? 0)}
            borrowApy={D.borrowApy}
            debtNativeApy={D.native?.apy ?? 0}
            rewardsApy={rewardsApy}
            correlated={correlated}
          />
        )}

        {pairCampaigns.supply.length + pairCampaigns.borrow.length > 0 && (
          <Fold
            title="Bonus Merkl"
            value={rewardsApy > 0 ? `+ ${fmtPct(rewardsApy)} sur la position · ${counted} campagne${counted > 1 ? 's' : ''}` : 'aucun compté'}
          >
            <CampaignTable campaigns={[...pairCampaigns.supply, ...pairCampaigns.borrow]} yields={yields} excluded={eligibility?.excluded ?? []} borrowed={D} />
          </Fold>
        )}

        {q && (
          <Fold title="Devis" value={`${AGGREGATORS[q.aggregator].label} · minimum ${fmtAmount(q.minOut, C.token.decimals)} ${C.token.symbol}`}>
            <QuoteCompare quote={q} token={C.token} />
            {preview && (
              <dl className="preview">
                <dt>Contrat</dt>
                <dd>{executor ?? `${market.quoteTaker} (adresse des tests sur fork, contrat non déployé)`}</dd>
                <dt>Routeur</dt>
                <dd>{q.router}</dd>
                <dt>Calldata open()</dt>
                <dd className="mono">{preview}</dd>
              </dl>
            )}
          </Fold>
        )}

        <Fold title="Étapes" value={`${steps.length} étape${steps.length > 1 ? 's' : ''}`}>
          <Steps steps={steps} />
        </Fold>
      </Card>
    </LoopLayout>
  )
}
