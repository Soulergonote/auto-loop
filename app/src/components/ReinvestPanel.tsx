import { useMemo, useState, type ReactNode } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { readContract } from '@wagmi/core'
import type { Address, Hash } from 'viem'
import { wagmiConfig } from '../wagmi'
import { debtTokenAbi, erc20Abi } from '../abi'
import type { AggregatorChoice, Token } from '../config'
import { withEMode, type EModeCategory, type Reserves, type UserState } from '../lib/useMarket'
import { snapshotQuery } from '../lib/snapshot'
import { useQuote } from '../lib/useQuote'
import { getQuote, type Quote } from '../lib/quotes'
import { extraDebtForTarget, pairPosition, positionLeverage, project, roundSignificant, toBase, type Side } from '../lib/math'
import { explainError } from '../lib/execute'
import { claimRewards, rewardAction, swapFromWallet, usdValue, useClaimables, withdrawReward, type Claimable, type RewardAction } from '../lib/reinvest'
import { buildReinvestBatch, sendBatch, swapCapital, useAtomicBatch, walletQuote, type BatchCall, type WalletSwap } from '../lib/oneClick'
import { isCorrelated } from '../lib/scan'
import { hfThresholds, hfTone } from '../lib/tone'
import { fmtAmount, fmtDollars, fmtHf, fmtPct, fmtX } from '../lib/format'
import { Card, Fold, QuoteCompare, LoopLayout, Notice, Segmented, Skel, Steps, Summary, TxResult, aggregatorLabel } from './ui'

/** same choices and default as the open and close panels (0,01 %, Azerty's choice) */
const SLIPPAGES = ['1', '10', '50', '100'] as const

type Props = {
  reserves: Reserves
  /** the account's eMode category when it applies to the pair (the levering step borrows inside it) */
  emode?: EModeCategory
  user?: UserState
  account?: Address
  aggregator: AggregatorChoice
  /** settings shared with the other panels, shown in the "Réglages" block */
  common: ReactNode
  /** market card and tabs */
  head: ReactNode
  /** last step of the step-by-step flow: the "Augmenter" panel, filled with the capital gained and the leverage to return to */
  onAugment: (capital: bigint, leverage?: number) => void
  /** after the one-click batch: balances changed */
  onDone: () => void
}

type Planned = { reward: Claimable; action: RewardAction }
type SwapLeg = { id: string; sell: Token; amount: bigint; side: Side }
/** a step of the step-by-step flow: claim, then a withdraw and/or a swap per reward, then "Augmenter" */
type Step =
  | { id: 'claim' }
  | { id: string; kind: 'withdraw'; reward: Claimable; reserve: Planned['action'] & { kind: 'withdraw' } }
  | ({ kind: 'swap' } & SwapLeg)
  | { id: 'augment' }

const DEVIENT: Record<RewardAction['kind'], string> = {
  deposited: 'déjà en collatéral',
  capital: 'capital ajouté',
  withdraw: 'retiré d’Aave puis échangé',
  swap: 'échangé',
  keep: 'laissé (moins de 1 $)',
}

/**
 * Claims the Merkl rewards of the chain and turns them into collateral of the pair. With a wallet that sends atomic
 * batches and a position to return to, everything is one confirmation; otherwise one signed step at a time.
 */
export function ReinvestPanel({ reserves: base, emode, user, account, aggregator, common, head, onAugment, onDone }: Props) {
  const reserves = withEMode(base, emode)
  const { market, collateral: C, debt: D } = reserves
  const chainId = market.chain.id
  const { claimables, ready, error, refetch } = useClaimables(chainId, account)
  const snapshot = useQuery(snapshotQuery(market))
  const batch = useAtomicBatch(chainId, account)
  const [slippage, setSlippage] = useState<(typeof SLIPPAGES)[number]>('1')
  // the plan is frozen at the claim: afterwards the API no longer lists what was just claimed
  const [frozen, setFrozen] = useState<Planned[]>()
  const [done, setDone] = useState<string[]>([])
  const [capital, setCapital] = useState(0n)
  const [busy, setBusy] = useState<string>()
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: Hash }>()
  // leverage to return to: the position's before the rewards are added (frozen at the claim in the step flow,
  // which can deposit collateral aTokens)
  const liveLev = (() => {
    if (!user || user.debtBalance === 0n) return undefined
    const lev = positionLeverage(pairPosition(user, C.side, D.side))
    return Number.isFinite(lev) && lev > 1 ? lev : undefined
  })()
  const [claimedLev, setClaimedLev] = useState<number>()
  const targetLev = frozen ? claimedLev : liveLev

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
        out.push({
          id: `swap:${reward.token}`,
          kind: 'swap',
          sell: { address: reward.token, symbol: reward.symbol, name: reward.symbol, decimals: reward.decimals },
          amount: reward.amount,
          side: known?.side ?? { price: BigInt(Math.round(reward.price * 1e8)), decimals: reward.decimals },
        })
      }
    }
    out.push({ id: 'augment' })
    return out
  }, [plan, all])
  const legs = steps.filter((s): s is Step & { kind: 'swap' } & SwapLeg => 'kind' in s && s.kind === 'swap')
  const current = steps.find((s) => !done.includes(s.id))!

  const position = user ? pairPosition(user, C.side, D.side) : undefined
  const executor = market.executor
  // one confirmation needs: a wallet that batches atomically, the contract, a position to return to, and an
  // account eMode the pair can borrow in
  const emodeOk = !user || user.eModeCategory === 0 || !!emode
  const oneClick = batch === true && !!executor && !!targetLev && emodeOk && !frozen

  // quotes of every reward swap, made for the wallet and refused unless their calldata pays the wallet
  const quoteReq = (leg: SwapLeg) => ({
    aggregator,
    chainId,
    sell: leg.sell,
    buy: C.token,
    sellAmount: leg.amount,
    taker: account!,
    slippageBps: BigInt(slippage),
    oracle: { sell: leg.side, buy: C.side },
  })
  const legQuotes = useQueries({
    queries: legs.map((leg) => ({
      queryKey: ['walletQuote', aggregator, chainId, leg.sell.address, C.token.address, leg.amount.toString(), account, slippage],
      queryFn: ({ signal }: { signal: AbortSignal }) => walletQuote(quoteReq(leg), signal),
      enabled: !!account && (oneClick || current === leg),
      staleTime: 10_000,
      refetchInterval: 20_000,
      retry: false,
    })),
  })

  // collateral the batch brings: the rewards that are the collateral, the swaps' guaranteed minimums, and the
  // collateral aTokens the claim deposits by itself
  const capitalDirect = plan.filter((p) => p.action.kind === 'capital').reduce((s, p) => s + p.reward.amount, 0n)
  const deposited = plan.filter((p) => p.action.kind === 'deposited').reduce((s, p) => s + p.reward.amount, 0n)
  const quotesReady = legQuotes.every((q) => q.data && !q.data.simulated)
  const batchCapital = (() => {
    if (!account || !quotesReady) return undefined
    try {
      return (
        capitalDirect +
        swapCapital(
          walletSwaps(
            legs,
            legQuotes.map((q) => q.data!),
          ),
          C.token.address,
          account,
        )
      )
    } catch {
      return undefined
    }
  })()
  const targetBps = targetLev ? BigInt(Math.round(targetLev * 10_000)) : 0n
  const debtFor = (added: bigint) =>
    position && targetLev ? roundSignificant(extraDebtForTarget(position, toBase(added + deposited, C.side), targetBps, D.side), 5) : 0n
  const debtAmount = batchCapital !== undefined ? debtFor(batchCapital) : 0n
  const lever = useQuote(
    oneClick && debtAmount > 0n
      ? {
          aggregator,
          chainId,
          sell: D.token,
          buy: C.token,
          sellAmount: debtAmount,
          taker: market.quoteTaker,
          slippageBps: BigInt(slippage),
          oracle: { sell: D.side, buy: C.side },
        }
      : undefined,
  )
  const lq = lever.data
  const projected = (q: Quote | undefined, minimum: boolean) =>
    user && batchCapital !== undefined && (q || debtAmount === 0n)
      ? project(
          user.account,
          batchCapital + deposited + (q ? (minimum ? q.minOut : q.buyAmount) : 0n),
          C.side,
          C.config.liquidationThresholdBps,
          debtAmount,
          D.side,
        )
      : undefined
  const proj = projected(lq, false)
  const worst = projected(lq, true)
  // v2 guard: the worst case of the lever's quote, with a little room for prices moving before inclusion
  const minHf = worst && Number.isFinite(worst.healthFactor) ? BigInt(Math.floor(worst.healthFactor * 0.98 * 1e6)) * 10n ** 12n : 0n
  const correlated = isCorrelated(C, D)

  const problems: string[] = []
  const warnings: string[] = []
  const legError = legQuotes.find((q) => q.error)?.error
  if (oneClick) {
    if (legError) problems.push(legError instanceof Error ? legError.message : String(legError))
    if (lever.error) problems.push(`Devis du levier : ${lever.error instanceof Error ? lever.error.message : String(lever.error)}`)
    if (debtAmount > 0n) {
      if (!D.config.borrowingEnabled || D.config.paused || D.config.frozen) problems.push(`${D.token.symbol} ne peut pas être emprunté.`)
      if (!D.config.flashLoanEnabled) problems.push(`Flash loan désactivé sur ${D.token.symbol}.`)
      if (!C.config.active || C.config.paused || C.config.frozen) problems.push(`${C.token.symbol} est gelé ou en pause sur Aave.`)
    }
    if (worst && worst.ltv > C.config.ltvBps / 10_000)
      problems.push(`LTV projetée ${fmtPct(worst.ltv)} au-dessus du maximum ${fmtPct(C.config.ltvBps / 10_000)}.`)
    if (proj && proj.healthFactor < hfThresholds(correlated).ok)
      warnings.push(`Health factor ${fmtHf(proj.healthFactor)} après réinvestissement : une baisse de ${fmtPct(proj.dropToLiquidation, 1)} suffit à liquider.`)
    if (lq?.simulated) problems.push('Devis du levier simulé : il ne peut pas être exécuté.')
  }

  /** The batch with fresh quotes and allowances read now, right before the wallet is asked. */
  async function freshBatch(): Promise<{ calls: BatchCall[]; capital: bigint }> {
    const user0 = account!
    setBusy('Cotation…')
    const quotes = await Promise.all(legs.map((leg) => walletQuote(quoteReq(leg))))
    const allowances = await Promise.all(
      legs.map((leg, i) =>
        readContract(wagmiConfig, { chainId, address: leg.sell.address, abi: erc20Abi, functionName: 'allowance', args: [user0, quotes[i].router] }),
      ),
    )
    const swaps = walletSwaps(legs, quotes, allowances)
    const cap = capitalDirect + swapCapital(swaps, C.token.address, user0)
    const debt = debtFor(cap)
    const leverQuote =
      debt > 0n
        ? await getQuote({
            aggregator,
            chainId,
            sell: D.token,
            buy: C.token,
            sellAmount: debt,
            taker: market.quoteTaker,
            slippageBps: BigInt(slippage),
            oracle: { sell: D.side, buy: C.side },
          })
        : undefined
    if (leverQuote?.simulated) throw new Error('Plus de devis réel disponible pour le levier')
    const after = project(user!.account, cap + deposited + (leverQuote?.minOut ?? 0n), C.side, C.config.liquidationThresholdBps, debt, D.side)
    if (after.ltv > C.config.ltvBps / 10_000) throw new Error(`LTV projetée ${fmtPct(after.ltv)} au-dessus du maximum : réinvestissement annulé.`)
    const [colAllow, borrowAllow] = await Promise.all([
      readContract(wagmiConfig, { chainId, address: C.token.address, abi: erc20Abi, functionName: 'allowance', args: [user0, executor!] }),
      readContract(wagmiConfig, { chainId, address: D.variableDebtToken, abi: debtTokenAbi, functionName: 'borrowAllowance', args: [user0, executor!] }),
    ])
    return buildReinvestBatch({
      user: user0,
      rewards: plan.map((p) => p.reward),
      pool: market.pool,
      withdrawals: steps.flatMap((s) => ('kind' in s && s.kind === 'withdraw' ? [{ token: s.reserve.reserve.token, amount: s.reward.amount }] : [])),
      swaps,
      capitalDirect,
      collateral: C.token,
      debt: D.token,
      variableDebtToken: D.variableDebtToken,
      executor: executor!,
      version: market.executorVersion,
      minHealthFactor: minHf,
      collateralAllowance: colAllow,
      borrowAllowance: borrowAllow,
      debtAmount: debt,
      leverQuote,
    })
  }

  async function runBatch() {
    if (!account) return
    setResult(undefined)
    try {
      const { calls, capital: cap } = await freshBatch()
      const hash = await sendBatch(chainId, account, calls, setBusy)
      setResult({
        ok: true,
        text: `${plan.length} reward${plan.length > 1 ? 's' : ''} réinvesti${plan.length > 1 ? 's' : ''} : ${fmtAmount(cap + deposited, C.token.decimals)} ${C.token.symbol} ajoutés.`,
        hash,
      })
      refetch()
      onDone()
    } catch (e) {
      setResult({ ok: false, text: explainError(e) })
    } finally {
      setBusy(undefined)
    }
  }

  // step by step: the current step's quote
  const stepQuote = 'kind' in current && current.kind === 'swap' ? legQuotes[legs.indexOf(current as (typeof legs)[number])] : undefined
  const q = stepQuote?.data

  async function runStep() {
    if (!account) return
    setResult(undefined)
    const step = current
    try {
      if (step.id === 'claim') {
        const rewards = plan.map((p) => p.reward)
        const hash = await claimRewards(chainId, account, rewards, setBusy)
        setFrozen(plan)
        setClaimedLev(liveLev)
        setCapital((c) => c + capitalDirect)
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

  // collateral the step flow brings, at oracle prices for what is still to swap
  const totalUsd = plan.reduce((s, p) => s + usdValue(p.reward), 0)
  const toCollateral = (amount: bigint, side: Side) => (side.price > 0n ? (toBase(amount, side) * 10n ** BigInt(C.token.decimals)) / C.side.price : 0n)
  const estimate =
    capital +
    legs.reduce((s, leg) => (!done.includes(leg.id) ? s + toCollateral(leg.amount, leg.side) : s), 0n) +
    (!done.includes('claim') ? capitalDirect : 0n)

  const reading = !account ? 'Connecter le portefeuille' : !ready || snapshot.isPending || batch === undefined ? 'Lecture des rewards…' : undefined
  const nothing = plan.length === 0 && !frozen ? 'Rien à réclamer sur ce réseau' : undefined
  const swapping = 'kind' in current && current.kind === 'swap'
  const reason = oneClick
    ? (reading ??
      nothing ??
      (problems.length
        ? 'Bloqué : voir le bandeau rouge'
        : !quotesReady || batchCapital === undefined || (debtAmount > 0n && !lq) || lever.isFetching
          ? 'Cotation…'
          : undefined))
    : (reading ??
      (current.id === 'claim' ? nothing : undefined) ??
      (swapping && !q ? (stepQuote?.isError ? 'Pas de devis pour cet échange' : 'Cotation…') : swapping && q?.simulated ? 'Devis simulé' : undefined))

  const label = oneClick
    ? 'Réclamer et réinvestir'
    : current.id === 'claim'
      ? `Réclamer ${plan.length} reward${plan.length > 1 ? 's' : ''}`
      : 'kind' in current && current.kind === 'withdraw'
        ? `Retirer ${current.reserve.reserve.token.symbol} d’Aave`
        : swapping
          ? `Échanger ${(current as SwapLeg).sell.symbol} en ${C.token.symbol}`
          : 'Augmenter la position'

  // what the batch will do, call by call (allowances shown as if none were in place: the real batch may skip some)
  const preview = (() => {
    if (!oneClick || !account || batchCapital === undefined || (debtAmount > 0n && !lq)) return undefined
    try {
      return buildReinvestBatch({
        user: account,
        rewards: plan.map((p) => p.reward),
        pool: market.pool,
        withdrawals: steps.flatMap((s) => ('kind' in s && s.kind === 'withdraw' ? [{ token: s.reserve.reserve.token, amount: s.reward.amount }] : [])),
        swaps: walletSwaps(
          legs,
          legQuotes.map((x) => x.data!),
        ),
        capitalDirect,
        collateral: C.token,
        debt: D.token,
        variableDebtToken: D.variableDebtToken,
        executor: executor!,
        version: market.executorVersion,
        minHealthFactor: minHf,
        collateralAllowance: 0n,
        borrowAllowance: 0n,
        debtAmount,
        leverQuote: lq,
      }).calls
    } catch {
      return undefined
    }
  })()

  const stepLabels = oneClick
    ? (preview ?? []).map((c) => ({ label: c.label }))
    : steps.map((s) => {
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

  const added = oneClick ? (batchCapital !== undefined ? batchCapital + deposited : undefined) : estimate + deposited
  const items = [
    {
      label: 'Rewards à réclamer',
      value: ready ? fmtDollars(totalUsd) : undefined,
      sub: ready ? `${plan.length} token${plan.length > 1 ? 's' : ''}` : undefined,
      key: true,
    },
    {
      label: 'Capital ajouté',
      value: ready && (added !== undefined || plan.length === 0) ? `${fmtAmount(added ?? 0n, C.token.decimals)} ${C.token.symbol}` : undefined,
      sub: oneClick ? 'minimum garanti des échanges' : 'au prix oracle',
      key: true,
    },
    oneClick
      ? {
          label: 'Health factor',
          value: proj ? fmtHf(proj.healthFactor) : debtAmount === 0n && plan.length === 0 ? '—' : undefined,
          sub: `après, levier ${fmtX(targetLev!)}`,
          tone: proj ? hfTone(proj.healthFactor, correlated) : undefined,
        }
      : { label: 'Levier visé', value: targetLev ? fmtX(targetLev) : '—', sub: targetLev ? 'celui de la position' : 'pas de position à reprendre' },
  ]

  return (
    <LoopLayout
      summary={
        <Summary
          items={items}
          action={
            <button className="btn primary" disabled={!!busy || !!reason} onClick={oneClick ? runBatch : runStep}>
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
        {problems.map((p) => (
          <Notice key={p} tone="bad">
            {p}
          </Notice>
        ))}
        {warnings.map((w) => (
          <Notice key={w}>{w}</Notice>
        ))}
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
        {oneClick && lq && (
          <Fold title="Devis du levier" value={`${aggregatorLabel(lq.aggregator)} · minimum ${fmtAmount(lq.minOut, C.token.decimals)} ${C.token.symbol}`}>
            <QuoteCompare quote={lq} token={C.token} />
          </Fold>
        )}
        {!oneClick && swapping && q && (
          <Fold title="Devis" value={`${aggregatorLabel(q.aggregator)} · minimum ${fmtAmount(q.minOut, C.token.decimals)} ${C.token.symbol}`}>
            <QuoteCompare quote={q} token={C.token} />
          </Fold>
        )}
        <Fold
          title="Étapes"
          value={
            oneClick
              ? 'une seule confirmation'
              : batch === false && account
                ? `${done.length} sur ${steps.length} faites · une signature par étape`
                : `${done.length} sur ${steps.length} faites`
          }
        >
          <Steps steps={stepLabels} />
          <p className="muted small">
            {oneClick
              ? 'Le portefeuille envoie ces opérations en un seul lot : toutes passent ou aucune. Chaque autorisation est du montant exact et revient à sa valeur juste après.'
              : 'Chaque étape est une transaction signée depuis le portefeuille. L’échange approuve le montant exact pour le routeur de l’agrégateur, sans autorisation durable.'}
          </p>
          {!oneClick && account && batch === true && !targetLev && (
            <p className="muted small">Sans position à reprendre sur cette paire, le réinvestissement se fait étape par étape.</p>
          )}
          {!oneClick && account && batch === false && (
            <p className="muted small">Ce portefeuille ne regroupe pas les transactions sur ce réseau : une signature par étape.</p>
          )}
        </Fold>
      </Card>
    </LoopLayout>
  )
}

function walletSwaps(legs: SwapLeg[], quotes: Quote[], allowances?: bigint[]): WalletSwap[] {
  return legs.map((leg, i) => ({ sell: leg.sell, amount: leg.amount, quote: quotes[i], allowance: allowances?.[i] ?? 0n }))
}
