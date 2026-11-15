/**
 * What the Scanner read (J3, I7): one state per network while reading, then a discreet line under the table naming
 * the networks read, those that failed and the APIs that did not answer. Pure, tested.
 */
export type NetworkState = 'read' | 'pending' | 'failed'
export type NetworkProgress = { label: string; state: NetworkState }

/** One state per network from its sources (Aave markets, Morpho): failed if one failed, else pending if one is. */
export function networkProgress(sources: { label: string; pending: boolean; failed: boolean }[]): NetworkProgress[] {
  const out = new Map<string, NetworkState>()
  for (const s of sources) {
    const state: NetworkState = s.failed ? 'failed' : s.pending ? 'pending' : 'read'
    const was = out.get(s.label)
    if (!was || state === 'failed' || (state === 'pending' && was === 'read')) out.set(s.label, state)
  }
  return [...out].map(([label, state]) => ({ label, state }))
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

/** « 14 réseaux lus à 14:32 · en échec : Sonic · sans réponse : Pendle ». Undefined while nothing is read. */
export function sourceStatus({ networks, readAt, silent }: { networks: NetworkProgress[]; readAt: number; silent: (string | false | undefined)[] }) {
  const read = networks.filter((n) => n.state === 'read').length
  const failed = networks.filter((n) => n.state === 'failed').map((n) => n.label)
  if (read === 0 && failed.length === 0) return undefined
  const quiet = silent.filter((s): s is string => !!s)
  return [
    `${read} réseau${read > 1 ? 'x' : ''} lu${read > 1 ? 's' : ''}${readAt > 0 ? ` à ${hhmm(readAt)}` : ''}`,
    failed.length > 0 && `en échec : ${failed.join(', ')}`,
    quiet.length > 0 && `sans réponse : ${quiet.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ')
}
