import type { Address } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { DEMO } from '../../config'
import type { RatePoint } from '../../domain/apyHistory'

/**
 * Daily supply and borrow rates of a reserve over the last six months, from Aave's public API (no key, CORS open):
 * one average rate per UTC day. Used for the 30 and 90-day history of a loop (I3). Forks (SparkLend) are not in it:
 * the query answers an empty list, and no history is shown.
 */
const AAVE_API = 'https://api.v3.aave.com/graphql'

type Row = { date: string; avgRate: { value: string } }

const toPoints = (rows: Row[] | undefined): RatePoint[] =>
  (rows ?? []).map((r) => ({ t: Date.parse(r.date), v: Number(r.avgRate.value) })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))

export async function readAaveRateSeries(chainId: number, pool: Address, collateral: Address, debt: Address, signal?: AbortSignal) {
  const req = (token: Address) => `{ market: "${pool}", underlyingToken: "${token}", chainId: ${chainId}, window: LAST_SIX_MONTHS }`
  const query = `{ supply: supplyAPYHistory(request: ${req(collateral)}) { date avgRate { value } } borrow: borrowAPYHistory(request: ${req(debt)}) { date avgRate { value } } }`
  const res = await fetch(AAVE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal })
  if (!res.ok) throw new Error(`API Aave : HTTP ${res.status}`)
  const body = (await res.json()) as { data?: { supply?: Row[]; borrow?: Row[] }; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(`API Aave : ${body.errors[0].message}`)
  return { supply: toPoints(body.data?.supply), borrow: toPoints(body.data?.borrow) }
}

export function useAaveRateSeries(chainId: number, pool: Address, collateral: Address, debt: Address) {
  return useQuery({
    queryKey: ['aaveRateSeries', chainId, pool, collateral, debt],
    queryFn: ({ signal }) => readAaveRateSeries(chainId, pool, collateral, debt, signal),
    enabled: !DEMO,
    staleTime: 3 * 3_600_000,
    retry: 1,
  })
}
