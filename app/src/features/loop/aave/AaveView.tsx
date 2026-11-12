import { useState, type ReactNode } from 'react'
import { formatUnits, type Address } from 'viem'
import { DEMO, type AggregatorChoice, type Market, type Token } from '../../../config'
import { eligibleEModes, useEModeCategories, useMarket, withEMode, withIncentives } from '../../../protocols/aave/useMarket'
import { useCampaigns } from '../../../services/merkl'
import { fmtDate, fmtPct, fmtPrice } from '../../../ui/format'
import { WINDOWS, useRateAverages, type Window } from '../../../protocols/aave/rateHistory'
import { useClaimables } from '../../../protocols/aave/reinvest'
import { ReinvestPanel } from './ReinvestPanel'
import { Card, Fold, LoopLayout, Notice, Segmented, Skel, Summary } from '../../../ui/primitives'
import { AaveOpenPanel } from './AaveOpenPanel'
import { AaveClosePanel } from './AaveClosePanel'
import { SwapCollateralPanel } from './SwapCollateralPanel'
import { DeployPanel } from '../shared/DeployPanel'
import { type Pick } from '../../scanner/Scanner'
import { needsRenewal } from '../../../protocols/pendle/pt'
import { yieldSourceText } from '../../../services/yield/nativeYield'
import { toBase } from '../../../domain/math'

/** How the Boucle screen opens a pair: eMode and leverage, the tab, and for « Ouvrir » a capital amount and token. */
export type Seed = { emode: number; leverage: number; tab?: Pick['tab']; amount?: string; capital?: Address }

type AaveViewProps = {
  market: Market
  collateral: Token
  debt: Token
  nativeToken?: Address
  /** the market's tokens */
  tokens?: Token[]
  /** shows another pair of the market */
  onPair: (collateral: Token, debt: Token, seed?: Seed) => void
  account?: Address
  aggregator: AggregatorChoice
  selectors: ReactNode
  common: ReactNode
  notes: ReactNode
  seed?: Seed
  /** keeps a newly deployed executor for this market */
  onExecutor: (a: Address) => void
}

export function AaveView({
  market: m,
  collateral,
  debt,
  nativeToken,
  tokens,
  onPair,
  account,
  aggregator,
  selectors,
  common,
  notes,
  seed,
  onExecutor,
}: AaveViewProps) {
  const [tab, setTab] = useState<'open' | 'close' | 'swap' | 'reinvest' | 'renew'>(seed?.tab ?? 'open')
  // filled by the reinvest flow's last step: "Augmenter" with the capital it gained
  const [augment, setAugment] = useState<{ emode: number; leverage: number; amount: string; capital?: Address }>()
  // a PT roll in two steps: after the close, open this PT with the collateral given back
  const [roll, setRoll] = useState<{ to: Token; leverage: number; emode: number }>()
  const market = useMarket(m, collateral, debt, account, nativeToken)
  const emodes = useEModeCategories(m)
  const incentives = useCampaigns(m)
  const r = market.reserves && withIncentives(market.reserves, incentives.data)
  // closing works inside the account's current eMode, if it applies to the pair
  const currentEMode = r && market.user ? eligibleEModes(emodes, r.collateral, r.debt).find((c) => c.id === market.user!.eModeCategory) : undefined

  const { claimables } = useClaimables(m.chain.id, account)
  const canReinvest = !!account && (claimables.length > 0 || tab === 'reinvest')
  // contract v2: the collateral of an existing position can be changed without closing it
  const canSwap = !!account && m.executorVersion === 2 && !!market.user && market.user.aTokenBalance > 0n
  // a PT in its last month (or matured) can be rolled into a later one, without closing
  const pt = r?.collateral.pt
  const canRenew = canSwap && !!pt && needsRenewal(pt)
  const averages = useRateAverages(m.chain.id, m.pool, [collateral.address, debt.address])
  // where each token's own yield comes from, shown under the rates
  const nativeNotes = r
    ? [r.collateral, r.debt].flatMap((x) => (x.native && !x.native.fixedUntil ? [`${x.token.symbol} : ${yieldSourceText(x.native)}`] : []))
    : []

  const head = (
    <>
      {notes}
      {!DEMO && (pt || r?.debt.pt) && m.executorVersion === 2 && !m.executorPendle && m.executorSource === 'wallet' && (
        <DeployPanel market={m} upgrade="pendle" onReady={onExecutor} />
      )}
      <Card title="Marché">
        {selectors}
        {market.error && <Notice>Lecture d’Aave impossible : {market.error.message.split('\n')[0]}</Notice>}
        {r === null && <Notice tone="bad">Cette paire n’est pas listée sur Aave v3 {m.label}.</Notice>}
        {r && (
          <Fold
            title="Taux Aave"
            value={`${r.collateral.token.symbol} dépôt ${fmtPct(r.collateral.supplyApy)} · ${r.debt.token.symbol} emprunt ${fmtPct(r.debt.borrowApy)}`}
          >
            <table className="reserves cards">
              <thead>
                <tr>
                  <th>Actif</th>
                  <th className="num">Prix oracle</th>
                  <th className="num">LTV / seuil liq.</th>
                  <th className="num">APY dépôt</th>
                  <th className="num">APY emprunt</th>
                </tr>
              </thead>
              <tbody>
                {[r.collateral, r.debt].map((x) => (
                  <tr key={x.token.address}>
                    <td className="lead">{x.token.symbol}</td>
                    <td className="num" data-label="Prix oracle">
                      {fmtPrice(x.price)}
                    </td>
                    <td className="num" data-label="LTV / seuil liq.">
                      {fmtPct(x.config.ltvBps / 10_000, 0)} / {fmtPct(x.config.liquidationThresholdBps / 10_000, 0)}
                    </td>
                    <td className="num" data-label="APY dépôt">
                      <div>
                        {fmtPct(x.supplyApy)}
                        {x.native && (
                          <span className="muted">
                            {' '}
                            + {fmtPct(x.native.apy)} {x.native.fixedUntil ? 'fixe' : 'token'}
                          </span>
                        )}
                        {x.supplyRewardApr > 0 && <span className="reward"> + {fmtPct(x.supplyRewardApr)} Merkl</span>}
                        <Averages values={averages.data?.get(x.token.address.toLowerCase())?.supply} pending={averages.isPending} />
                      </div>
                    </td>
                    <td className="num" data-label="APY emprunt">
                      <div>
                        {fmtPct(x.borrowApy)}
                        {x.native && (
                          <span className="muted">
                            {' '}
                            + {fmtPct(x.native.apy)} {x.native.fixedUntil ? 'fixe' : 'token'}
                          </span>
                        )}
                        {x.borrowRewardApr > 0 && <span className="reward"> − {fmtPct(x.borrowRewardApr)} Merkl</span>}
                        <Averages values={averages.data?.get(x.token.address.toLowerCase())?.borrow} pending={averages.isPending} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">Moyennes 7 j et 30 j : hausse des index Aave sur la période, annualisée.</p>
            {pt?.market && (
              <p className="muted small">
                « fixe » : APY implicite du marché Pendle de {r.collateral.token.symbol}, acquis jusqu’à l’échéance du {fmtDate(pt.expiry)}.
              </p>
            )}
            {nativeNotes.length > 0 && (
              <p className="muted small">« token » : rendement propre du token, hausse de son taux de change ({nativeNotes.join(' ; ')}).</p>
            )}
            {incentives.isError && <p className="muted small">Merkl indisponible : APY sans bonus.</p>}
          </Fold>
        )}
      </Card>
      <div className="tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'open', label: 'Ouvrir / augmenter' },
            { value: 'close', label: 'Fermer / réduire' },
            ...(canSwap || tab === 'swap' ? [{ value: 'swap' as const, label: 'Changer de collatéral' }] : []),
            ...(canRenew || tab === 'renew' ? [{ value: 'renew' as const, label: 'Renouveler' }] : []),
            ...(canReinvest ? [{ value: 'reinvest' as const, label: 'Réinvestir' }] : []),
          ]}
        />
      </div>
    </>
  )

  if (!r)
    return (
      <LoopLayout
        summary={
          <Summary
            items={[{ label: 'Health factor', key: true }, { label: 'Prix de liquidation' }, { label: 'APY net', key: true }, { label: 'Coût total' }]}
            action={
              <button className="btn primary" disabled>
                Ouvrir la position
              </button>
            }
          />
        }
      >
        {head}
      </LoopLayout>
    )
  if (tab === 'reinvest')
    return (
      <ReinvestPanel
        reserves={r}
        emode={currentEMode}
        onDone={market.refetchUser}
        user={market.user}
        account={account}
        aggregator={aggregator}
        common={common}
        head={head}
        onAugment={(capital, leverage) => {
          setAugment({
            emode: market.user?.eModeCategory ?? 0,
            leverage: leverage ?? 2,
            amount: formatUnits(capital, r.collateral.token.decimals),
          })
          // the wallet now holds the collateral the flow brought: read its balance again before the "Augmenter" checks
          void market.refetchUser()
          setTab('open')
          window.scrollTo({ top: 0 })
        }}
      />
    )
  if ((tab === 'swap' || tab === 'renew') && account && market.user)
    return (
      <SwapCollateralPanel
        key={tab}
        renew={tab === 'renew'}
        onClose={() => setTab('close')}
        onTwoStep={(to, leverage) => {
          setRoll({ to, leverage, emode: market.user?.eModeCategory ?? 0 })
          setTab('close')
          window.scrollTo({ top: 0 })
        }}
        reserves={withEMode(r, currentEMode)}
        emode={market.user.eModeCategory ? emodes.find((c) => c.id === market.user!.eModeCategory) : undefined}
        tokens={tokens}
        campaigns={incentives.data}
        user={market.user}
        account={account}
        aggregator={aggregator}
        common={common}
        head={head}
        onDone={market.refetchUser}
        onShowPair={(c) => {
          setTab('close')
          onPair(c, debt)
        }}
      />
    )
  return tab === 'open' || tab === 'swap' || tab === 'renew' ? (
    <AaveOpenPanel
      reserves={r}
      tokens={tokens}
      emodes={emodes}
      seed={augment ?? seed}
      user={market.user}
      account={account}
      aggregator={aggregator}
      common={common}
      head={head}
      onDone={market.refetchUser}
    />
  ) : (
    <AaveClosePanel
      reserves={withEMode(r, currentEMode)}
      then={
        roll && {
          label: `Ouvrir ${roll.to.symbol} au même levier`,
          // a new pair: the view starts again on « Ouvrir », with the old PT given back as capital
          run: (back) => {
            // the old PT given back is the capital, or the debt asset when the close redeemed it all (matured PT)
            const inPt = toBase(back.collateral, r.collateral.side) >= toBase(back.debt, r.debt.side)
            onPair(roll.to, debt, {
              emode: roll.emode,
              leverage: roll.leverage,
              amount: inPt ? formatUnits(back.collateral, collateral.decimals) : formatUnits(back.debt, debt.decimals),
              capital: inPt ? collateral.address : debt.address,
            })
            window.scrollTo({ top: 0 })
          },
        }
      }
      user={market.user}
      account={account}
      aggregator={aggregator}
      common={common}
      head={head}
      onDone={market.refetchUser}
    />
  )
}

/** Second line of a rate cell: its 7- and 30-day averages, a skeleton while they are read, nothing if unreadable. */
function Averages({ values, pending }: { values?: Partial<Record<Window, number>>; pending: boolean }) {
  if (pending)
    return (
      <div>
        <Skel w={8} />
      </div>
    )
  if (!values || WINDOWS.every((w) => values[w] === undefined)) return null
  return <div className="muted small">{WINDOWS.map((w) => `${w} j ${values[w] !== undefined ? fmtPct(values[w]!) : '—'}`).join(' · ')}</div>
}
