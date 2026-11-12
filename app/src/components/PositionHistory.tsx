/**
 * "Gain réel" fold of a position card: what the position earned since its first deposit (flows valued at the price of
 * their day, against its worth now), the realised rate, and one line per transaction with its explorer link.
 */
import { useQuery } from '@tanstack/react-query'
import type { Address, Chain } from 'viem'
import { historicalPrices, historyLines, positionGain, type Flow } from '../lib/history'
import { fmtDate, fmtDollars, fmtNum, fmtPct } from '../lib/format'
import { apyTone } from '../lib/tone'
import { Fold, Metric, TxLink } from './ui'

/** transactions listed, newest first */
const MAX_LINES = 30

const VERB: Record<Flow['kind'], string> = {
  supply: 'déposé',
  withdraw: 'retiré',
  borrow: 'emprunté',
  repay: 'remboursé',
  seized: 'saisi',
  liquidationRepay: 'remboursé par le liquidateur',
}

export function PositionHistory({
  chain,
  queryKey,
  load,
  equityUsd,
  now,
  reference,
}: {
  chain: Chain
  /** identifies the position (protocol, network, market, account) */
  queryKey: unknown[]
  load: (signal: AbortSignal) => Promise<{ flows: Flow[]; complete: boolean }>
  /** worth of the position now, USD */
  equityUsd: number
  /** today's USD price of each token of the position, by lower-case address */
  now: Map<string, number>
  /** the token the gain is also given in (the debt asset) */
  reference?: { address: Address; symbol: string }
}) {
  const history = useQuery({ queryKey: ['history', ...queryKey], queryFn: ({ signal }) => load(signal), staleTime: 10 * 60_000, retry: 1 })
  const flows = history.data?.flows
  const wanted = (flows ?? []).flatMap((f) => [{ token: f.token, time: f.time }, ...(reference ? [{ token: reference.address, time: f.time }] : [])])
  const prices = useQuery({
    queryKey: ['history-prices', chain.id, ...wanted.map((w) => `${w.token}@${w.time}`).sort()],
    queryFn: ({ signal }) => historicalPrices(chain.id, wanted, signal),
    enabled: !!flows && flows.length > 0,
    staleTime: Infinity,
    retry: 1,
  })
  // an incomplete history (too long, or receipts the RPC did not give) would give a wrong gain: none is shown
  const partial = !!history.data && !history.data.complete
  const gain =
    flows && prices.data && !partial ? positionGain(flows, prices.data, now, equityUsd, Math.floor(Date.now() / 1000), reference?.address) : undefined
  const failed = history.isError || prices.isError

  const value = failed
    ? 'indisponible'
    : history.isPending || (flows && flows.length > 0 && prices.isPending)
      ? 'lecture…'
      : partial
        ? 'historique incomplet'
        : gain
          ? `${gain.gainUsd >= 0 ? '+' : ''}${fmtDollars(gain.gainUsd)} depuis le ${fmtDate(gain.since)}`
          : 'aucun mouvement trouvé'
  const lines = flows ? historyLines(flows) : []
  const shown = lines.slice(0, MAX_LINES)

  return (
    <Fold title="Gain réel" value={value}>
      {failed && (
        <p className="muted small">
          {history.isError ? 'Historique illisible (API du protocole injoignable).' : 'Prix historiques illisibles (DefiLlama injoignable).'}{' '}
          <button className="link" onClick={() => void (history.isError ? history.refetch() : prices.refetch())}>
            Réessayer
          </button>
        </p>
      )}
      {partial && (
        <p className="muted small">Historique trop long ou illisible en entier (RPC qui ne répond pas) : gain non calculé, faute de tous les mouvements.</p>
      )}
      {gain && (
        <div className="metrics">
          <Metric
            label="Gagné depuis l’ouverture"
            value={`${gain.gainUsd >= 0 ? '+' : ''}${fmtDollars(gain.gainUsd)}`}
            tone={apyTone(gain.gainUsd)}
            sub={reference && gain.gainInRef !== undefined ? `soit ${gain.gainInRef >= 0 ? '+' : ''}${fmtNum(gain.gainInRef)} ${reference.symbol}` : undefined}
          />
          <Metric
            label="Rendement réalisé"
            value={gain.apy !== undefined ? fmtPct(gain.apy) : '—'}
            tone={apyTone(gain.apy)}
            sub={gain.apy !== undefined ? 'par an, pondéré par la durée' : Date.now() / 1000 - gain.since < 86_400 ? 'moins d’un jour' : 'non calculable'}
          />
          <Metric label="Apport net" value={fmtDollars(gain.netInUsd)} sub={`depuis le ${fmtDate(gain.since)}`} />
        </div>
      )}
      {gain && (
        <p className="muted small">
          Valeur nette actuelle moins l’apport net (dépôts et remboursements moins retraits et emprunts, chacun au prix de son jour). Frais de gas non comptés.
          {gain.approximated > 0 &&
            ` ${gain.approximated} mouvement${gain.approximated > 1 ? 's' : ''} sans prix du jour, compté${gain.approximated > 1 ? 's' : ''} au prix actuel.`}
        </p>
      )}
      {lines.length > 0 && (
        <table className="reserves history cards">
          <thead>
            <tr>
              <th>Date</th>
              <th>Opération</th>
              <th>Montants</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.tx}>
                <td data-label="Date">{fmtDate(l.time)}</td>
                <td className="lead">{l.label}</td>
                <td data-label="Montants">{l.parts.map((p) => `${fmtNum(p.amount)} ${p.symbol} ${VERB[p.kind]}`).join(' · ')}</td>
                <td>
                  <TxLink market={{ chain }} hash={l.tx} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lines.length > shown.length && <p className="muted small">{lines.length - shown.length} transactions plus anciennes non affichées.</p>}
    </Fold>
  )
}
