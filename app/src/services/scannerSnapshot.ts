/**
 * The Scanner's hourly snapshot (D1): `scanner.json`, written by the Pages workflow next to the site
 * (app/scripts/scanner-snapshot.ts). Loaded at start, it fills the page's cache under the Scanner's own query keys,
 * dated when it was read: the Scanner shows it at once, and its queries, already stale, read live behind it and
 * replace each source as it answers. A query that already holds data is left alone.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { DEMO } from '../config'
import { decodeSnapshot } from './snapshotCodec'

/** older than this, the snapshot is not shown (the workflow stopped, or a cached copy) */
export const SNAPSHOT_MAX_AGE_MS = 6 * 3_600_000

type Snapshot = { version: number; at: number; entries: { key: QueryKey; data: unknown }[] }

let loadedAt: number | undefined

/** When the snapshot in the cache was read (ms), if one was loaded. */
export const scannerSnapshotAt = () => loadedAt

/** Puts a decoded snapshot in the cache; false when it is too old or of another version. */
export function seedSnapshot(client: QueryClient, snap: Snapshot, now = Date.now()): boolean {
  if (snap.version !== 1 || !(snap.at > 0) || now - snap.at > SNAPSHOT_MAX_AGE_MS || !Array.isArray(snap.entries)) return false
  for (const e of snap.entries) if (client.getQueryData(e.key) === undefined) client.setQueryData(e.key, e.data, { updatedAt: snap.at })
  loadedAt = snap.at
  return true
}

/** Fetches and seeds the snapshot; silent when there is none (local dev, a failed hour). */
export async function loadScannerSnapshot(client: QueryClient, url = `${import.meta.env.BASE_URL}scanner.json`): Promise<boolean> {
  if (DEMO) return false
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) return false
    return seedSnapshot(client, decodeSnapshot<Snapshot>(await res.text()))
  } catch {
    return false
  }
}
