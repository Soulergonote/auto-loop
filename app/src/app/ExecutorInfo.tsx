import type { Address, Chain } from 'viem'
import { QUOTE_MODE } from '../config'
import { Notice } from '../ui/primitives'
import { fmtAddress } from '../ui/format'

type Net = { label: string; chain: Chain; executor?: Address; executorSource?: string }

/** « Plateforme : … » line of a screen's settings: the protocol and the verified Auto-loop contract. */
export function PlatformLine({ platform, net, shared, note }: { platform: string; net: Net; shared: boolean; note?: string }) {
  return (
    <p className="muted small">
      Plateforme : {platform}.{' '}
      {net.executor && (
        <>
          Contrat Auto-loop vérifié :{' '}
          <a href={`${net.chain.blockExplorers?.default.url}/address/${net.executor}`} target="_blank" rel="noreferrer" title={net.executor}>
            <span className="addr">{fmtAddress(net.executor)}</span>
          </a>
          {note}
          {shared ? ' (contrat commun, même adresse pour tous)' : net.executorSource === 'wallet' && ' (ajouté depuis ce navigateur)'}.
        </>
      )}
    </p>
  )
}

export function MockQuotesNote() {
  return QUOTE_MODE === 'mock' ? <p className="muted small">Cotations simulées au prix de l’oracle (VITE_QUOTE_MODE=mock).</p> : null
}

/** The on-chain check of the declared contract: in progress, or refused (with « Oublier » for an address added here). */
export function ExecutorCheckNote({
  declared,
  check,
  onForget,
}: {
  declared: Net
  check: { isPending: boolean; isError: boolean; error: Error | null }
  onForget: () => void
}) {
  if (!declared.executor) return null
  if (check.isPending) return <p className="muted small">Vérification du contrat Auto-loop sur {declared.label}…</p>
  if (!check.isError) return null
  return (
    <Notice tone="bad">
      <span>
        Contrat <span className="addr">{fmtAddress(declared.executor)}</span> refusé : {check.error?.message}. Aucune transaction ne sera proposée avec lui.
      </span>
      {declared.executorSource === 'wallet' && (
        <button className="btn" onClick={onForget}>
          Oublier cette adresse
        </button>
      )}
    </Notice>
  )
}
