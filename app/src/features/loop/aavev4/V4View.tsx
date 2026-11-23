import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useBytecode } from 'wagmi'
import { getAddress, isAddress, type Address } from 'viem'
import { DEFAULT_DEBT_SYMBOLS, executorRouters, networkName, v4Serves, type AggregatorChoice, type V4Net } from '../../../config'
import { v4ReservesQuery, type V4Reserve } from '../../../protocols/aavev4/reserves'
import { readV4State, v4BorrowApy, v4PairKey, v4Sides, type V4Pair, type V4State } from '../../../protocols/aavev4/state'
import { verifyV4Executor } from '../../../chain/deploy'
import { useAtomicBatch } from '../../../chain/batch'
import { explainError } from '../../../chain/tx'
import { fmtAddress, fmtAmount, fmtDollars, fmtLltv, fmtPct } from '../../../ui/format'
import { Picker } from '../../../ui/Picker'
import { aaveV4SpokeUrl } from '../../../services/links'
import { bonusPagesQuery, v4BonusPage } from '../../../services/merkl'
import { ExtLink } from '../../../ui/ExtLink'
import { Card, Fold, LoopLayout, Notice, Segmented, Skel, Summary, SummaryTitle, useSlow } from '../../../ui/primitives'
import { V4OpenPanel } from './V4OpenPanel'
import { V4ClosePanel } from './V4ClosePanel'
import { V4SwapCollateralPanel } from './V4SwapCollateralPanel'
import { V4SwapDebtPanel } from './V4SwapDebtPanel'
import { V4RefinancePanel } from './V4RefinancePanel'

export type V4Tab = 'open' | 'close' | 'collateral' | 'debt' | 'refinance'
/** How the Aave v4 screen opens: a pair of a spoke (from the scanner or the positions), its tab and leverage. */
export type V4Seed = {
  chainId: number
  spoke: Address
  collateralId: number
  debtId: number
  tab?: V4Tab
  leverage?: number
  /** capital to fill in on « Ouvrir » */
  amount?: string
  /** leverage the « Fermer » slider starts at */
  target?: number
  nonce: number
}

/** Everything a v4 panel works from: the pair as listed (API) and as read on chain, with the user's position. */
export type V4Ctx = {
  net: V4Net
  pair: V4Pair
  state: V4State
  sides: ReturnType<typeof v4Sides>
  /** lending rate of the collateral reserve plus the token's own yield */
  collateralApy: number
  /** base borrow rate × (1 + risk premium of the account once this collateral backs it) */
  borrowApy: number
  /** risk premium counted in `borrowApy`, as a share of the base rate */
  riskPremium: number
  /** Merkl: extra APY on the supply, discount on the borrow */
  supplyRewardApy: number
  borrowRewardApy: number
  account?: Address
  aggregator: AggregatorChoice
  batch: boolean
  /** the account can sign the Taker's permit: false for an account with code (smart account, EIP-7702 delegation) */
  permit: boolean
  common: ReactNode
  head: ReactNode
  onDone: () => void
  /** every reserve these position managers serve, all spokes of the network */
  reserves: V4Reserve[]
  /** shows another pair (after a switch, or the place a refinance lands) */
  onPick: (p: SavedPair, tab?: V4Tab) => void
}

const usd = (x: number) => fmtDollars(x, true)
const errText = (e: unknown) => explainError(e).split('\n')[0]
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

const PAIR_KEY = 'auto-loop.v4-pair.'
export type SavedPair = { spoke: Address; collateralId: number; debtId: number }
function savedV4Pair(netId: string): SavedPair | undefined {
  try {
    const raw = localStorage.getItem(PAIR_KEY + netId)
    return raw ? (JSON.parse(raw) as SavedPair) : undefined
  } catch {
    return undefined
  }
}
function saveV4Pair(netId: string, p: SavedPair) {
  try {
    localStorage.setItem(PAIR_KEY + netId, JSON.stringify(p))
  } catch {
    // private window: the pair just isn't remembered
  }
}

/** While these position managers have no executor: what the contract is, and reuse of one already deployed. */
function V4DeployPanel({ net, onReady }: { net: V4Net; onReady: (a: Address) => void }) {
  const routers = executorRouters(net.chain.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [pasted, setPasted] = useState('')
  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      <Fold title="Contrat" value="sans propriétaire, routeurs figés" plain>
        <p className="muted small">
          Seul le gas est payé, une seule fois pour tous : le contrat est déployé à une adresse commune à tous les utilisateurs de l’app sur ce réseau
          (CREATE2), et l’app l’utilise dès qu’il existe. Le contrat n’a ni propriétaire ni fonction d’administration et ne garde aucun fonds : collatéral et
          dette restent sur le compte Aave v4 de l’adresse qui signe. Il agit par les deux gestionnaires de position d’Aave, le Giver (dépôt, remboursement){' '}
          <span className="addr">{fmtAddress(net.giver)}</span> et le Taker (emprunt, retrait) <span className="addr">{fmtAddress(net.taker)}</span>, dans la
          limite d’une autorisation donnée pour chaque opération. Flash loans : Morpho Blue <span className="addr">{fmtAddress(net.morpho)}</span>, sans frais.
          Routeurs autorisés :{' '}
          {routers.map((r, i) => (
            <span key={r.router}>
              {i > 0 && ', '}
              {r.label} (<span className="addr">{fmtAddress(r.router)}</span>)
            </span>
          ))}
          .
        </p>
        <div className="grid2">
          <label className="field">
            <span>Contrat déjà déployé</span>
            <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="0x…" spellCheck={false} />
          </label>
          <button
            className="btn"
            disabled={busy || !pasted.trim()}
            style={{ alignSelf: 'end' }}
            onClick={async () => {
              setError(undefined)
              setBusy(true)
              try {
                if (!isAddress(pasted.trim())) throw new Error('adresse invalide')
                const a = getAddress(pasted.trim())
                await verifyV4Executor(net, a)
                onReady(a)
              } catch (e) {
                setError(errText(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Vérification du contrat…' : 'Vérifier et utiliser'}
          </button>
        </div>
      </Fold>
    </>
  )
}

type Props = {
  net: V4Net
  /** protocol, network and instance selectors, shared with Aave v3 and Morpho */
  networkSelect: ReactNode
  account?: Address
  aggregator: AggregatorChoice
  common: ReactNode
  notes: ReactNode
  seed?: V4Seed
  onExecutor: (a: Address) => void
}

/** Boucle screen for Aave v4: pick a spoke, a collateral reserve and a debt reserve of it, then open or close. */
export function V4View({ net, networkSelect, account, aggregator, common, notes, seed, onExecutor }: Props) {
  const chainId = net.chain.id
  const list = useQuery(v4ReservesQuery([chainId]))
  const reserves = useMemo(() => (list.data ?? []).filter((r) => r.chainId === chainId && v4Serves(net, r.spoke.address)), [list.data, chainId, net])
  const spokes = useMemo(() => {
    const by = new Map<string, { name: string; address: Address; usd: number; pairs: number }>()
    for (const r of reserves) {
      const k = r.spoke.address.toLowerCase()
      const e = by.get(k) ?? { name: r.spoke.name, address: r.spoke.address, usd: 0, pairs: 0 }
      if (r.canBorrow) e.usd += r.borrowableUsd
      by.set(k, e)
    }
    // a spoke is offered when a loop can be built in it: a collateral and another token to borrow
    for (const e of by.values()) {
      const own = reserves.filter((r) => same(r.spoke.address, e.address))
      e.pairs = own.filter((c) => c.canCollateral).reduce((n, c) => n + own.filter((d) => d.canBorrow && !same(d.token.address, c.token.address)).length, 0)
    }
    return [...by.values()].filter((s) => s.pairs > 0).sort((a, b) => b.usd - a.usd)
  }, [reserves])

  const [picked, setPicked] = useState<SavedPair | undefined>(() =>
    seed ? { spoke: seed.spoke, collateralId: seed.collateralId, debtId: seed.debtId } : savedV4Pair(net.id),
  )
  const [tab, setTab] = useState<V4Tab>(seed?.tab ?? 'open')
  useEffect(() => {
    if (seed) {
      setPicked({ spoke: seed.spoke, collateralId: seed.collateralId, debtId: seed.debtId })
      setTab(seed.tab ?? 'open')
    }
  }, [seed])

  const spoke = spokes.find((s) => picked && same(s.address, picked.spoke)) ?? spokes[0]
  const inSpoke = useMemo(() => (spoke ? reserves.filter((r) => same(r.spoke.address, spoke.address)) : []), [reserves, spoke])
  const collaterals = inSpoke.filter((r) => r.canCollateral).sort((a, b) => b.suppliableUsd - a.suppliableUsd)
  const sameSpoke = !!picked && !!spoke && same(picked.spoke, spoke.address)
  const collateral = (sameSpoke ? collaterals.find((r) => r.reserveId === picked.collateralId) : undefined) ?? collaterals[0]
  const debts = collateral
    ? inSpoke.filter((r) => r.canBorrow && !same(r.token.address, collateral.token.address)).sort((a, b) => b.borrowableUsd - a.borrowableUsd)
    : []
  // default: the usual stablecoin when the spoke lends it, else the most borrowable reserve
  const debt =
    (sameSpoke ? debts.find((r) => r.reserveId === picked.debtId) : undefined) ??
    DEFAULT_DEBT_SYMBOLS.map((sym) => debts.find((r) => r.token.symbol === sym)).find((r) => r) ??
    debts[0]
  const pair: V4Pair | undefined = collateral && debt ? { collateral, debt } : undefined
  const choose = (p: SavedPair) => {
    setPicked(p)
    saveV4Pair(net.id, p)
  }
  // a token listed twice in a spoke (two hubs) is told apart by its hub
  const label = (r: V4Reserve) => r.token.symbol
  const twice = (r: V4Reserve) => inSpoke.filter((x) => x.token.symbol === r.token.symbol).length > 1

  const pairKey = pair ? v4PairKey(pair) : undefined
  const state = useQuery({
    queryKey: ['v4-state', net.id, pairKey, account, net.executor],
    queryFn: () => readV4State(net, pair!, account, net.executor),
    enabled: !!pair,
    refetchInterval: 30_000,
    retry: 1,
  })
  const batch = useAtomicBatch(chainId, account) === true
  // the Taker checks a signature of an account with code through ERC-1271, which a delegated EOA rarely answers
  const code = useBytecode({ chainId, address: account, query: { enabled: !!account, staleTime: 300_000 } })
  const permit = !code.data || code.data === '0x'
  const slow = useSlow(list.isPending)
  const s = state.data
  const explorer = net.chain.blockExplorers?.default.url
  const bonusPages = useQuery(bonusPagesQuery(chainId, !!pair && (pair.collateral.supplyRewardApy > 0 || pair.debt.borrowRewardApy > 0)))

  // the account's premium follows its collaterals: this one alone, or what the spoke reports when others back it too
  const riskPremium = collateral ? (s?.user?.otherPositions ? s.user.riskPremium : collateral.collateralRisk) : 0
  const borrowApy = debt ? v4BorrowApy(debt.borrowApy, riskPremium) : 0

  const head = (
    <>
      {notes}
      {!net.executor && <V4DeployPanel net={net} onReady={onExecutor} />}
      <Card
        title={
          <>
            Marché
            <ExtLink
              href={pair && aaveV4SpokeUrl(chainId, pair.collateral.spoke.address)}
              title={pair ? `Spoke ${pair.collateral.spoke.name} sur Aave v4` : 'Aave v4'}
            />
          </>
        }
      >
        {networkSelect}
        {spoke && pair ? (
          <>
            <Picker
              label={`Spoke (${spokes.length} sur ce réseau)`}
              value={spoke.address}
              onChange={(a) => choose({ spoke: a as Address, collateralId: -1, debtId: -1 })}
              wide
              columns={['Paires', 'Empruntable']}
              options={spokes.map((x) => ({ value: x.address, label: x.name, cells: [String(x.pairs), usd(x.usd)] }))}
            />
            <div className="market-row two">
              <div className="pair">
                <Picker
                  label="Collatéral"
                  value={String(pair.collateral.reserveId)}
                  onChange={(id) => choose({ spoke: spoke.address, collateralId: Number(id), debtId: pair.debt.reserveId })}
                  columns={['Seuil', 'Rendement']}
                  options={collaterals.map((r) => ({
                    value: String(r.reserveId),
                    label: label(r),
                    sub: twice(r) ? r.hub : undefined,
                    cells: [fmtLltv(r.collateralFactor), fmtPct(r.supplyApy + r.underlyingApy)],
                  }))}
                />
                <Picker
                  label="Dette"
                  value={String(pair.debt.reserveId)}
                  onChange={(id) => choose({ spoke: spoke.address, collateralId: pair.collateral.reserveId, debtId: Number(id) })}
                  columns={['Empruntable', 'Taux']}
                  options={debts.map((r) => ({
                    value: String(r.reserveId),
                    label: label(r),
                    sub: twice(r) ? r.hub : undefined,
                    cells: [usd(r.borrowableUsd), fmtPct(r.borrowApy)],
                  }))}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="field">
            <span>Spoke</span>
            <Skel w={12} />
          </div>
        )}
        {list.isSuccess && spokes.length === 0 && <Notice>Aucun spoke Aave v4 avec une paire à boucler sur ce réseau pour l’instant.</Notice>}
        {list.isError && (
          <Notice>
            <span>API Aave v4 injoignable : {(list.error as Error).message}</span>
            <button className="btn" onClick={() => void list.refetch()}>
              Réessayer
            </button>
          </Notice>
        )}
        {slow && !list.isError && <Notice>L’API Aave v4 répond lentement.</Notice>}
        {state.isError && <Notice tone="bad">Lecture du spoke sur Aave v4 impossible : {errText(state.error)}</Notice>}
        {pair && (
          <Fold
            title="Taux Aave v4"
            value={`emprunt ${pair.debt.token.symbol} ${fmtPct(borrowApy)}${pair.debt.borrowRewardApy > 0 ? ` − ${fmtPct(pair.debt.borrowRewardApy)} récompenses` : ''} · seuil ${fmtLltv(pair.collateral.collateralFactor)}`}
          >
            <dl className="preview">
              <dt>Spoke</dt>
              <dd>
                {pair.collateral.spoke.name}{' '}
                <a href={`${explorer}/address/${pair.collateral.spoke.address}`} target="_blank" rel="noreferrer" title={pair.collateral.spoke.address}>
                  <span className="addr">{fmtAddress(pair.collateral.spoke.address)}</span>
                </a>
              </dd>
              <dt>Collatéral</dt>
              <dd>
                {pair.collateral.token.symbol} · réserve {pair.collateral.reserveId}
                {pair.collateral.hub && ` · hub ${pair.collateral.hub}`} · prêt {fmtPct(pair.collateral.supplyApy)}
                {pair.collateral.underlyingApy > 0 && ` + rendement propre ${fmtPct(pair.collateral.underlyingApy)}`}
                {pair.collateral.supplyRewardApy > 0 && (
                  <span className="reward">
                    {' '}
                    + {fmtPct(pair.collateral.supplyRewardApy)} récompenses
                    <ExtLink href={v4BonusPage(bonusPages.data, pair.collateral.token.address, 'supply')} title="Bonus sur Merkl" />
                  </span>
                )}
              </dd>
              <dt>Emprunt</dt>
              <dd>
                {pair.debt.token.symbol} · réserve {pair.debt.reserveId}
                {pair.debt.hub && ` · hub ${pair.debt.hub}`} · {fmtPct(pair.debt.borrowApy)} de base
                {riskPremium > 0 && ` + prime de risque ${fmtPct(pair.debt.borrowApy * riskPremium)}`}
                {pair.debt.borrowRewardApy > 0 && (
                  <span className="reward">
                    {' '}
                    − {fmtPct(pair.debt.borrowRewardApy)} récompenses
                    <ExtLink href={v4BonusPage(bonusPages.data, pair.debt.token.address, 'borrow')} title="Bonus sur Merkl" />
                  </span>
                )}
              </dd>
              <dt>Liquidité</dt>
              <dd>
                empruntable {usd(pair.debt.borrowableUsd)} · dépôt encore possible {usd(pair.collateral.suppliableUsd)}
                {s && ` · flash loan Morpho jusqu’à ${fmtAmount(s.flashLiquidity, pair.debt.token.decimals)} ${pair.debt.token.symbol}`}
              </dd>
            </dl>
            <p className="muted small">
              Sur Aave v4, la position vit dans un spoke : ses collatéraux y garantissent ses dettes. La liquidation a lieu quand le health factor (valeur des
              collatéraux × seuil / dette) passe sous 1. Le taux d’emprunt est le taux de base de la réserve, augmenté d’une prime de risque qui dépend des
              collatéraux du compte.
            </p>
          </Fold>
        )}
        {s?.user?.otherPositions && (
          <Notice>
            Ce compte a d’autres collatéraux ou d’autres dettes dans ce spoke : le health factor du compte les compte tous, les projections de cet écran ne
            portent que sur cette paire.
          </Notice>
        )}
      </Card>
      <div className="tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'open', label: 'Ouvrir / augmenter' },
            { value: 'close', label: 'Fermer / réduire' },
            { value: 'collateral', label: 'Changer de collatéral' },
            { value: 'debt', label: 'Changer de dette' },
            { value: 'refinance', label: 'Refinancer' },
          ]}
        />
      </div>
    </>
  )

  if (!pair || !s)
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

  const ctx: V4Ctx = {
    net,
    pair,
    state: s,
    sides: v4Sides(pair, s),
    collateralApy: pair.collateral.supplyApy + pair.collateral.underlyingApy,
    borrowApy,
    riskPremium,
    supplyRewardApy: pair.collateral.supplyRewardApy,
    borrowRewardApy: pair.debt.borrowRewardApy,
    account,
    aggregator,
    batch,
    permit,
    common,
    head,
    onDone: () => void state.refetch(),
    reserves,
    onPick: (p, t) => {
      choose(p)
      if (t) setTab(t)
    },
  }
  const key = `${pairKey}-${seed?.nonce ?? ''}`
  const mine =
    seed && same(seed.spoke, pair.collateral.spoke.address) && seed.collateralId === pair.collateral.reserveId && seed.debtId === pair.debt.reserveId
      ? seed
      : undefined
  const titled = (el: ReactNode) => (
    <SummaryTitle value={`${pair.collateral.token.symbol}/${pair.debt.token.symbol} · ${networkName(net.label)}`}>{el}</SummaryTitle>
  )
  if (tab === 'close') return titled(<V4ClosePanel key={key} ctx={ctx} seedTarget={mine?.target} />)
  if (tab === 'collateral') return titled(<V4SwapCollateralPanel key={key} ctx={ctx} />)
  if (tab === 'debt') return titled(<V4SwapDebtPanel key={key} ctx={ctx} />)
  if (tab === 'refinance') return titled(<V4RefinancePanel key={key} ctx={ctx} />)
  return titled(<V4OpenPanel key={key} ctx={ctx} seedLeverage={mine?.leverage} seedAmount={mine?.amount} />)
}

/** Short name of a v4 pair for lists: collateral / debt, spoke. */
