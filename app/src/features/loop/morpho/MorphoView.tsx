import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAddress, isAddress, type Address, type Hash, type Hex } from 'viem'
import { executorRouters, type AggregatorChoice, type MorphoNet } from '../../../config'
import { marketSizeUsd, morphoMarketsQuery, readMorphoState, morphoSides, type MorphoMarket, type MorphoState } from '../../../protocols/morpho/markets'
import { ptInfosQuery, needsRenewal, type PtInfo } from '../../../protocols/pendle/pt'
import { yieldSourceText } from '../../../services/yield/nativeYield'
import { verifyMorphoExecutor } from '../../../chain/deploy'
import { revokeMorphoAuthorization } from '../../../protocols/morpho/execute'
import { useAtomicBatch } from '../../../chain/batch'
import { explainError } from '../../../chain/tx'
import { fmtLltv, fmtAddress, fmtAmount, fmtDollars, fmtPct, ptShortSymbol } from '../../../ui/format'
import { useBalances } from '../../../chain/walletTokens'
import { Picker } from '../../../ui/Picker'
import { Card, Fold, LoopLayout, Notice, Segmented, Skel, Summary, Tag, TxResult, useSlow } from '../../../ui/primitives'
import { MorphoOpenPanel } from './MorphoOpenPanel'
import { MorphoClosePanel } from './MorphoClosePanel'
import { MorphoRollPanel } from './MorphoRollPanel'

export type MorphoTab = 'open' | 'close' | 'roll'
/** How the Morpho screen opens: a market (from the scanner or the positions), its tab and leverage. */
export type MorphoSeed = {
  market: MorphoMarket
  tab?: MorphoTab
  leverage?: number
  /** capital to fill in on « Ouvrir » ('0' raises the leverage of the position) */
  amount?: string
  /** leverage the « Fermer » slider starts at (a rebalance from Positions) */
  target?: number
  nonce: number
}

/** Everything a Morpho panel works from: the market as listed and as read on-chain, the user's position, the PT. */
export type MorphoCtx = {
  net: MorphoNet
  market: MorphoMarket
  state: MorphoState
  pt?: PtInfo
  /** the collateral's yield: a PT's implied APY, otherwise the token's own (API) */
  collateralApy: number
  /** borrow APY now (the IRM's on-chain rate, the API's when unreadable) and the rewards the API counts */
  borrowApy: number
  rewardsApr: number
  sides: ReturnType<typeof morphoSides>
  account?: Address
  aggregator: AggregatorChoice
  batch: boolean
  /** markets of the network (same API list), for the roll targets */
  markets: MorphoMarket[]
  common: ReactNode
  head: ReactNode
  onDone: () => void
  /** after a market change: shows the new market, with the transaction's result above it */
  onMoved: (to: Hex, result: MovedResult) => void
}
type MovedResult = { ok: boolean; text: string; hash?: Hash; details?: string[] }

const usd = (x: number) => fmtDollars(x, true)
/** Markets under this much collateral and liquidity are left out of the pickers (empty or test markets). */
const MIN_MARKET_USD = 1_000

function errText(e: unknown) {
  return explainError(e).split('\n')[0]
}

/** While the network has no Morpho executor: reuse one already deployed (the summary's button deploys a new one). */
function MorphoDeployPanel({ net, onReady }: { net: MorphoNet; onReady: (a: Address) => void }) {
  const routers = executorRouters(net.chain.id)
  const [step, setStep] = useState<string>()
  const [error, setError] = useState<string>()
  const [pasted, setPasted] = useState('')
  async function run(task: () => Promise<Address>) {
    setError(undefined)
    try {
      onReady(await task())
    } catch (e) {
      setError(errText(e))
    } finally {
      setStep(undefined)
    }
  }
  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      <Fold title="Contrat" value="sans propriétaire, routeurs figés" plain>
        <p className="muted small">
          Seul le gas est payé, une seule fois pour tous : le contrat est déployé à une adresse commune à tous les utilisateurs de l’app sur ce réseau
          (CREATE2), et l’app l’utilise dès qu’il existe. Le contrat n’a ni propriétaire ni fonction d’administration et ne garde aucun fonds : collatéral et
          dette restent sur le compte Morpho de l’adresse qui signe. Il n’agit sur ce compte que pendant la transaction signée : l’autorisation Morpho est
          donnée puis retirée dans la même transaction. Morpho Blue : <span className="addr">{fmtAddress(net.morpho)}</span>. Routeurs autorisés :{' '}
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
            disabled={!!step || !pasted.trim()}
            style={{ alignSelf: 'end' }}
            onClick={() =>
              run(async () => {
                if (!isAddress(pasted.trim())) throw new Error('adresse invalide')
                const a = getAddress(pasted.trim())
                setStep('Vérification du contrat…')
                await verifyMorphoExecutor(net, a)
                return a
              })
            }
          >
            Vérifier et utiliser
          </button>
        </div>
      </Fold>
    </>
  )
}

/** Label of a market among those of the same pair: LLTV, oracle, liquidity. */
const marketLabel = (m: MorphoMarket) =>
  `LLTV ${fmtLltv(m.lltv)} · liquidité ${usd(m.liquidityUsd)} · emprunt ${fmtPct(m.borrowApy)}${m.listed ? '' : ' · non listé'}`

type Props = {
  net: MorphoNet
  /** the network selector, shared with Aave */
  networkSelect: ReactNode
  account?: Address
  aggregator: AggregatorChoice
  common: ReactNode
  notes: ReactNode
  seed?: MorphoSeed
  onExecutor: (a: Address) => void
}

/** Boucle screen for Morpho Blue: pick a market (collateral, loan token, then LLTV / oracle), then open, close or move. */
export function MorphoView({ net, networkSelect, account, aggregator, common, notes, seed, onExecutor }: Props) {
  const chainId = net.chain.id
  const onchain = !!net.onchain
  const [unlisted, setUnlisted] = useState(false)
  const listed = useQuery(morphoMarketsQuery(chainId, false))
  const others = useQuery({ ...morphoMarketsQuery(chainId, true), enabled: unlisted })
  const markets = useMemo(() => {
    const all = [...(listed.data ?? []), ...(unlisted ? (others.data ?? []) : [])]
    // a market given by the scanner or the positions is offered even when it is not in the list (unlisted)
    if (seed && !all.some((m) => m.id === seed.market.id)) all.push(seed.market)
    return all.filter((m) => marketSizeUsd(m) + m.liquidityUsd >= MIN_MARKET_USD || m.id === seed?.market.id)
  }, [listed.data, others.data, unlisted, seed])
  const [picked, setPicked] = useState<Hex | undefined>(seed?.market.id)
  const [tab, setTab] = useState<MorphoTab>(seed?.tab ?? 'open')
  useEffect(() => {
    if (seed) {
      setPicked(seed.market.id)
      setTab(seed.tab ?? 'open')
    }
  }, [seed])

  // default: the market with the most collateral
  const market = markets.find((m) => m.id === picked) ?? [...markets].sort((a, b) => marketSizeUsd(b) - marketSizeUsd(a))[0]
  const collaterals = useMemo(() => {
    const by = new Map<string, { token: MorphoMarket['collateral']; usd: number }>()
    for (const m of markets) {
      const k = m.collateral.address.toLowerCase()
      const e = by.get(k) ?? { token: m.collateral, usd: 0 }
      e.usd += marketSizeUsd(m)
      by.set(k, e)
    }
    return [...by.values()].sort((a, b) => b.usd - a.usd)
  }, [markets])
  const collateralTokens = useMemo(() => collaterals.map((c) => c.token), [collaterals])
  const balances = useBalances(net.chain.id, collateralTokens, account)
  const sameCollateral = market ? markets.filter((m) => m.collateral.address === market.collateral.address) : []
  const loans = [...new Map(sameCollateral.map((m) => [m.loan.address, m.loan])).values()]
  const samePair = market ? sameCollateral.filter((m) => m.loan.address === market.loan.address).sort((a, b) => b.liquidityUsd - a.liquidityUsd) : []
  const bestOf = (list: MorphoMarket[]) => [...list].sort((a, b) => b.liquidityUsd + marketSizeUsd(b) - (a.liquidityUsd + marketSizeUsd(a)))[0]

  const state = useQuery({
    queryKey: ['morpho-state', chainId, market?.id, account, net.executor],
    queryFn: () => readMorphoState(chainId, net.morpho, market!, account, net.executor),
    enabled: !!market,
    refetchInterval: 30_000,
    retry: 1,
  })
  const ptQuery = useQuery(ptInfosQuery(chainId, market ? [market.collateral.address] : []))
  const pt = market ? ptQuery.data?.get(market.collateral.address.toLowerCase()) : undefined
  const batch = useAtomicBatch(chainId, account) === true
  const slow = useSlow(listed.isPending)
  const [revoking, setRevoking] = useState<string>()
  const [revokeError, setRevokeError] = useState<string>()
  const [moved, setMoved] = useState<{ to: Hex; result: MovedResult }>()

  const s = state.data
  const hasPosition = !!s?.user && s.user.collateral > 0n
  const borrowApy = s?.borrowApy ?? market?.borrowApy ?? 0
  const collateralApy = pt ? (pt.expired ? 0 : (pt.impliedApy ?? 0)) : (market?.collateralYield?.apy ?? 0)
  const canRoll = hasPosition
  const rollLabel = pt && needsRenewal(pt) ? 'Renouveler' : 'Changer de marché'

  const head = (
    <>
      {notes}
      {!net.executor && <MorphoDeployPanel net={net} onReady={onExecutor} />}
      {s?.user?.authorized && account && net.executor && (
        <Notice>
          <span>
            Le contrat Auto-loop est autorisé en permanence sur le compte Morpho de cette adresse. Il n’en a besoin que pendant chaque transaction : retirer
            cette autorisation.
          </span>
          <button
            className="btn"
            disabled={!!revoking}
            onClick={async () => {
              setRevoking('Révocation…')
              setRevokeError(undefined)
              try {
                await revokeMorphoAuthorization(net, account, net.executor!)
                await state.refetch()
              } catch (e) {
                setRevokeError(errText(e))
              } finally {
                setRevoking(undefined)
              }
            }}
          >
            {revoking ?? 'Retirer l’autorisation'}
          </button>
        </Notice>
      )}
      {revokeError && <Notice tone="bad">{revokeError}</Notice>}
      {moved && moved.to === market?.id && (
        <Card title="Position déplacée sur ce marché">
          <TxResult market={net} result={moved.result} />
        </Card>
      )}
      <Card title="Marché">
        {networkSelect}
        <div className="market-row two">
          {market ? (
            <div className="pair">
              <Picker
                label="Collatéral"
                value={market.collateral.address}
                onChange={(a) => setPicked(bestOf(markets.filter((m) => m.collateral.address === a))?.id)}
                columns={balances.size > 0 ? ['Solde', 'Déposé'] : ['Déposé']}
                options={collaterals.map((c) => {
                  const b = balances.get(c.token.address)
                  return {
                    value: c.token.address,
                    label: ptShortSymbol(c.token.symbol),
                    keywords: c.token.symbol,
                    cells: [...(balances.size > 0 ? [b ? fmtAmount(b, c.token.decimals) : <span className="na">—</span>] : []), usd(c.usd)],
                  }
                })}
              />
              <Picker
                label="Dette"
                value={market.loan.address}
                onChange={(a) => setPicked(bestOf(sameCollateral.filter((m) => m.loan.address === a))?.id)}
                options={loans.map((t) => ({ value: t.address, label: t.symbol }))}
              />
            </div>
          ) : (
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <span>Marché</span>
              <Skel w={12} />
            </div>
          )}
        </div>
        {market && samePair.length > 1 && (
          <Picker
            label={`Marché Morpho (${samePair.length} pour cette paire)`}
            value={market.id}
            onChange={(id) => setPicked(id as Hex)}
            display={marketLabel(market)}
            wide
            columns={['Liquidité', 'Emprunt']}
            options={samePair.map((m) => ({
              value: m.id,
              label: `LLTV ${fmtLltv(m.lltv)}`,
              sub: m.listed ? undefined : 'non listé',
              cells: [usd(m.liquidityUsd), fmtPct(m.borrowApy)],
            }))}
          />
        )}
        {onchain ? (
          <p className="muted small">
            Morpho ne publie pas de liste pour ce réseau : marchés lus sur la chaîne (au moins {usd(10_000)} déposés), aucun n’est revu par Morpho.
          </p>
        ) : (
          <label className="check small">
            <input type="checkbox" checked={unlisted} onChange={(e) => setUnlisted(e.target.checked)} /> Inclure les marchés non listés par Morpho (au moins{' '}
            {usd(10_000)} déposés)
          </label>
        )}
        {listed.isSuccess && markets.length === 0 && <Notice>Aucun marché Morpho assez grand sur ce réseau pour l’instant.</Notice>}
        {listed.isError && (
          <Notice>
            <span>
              {onchain ? 'Marchés Morpho illisibles sur la chaîne' : 'API Morpho injoignable'} : {(listed.error as Error).message}
            </span>
            <button className="btn" onClick={() => void listed.refetch()}>
              Réessayer
            </button>
          </Notice>
        )}
        {slow && !listed.isError && <Notice>{onchain ? 'La lecture des marchés sur la chaîne prend du temps.' : 'L’API Morpho répond lentement.'}</Notice>}
        {state.isError && <Notice tone="bad">Lecture du marché sur Morpho impossible : {errText(state.error)}</Notice>}
        {market && (
          <Fold
            title="Taux Morpho"
            value={`emprunt ${market.loan.symbol} ${fmtPct(borrowApy)}${market.borrowRewardsApr > 0 ? ` − ${fmtPct(market.borrowRewardsApr)} récompenses` : ''} · LLTV ${fmtLltv(market.lltv)}`}
          >
            <dl className="preview">
              <dt>Marché</dt>
              <dd className="mono">{market.id}</dd>
              <dt>Collatéral</dt>
              <dd>
                {market.collateral.symbol}
                {pt
                  ? ` · PT, APY implicite ${fmtPct(collateralApy)}`
                  : market.collateralYield
                    ? ` · rendement propre ${fmtPct(market.collateralYield.apy)} (${yieldSourceText(market.collateralYield)})`
                    : ''}
              </dd>
              <dt>Emprunt</dt>
              <dd>
                {fmtPct(borrowApy)} {s?.borrowApy !== undefined ? '(taux de l’IRM lu on-chain)' : '(API Morpho)'}
                {market.borrowRewardsApr > 0 && <span className="reward"> − {fmtPct(market.borrowRewardsApr)} récompenses</span>}
              </dd>
              <dt>Liquidité</dt>
              <dd>
                {usd(market.liquidityUsd)} · utilisation {fmtPct(market.utilization, 1)} ·{' '}
                {market.collateralTotalUsd > 0 ? `collatéral déposé ${usd(market.collateralTotalUsd)}` : `emprunté ${usd(market.borrowUsd)}`}
              </dd>
              <dt>Oracle</dt>
              <dd>
                <a href={`${net.chain.blockExplorers?.default.url}/address/${market.params.oracle}`} target="_blank" rel="noreferrer">
                  <span className="addr">{fmtAddress(market.params.oracle)}</span>
                </a>{' '}
                {market.oracleType ?? ''}
              </dd>
            </dl>
            <p className="muted small">
              Sur Morpho, chaque marché est isolé : un collatéral, une dette, un oracle et un LLTV (seuil de liquidation) fixés à sa création. La liquidation a
              lieu quand le health factor (valeur du collatéral à l’oracle × LLTV / dette) passe sous 1.
            </p>
          </Fold>
        )}
        {market && !market.listed && (
          <Notice>
            {market.source === 'chain' ? 'Marché lu sur la chaîne' : 'Marché non listé par Morpho'} : oracle et paramètres non revus par Morpho. Vérifier
            l’oracle avant d’y déposer.
          </Notice>
        )}
        {market && market.oracleType === 'Unknown' && <Notice>Oracle de type inconnu pour l’API Morpho : vérifier sa source de prix avant d’y déposer.</Notice>}
        {market?.warnings
          .filter((w) => w.level === 'RED')
          .map((w) => (
            <Notice key={w.type} tone="bad">
              Alerte Morpho sur ce marché : {w.type.toLowerCase().replace(/_/g, ' ')}.
            </Notice>
          ))}
      </Card>
      <div className="tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'open', label: 'Ouvrir / augmenter' },
            { value: 'close', label: 'Fermer / réduire' },
            ...(canRoll || tab === 'roll' ? [{ value: 'roll' as const, label: rollLabel }] : []),
          ]}
        />
      </div>
    </>
  )

  if (!market || !s)
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

  const ctx: MorphoCtx = {
    net,
    market,
    state: s,
    pt,
    collateralApy,
    borrowApy,
    rewardsApr: market.borrowRewardsApr,
    sides: morphoSides(market, s.price),
    account,
    aggregator,
    batch,
    markets,
    common,
    head,
    onDone: () => void state.refetch(),
    onMoved: (to, result) => {
      setMoved({ to, result })
      setPicked(to)
      setTab('close')
    },
  }
  const key = `${market.id}-${seed?.nonce ?? ''}`
  if (tab === 'roll' && hasPosition) return <MorphoRollPanel key={key} ctx={ctx} renew={rollLabel === 'Renouveler'} />
  const mine = seed?.market.id === market.id ? seed : undefined
  if (tab === 'close') return <MorphoClosePanel key={key} ctx={ctx} seedTarget={mine?.target} />
  return <MorphoOpenPanel key={key} ctx={ctx} seedLeverage={mine?.leverage} seedAmount={mine?.amount} />
}

/** Short name of a market for lists: collateral / loan, LLTV. */
export const morphoMarketName = (m: MorphoMarket) => `${ptShortSymbol(m.collateral.symbol)} / ${m.loan.symbol} · ${fmtLltv(m.lltv)}`

export function MorphoTag() {
  return <Tag>Morpho</Tag>
}
