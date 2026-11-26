/**
 * Snapshot of the Scanner's sources (D1), run by the Pages workflow every hour:
 *   npx vite-node scripts/scanner-snapshot.ts public/scanner.json
 * Reads what the Scanner reads with every filter open (snapshotPlan.ts), in Node, with the app's own code, and writes
 * it for the page to show at once before reading live. A source that fails is left out; nothing read at all fails.
 */
import { writeFileSync } from 'node:fs'
import { readScannerSources } from '../src/features/scanner/snapshotPlan'
import { encodeSnapshot } from '../src/services/snapshotCodec'

const out = process.argv[2] ?? 'public/scanner.json'
const started = Date.now()
const signal = AbortSignal.timeout(8 * 60_000)
const entries = await readScannerSources(signal, (msg) => console.warn(`non lu : ${msg}`))
if (!entries.length) {
  console.error('Aucune source lue : pas d’instantané.')
  process.exit(1)
}
const text = encodeSnapshot({ version: 1, at: Date.now(), entries })
writeFileSync(out, text)
console.log(`${entries.length} sources en ${Math.round((Date.now() - started) / 1000)} s, ${Math.round(text.length / 1024)} Kio → ${out}`)
// viem's transports keep sockets open
process.exit(0)
