import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address, Hash } from 'viem'
import type { AggregatorChoice, Token } from '../config'
import type { Reserves, UserState } from '../lib/useMarket'
import { snapshotQuery } from '../lib/snapshot'
import { useQuote } from '../lib/useQuote'
import { positionLeverage, toBase, type Side } from '../lib/math'
import { explainError } from '../lib/execute'
import { claimRewards, rewardAction, swapFromWallet, usdValue, useClaimables, withdrawReward, type Claimable, type RewardAction } from '../lib/reinvest'
import { fmtAmount, fmtDollars, fmtPct, fmtX } from '../lib/format'
import { Card, Fold, QuoteCompare, LoopLayout, Notice, Segmented, Skel, Steps, Summary, TxResult, aggregatorLabel } from './ui'

/** same choices and default as the open and close panels (0,01 %, Azerty's choice) */
const SLIPPAGES = ['1', '10', '50', '100'] as const

type Props = {
  reserves: Reserves
  user?: UserState
  account?: Address
  aggregator: AggregatorChoice
  /** settings shared with the other panels, shown in the "Réglages" block */
  common: ReactNode
  /** market card and tabs */
  head: ReactNode
  /** last step: the "Augmenter" panel, filled with the capital gained and the leverage to return to */
  onAugment: (capital: bigint, leverage?: number) => void
}

type Planned = { reward: Claimable; action: RewardAction }
/** a step of the flow: claim, then a withdraw and/or a swap per reward, then "Augmenter" */
type Step =
  | { id: 'claim' }
  | { id: string; kind: 'withdraw'; reward: Claimable; reserve: Planned['action'] & { kind: 'withdraw' } }
  | { id: string; kind: 'swap'; sell: Token; amount: bigint; side: Side }
  | { id: 'augment' }

const DEVIENT: Record<RewardAction['kind'], string> = {
  deposited: 'déjà en collatéral',
  capital: 'capital ajouté',
  withdraw: 'retiré d’Aave puis échangé',
  swap: 'échangé',
  keep: 'laissé (moins de 1 $)',
}

/** Claims the Merkl rewards of the chain and turns them into collateral of the pair, one signed step at a time. */
export function ReinvestPanel({ reserves, user, account, aggregator, common, head, onAugment }: Props) {
  const { market, collateral: C } = reserves
  const chainId = market.chain.id
  const { claimables, ready, error, refetch } = useClaimables(chainId, account)
  const snapshot = useQuery(snapshotQuery(market))
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('1')
  // the plan is frozen at the claim: afterwards the API no longer lists what was just claimed
  const [frozen, setFrozen] = useState<Planned[]>()
  const [done, setDone] = useState<string[]>([])
  const [capital, setCapital] = useState(0n)
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash }>()
  // leverage to return to: the position's before the rewards are added
  const [targetLev] = useState(() => {
    if (!user || user.debtBalance === 0n) return undefined
    const lev = positionLeverage({ collateralBase: toBase(user.aTokenBalance, C.side), debtBase: toBase(user.debtBalance, reserves.debt.side) })
    return Number.isFinite(lev) ? lev : undefined
  })

  const all = snapshot.data?.reserves ?? []
  const plan: Planned[] = frozen ?? claimables.map((reward) => ({ reward, action: rewardAction(reward, all, C.token.address) }))
  const steps = useMemo((): Step[] => {
    const out: Step[] = [{ id: 'claim' }]
    for (const { reward, action } of plan) {
      if (action.kind === 'withdraw') {
        out.push({ id: `withdraw:${reward.token}`, kind: 'withdraw', reward, reserve: action })
        // rewardAction never withdraws the collateral's own aToken: the underlying always needs a swap
        const r = action.reserve
        out.push({ id: `swap:${r.token.address}`, kind: 'swap', sell: r.token, amount: reward.amount, side: r.side })
      }
      if (action.kind === 'swap') {
        const known = all.find((r) => r.token.address.toLowerCase() === reward.token.toLowerCase())
        const side: Side = known?.side ?? { price: BigInt(Math.round(reward.price * 1e8)), decimals: reward.decimals }
        out.push({
          id: `swap:${reward.token}`,
          kind: 'swap',
          sell: { address: reward.token, symbol: reward.symbol, name: reward.symbol, decimals: reward.decimals },
          amount: reward.amount,
          side,
        })
      }
    }
    out.push({ id: 'augment' })
    return out
  }, [plan, all, C.token.address])
  const current = steps.find((s) => !done.includes(s.id))!

  const quoteReq =
    account && 'kind' in current && current.kind === 'swap'
      ? {
          aggregator,
          chainId,
          sell: current.sell,
          buy: C.token,
          sellAmount: current.amount,
          taker: account,
          slippageBps: BigInt(slippage),
          oracle: { sell: current.side, buy: C.side },
        }
      : undefined
  const quote = useQuote(quoteReq)
  const q = quote.data

  // collateral the flow brings, at oracle prices for what is still to swap
  const totalUsd = plan.reduce((s, p) => s + usdValue(p.reward), 0)
  const toCollateral = (amount: bigint, side: Side) => (side.price > 0n ? (toBase(amount, side) * 10n ** BigInt(C.token.decimals)) / C.side.price : 0n)
  const estimate =
    capital +
    steps.reduce((s, st) => (!done.includes(st.id) && 'kind' in st && st.kind === 'swap' ? s + toCollateral(st.amount, st.side) : s), 0n) +
    plan.reduce((s, p) => (p.action.kind === 'capital' && !done.includes('claim') ? s + p.reward.amount : s), 0n)
  const deposited = plan.filter((p) => p.action.kind === 'deposited').reduce((s, p) => s + p.reward.amount, 0n)

  async function run() {
    if (!account) return
    setResult(undefined)
    const step = current
    try {
      if (step.id === 'claim') {
        const rewards = plan.map((p) => p.reward)
        const hash = await claimRewards(chainId, account, rewards, setBusy)
        setFrozen(plan)
        setCapital((c) => c + plan.filter((p) => p.action.kind === 'capital').reduce((s, p) => s + p.reward.amount, 0n))
        setResult({ ok: true, text: `${rewards.length} reward${rewards.length > 1 ? 's' : ''} réclamé${rewards.length > 1 ? 's' : ''}.`, hash })
        refetch()
      } else if ('kind' in step && step.kind === 'withdraw') {
        const r = step.reserve.reserve
        const hash = await withdrawReward(chainId, market.pool, account, r.token.address, step.reward.amount, setBusy)
        setResult({ ok: true, text: `${fmtAmount(step.reward.amount, r.token.decimals)} ${r.token.symbol} retiré d’Aave.`, hash })
      } else if ('kind' in step && step.kind === 'swap') {
        if (!q) return
        const { hash, received } = await swapFromWallet(chainId, account, step.sell.address, C.token.address, q, setBusy)
        setCapital((c) => c + received)
        setResult({
          ok: true,
          text: `${fmtAmount(step.amount, step.sell.decimals)} ${step.sell.symbol} échangé contre ${fmtAmount(received, C.token.decimals)} ${C.token.symbol}.`,
          hash,
        })
      } else {
        onAugment(capital, targetLev)
        return
      }
      setDone((d) => [...d, step.id])
    } catch (e) {
      setResult({ ok: false, text: explainError(e) })
    } finally {
      setBusy(undefined)
    }
  }

  const label =
    current.id === 'claim'
      ? `Réclamer ${plan.length} reward${plan.length > 1 ? 's' : ''}`
      : 'kind' in current && current.kind === 'withdraw'
        ? `Retirer ${current.reserve.reserve.token.symbol} d’Aave`
        : 'kind' in current && current.kind === 'swap'
          ? `Échanger ${current.sell.symbol} en ${C.token.symbol}`
          : 'Augmenter la position'
  const swapping = 'kind' in current && current.kind === 'swap'
  const reason = !account
    ? 'Connecter le portefeuille'
    : !ready || snapshot.isPending
      ? 'Lecture des rewards…'
      : current.id === 'claim' && plan.length === 0
        ? 'Rien à réclamer sur ce réseau'
        : swapping && !q
          ? quote.isError
            ? 'Pas de devis pour cet échange'
            : 'Cotation…'
          : swapping && q?.simulated
            ? 'Devis simulé'
            : undefined

  const stepLabels = steps.map((s) => {
    const text =
      s.id === 'claim'
        ? 'Réclamer sur Merkl (une transaction pour tous les tokens)'
        : 'kind' in s && s.kind === 'withdraw'
          ? `Retirer ${s.reserve.reserve.token.symbol} d’Aave`
          : 'kind' in s && s.kind === 'swap'
            ? `Échanger ${s.sell.symbol} en ${C.token.symbol} (approbation de ce montant, puis échange)`
            : `Augmenter la position${targetLev ? ` jusqu’à ${fmtX(targetLev)}` : ''}, dans l’onglet « Ouvrir / augmenter »`
    return { label: done.includes(s.id) ? `${text} : fait` : text }
  })

  return (
    <LoopLayout
      summary={
        <Summary
          items={[
            {
              label: 'Rewards à réclamer',
              value: ready ? fmtDollars(totalUsd) : undefined,
              sub: ready ? `${plan.length} token${plan.length > 1 ? 's' : ''}` : undefined,
              key: true,
            },
            {
              label: 'Capital ajouté',
              value: ready ? `${fmtAmount(estimate, C.token.decimals)} ${C.token.symbol}` : undefined,
              sub: deposited > 0n ? `plus ${fmtAmount(deposited, C.token.decimals)} déjà en collatéral` : 'au prix oracle',
              key: true,
            },
            { label: 'Levier visé', value: targetLev ? fmtX(targetLev) : '—', sub: targetLev ? 'celui de la position' : 'pas de position à reprendre' },
          ]}
          action={
            <button className="btn primary" disabled={!!busy || !!reason} onClick={run}>
              {busy ?? label}
            </button>
          }
          reason={busy ? undefined : reason}
        >
          <TxResult market={market} result={result} />
        </Summary>
      }
    >
      {head}
      <Card title="Réinvestir les rewards Merkl">
        {error && <Notice>Merkl indisponible : rewards illisibles. Réessayer plus tard.</Notice>}
        {!ready && !error ? (
          <Skel w={16} />
        ) : plan.length === 0 ? (
          <p className="muted">Aucun reward réclamable sur {market.chain.name}. Merkl met à jour les montants toutes les 8 h environ.</p>
        ) : (
          <table className="reserves cards">
            <thead>
              <tr>
                <th>Token</th>
                <th className="num">Montant</th>
                <th className="num">Valeur</th>
                <th>Devient</th>
              </tr>
            </thead>
            <tbody>
              {plan.map(({ reward, action }) => (
                <tr key={reward.token}>
                  <td className="lead">{reward.symbol}</td>
                  <td data-label="Montant" className="num">
                    {fmtAmount(reward.amount, reward.decimals)}
                  </td>
                  <td data-label="Valeur" className="num">
                    {reward.price > 0 ? fmtDollars(usdValue(reward)) : '—'}
                  </td>
                  <td data-label="Devient">
                    {action.kind === 'swap' || action.kind === 'withdraw' ? `${DEVIENT[action.kind]} en ${C.token.symbol}` : DEVIENT[action.kind]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Fold title="Réglages" value={`${aggregatorLabel(aggregator)} · slippage ${fmtPct(Number(slippage) / 10_000)}`}>
          {common}
          <div className="field">
            <span>Slippage max</span>
            <Segmented value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s, label: fmtPct(Number(s) / 10_000) }))} />
          </div>
        </Fold>
        {swapping && q && (
          <Fold title="Devis" value={`${aggregatorLabel(q.aggregator)} · minimum ${fmtAmount(q.minOut, C.token.decimals)} ${C.token.symbol}`}>
            <QuoteCompare quote={q} token={C.token} />
          </Fold>
        )}
        <Fold title="Étapes" value={`${done.length} sur ${steps.length} faites`}>
          <Steps steps={stepLabels} />
          <p className="muted small">
            Chaque étape est une transaction signée depuis le portefeuille. L’échange approuve le montant exact pour le routeur de l’agrégateur, sans
            autorisation durable.
          </p>
        </Fold>
      </Card>
    </LoopLayout>
  )
}
