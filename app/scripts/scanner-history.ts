/**
 * Home-made daily history (D1), run by the Pages workflow after the snapshot:
 *   npx vite-node scripts/scanner-history.ts public/scanner.json <history dir>
 * Writes <dir>/YYYY-MM-DD.json once a day (the first run after midnight UTC keeps the day): each reserve's rates as
 * the Scanner read them, including the sources no API keeps a history of (Aave v4, SparkLend, tokens' own yield).
 * Pair yields can be rebuilt from it at any leverage. The workflow commits the folder to the `data` branch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryKey } from '@tanstack/react-query'
import { decodeSnapshot } from '../src/services/snapshotCodec'
import type { Snapshot } from '../src/protocols/aave/snapshot'
import type { MorphoMarket } from '../src/protocols/morpho/markets'
import type { V4Reserve } from '../src/protocols/aavev4/reserves'

const [file = 'public/scanner.json', dir = 'history'] = process.argv.slice(2)
const snap = decodeSnapshot<{ at: number; entries: { key: QueryKey; data: unknown }[] }>(readFileSync(file, 'utf8'))
const day = new Date(snap.at).toISOString().slice(0, 10)
const out = join(dir, `${day}.json`)
if (existsSync(out)) {
  console.log(`${out} existe déjà : rien à écrire.`)
  process.exit(0)
}
const of = (name: string) => snap.entries.filter((e) => e.key[0] === name)
const round = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? undefined : Math.round(x * 1e6) / 1e6)

const aave = of('snapshot').flatMap((e) => {
  const s = e.data as Snapshot
  return s.reserves.map((r) => ({
    market: s.market.id,
    token: r.token.address,
    symbol: r.token.symbol,
    supplyApy: round(r.supplyApy),
    borrowApy: round(r.borrowApy),
    nativeApy: round(r.native?.apy),
    cashUsd: Math.round(Number(r.cashBase) / 1e8),
  }))
})
const v4 = of('aave-v4-reserves').flatMap((e) =>
  (e.data as V4Reserve[]).map((r) => ({
    chainId: r.chainId,
    spoke: r.spoke.address,
    reserveId: r.reserveId,
    symbol: r.token.symbol,
    supplyApy: round(r.supplyApy),
    underlyingApy: round(r.underlyingApy),
    borrowApy: round(r.borrowApy),
  })),
)
const morpho = of('morpho-markets').flatMap((e) =>
  (e.data as MorphoMarket[]).map((m) => ({
    chainId: m.chainId,
    id: m.id,
    pair: `${m.collateral.symbol}/${m.loan.symbol}`,
    borrowApy: round(m.borrowApy),
    rewardsApr: round(m.borrowRewardsApr),
    collateralApy: round(m.collateralYield?.apy),
    liquidityUsd: Math.round(m.liquidityUsd),
  })),
)
mkdirSync(dir, { recursive: true })
writeFileSync(out, JSON.stringify({ version: 1, at: snap.at, aave, v4, morpho }))
console.log(`${out} : ${aave.length} réserves Aave, ${v4.length} Aave v4, ${morpho.length} marchés Morpho`)
