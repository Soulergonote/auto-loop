/**
 * Daily check of open positions: health factor, net APY and Merkl campaigns ending, read on every network the app
 * covers, with the same rules as the Positions screen (src/lib/alerts.ts).
 *
 *   npm run alerts -- 0xADDRESS [0xADDRESS…]      (or ALERT_ADDRESSES=0x…,0x… npm run alerts)
 *
 * Prints one line per alert ("Aucune alerte." otherwise) and the networks it could not read. Read-only: no key,
 * no signature. Exit code 1 only when the arguments are wrong.
 */
import { getAddress, isAddress, type Address } from 'viem'
import { MARKETS, getMarket, type Market } from '../src/config'
import { loadSnapshot, loadUserPosition } from '../src/lib/snapshot'
import { fetchCampaigns, type Campaign } from '../src/lib/merkl'
import { openPosition } from '../src/lib/positions'
import { alertReport, positionAlerts, type Alert } from '../src/lib/alerts'
import { fmtAddress } from '../src/lib/format'

// Node globals used here (the project has no @types/node)
declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): never }

/** A public RPC that hangs is reported as unreadable instead of blocking the run. */
const TIMEOUT_MS = 45_000

const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('délai dépassé')), TIMEOUT_MS))])

async function main() {
  const raw = process.argv.slice(2).length ? process.argv.slice(2) : (process.env.ALERT_ADDRESSES ?? '').split(/[\s,]+/).filter(Boolean)
  const bad = raw.filter((a) => !isAddress(a))
  if (raw.length === 0 || bad.length > 0) {
    console.error(bad.length ? `Adresse invalide : ${bad.join(', ')}` : 'Usage : npm run alerts -- 0xADRESSE [0xADRESSE…]')
    process.exit(1)
  }
  const users: Address[] = raw.map((a) => getAddress(a))
  const markets: Market[] = MARKETS.filter((m) => !m.soon).map((m) => getMarket(m.id))

  // one Merkl read per chain; without it the APY is computed without rewards, as on the Positions screen
  const chainIds = [...new Set(markets.map((m) => m.chain.id))]
  const campaigns = new Map<number, Campaign[] | undefined>()
  await Promise.all(
    chainIds.map(async (id) => {
      campaigns.set(id, await withTimeout(fetchCampaigns(id, AbortSignal.timeout(TIMEOUT_MS))).catch(() => undefined))
    }),
  )

  const alerts: Alert[] = []
  const unreadable: string[] = []
  const open: string[] = []
  await Promise.all(
    markets.map(async (market) => {
      try {
        const snapshot = await withTimeout(loadSnapshot(market))
        for (const user of users) {
          const pos = await withTimeout(loadUserPosition(snapshot, user))
          const p = openPosition(pos.holdings, pos.healthFactor, campaigns.get(market.chain.id))
          if (!p) continue
          const label = users.length > 1 ? `${market.label} (${fmtAddress(user)})` : market.label
          open.push(label)
          alerts.push(...positionAlerts({ market: label, summary: p.summary, healthFactor: pos.healthFactor, correlated: p.correlated }))
        }
      } catch {
        unreadable.push(market.label)
      }
    }),
  )
  const merklDown = chainIds.filter((id) => campaigns.get(id) === undefined).map((id) => markets.find((m) => m.chain.id === id)!.chain.name)

  console.log(alertReport(alerts, unreadable.sort()))
  console.log(`Positions lues : ${open.length ? open.sort().join(', ') : 'aucune'}.`)
  if (merklDown.length) console.log(`Merkl indisponible pour ${merklDown.join(', ')} : APY sans bonus là-bas.`)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
