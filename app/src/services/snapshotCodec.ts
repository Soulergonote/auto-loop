/**
 * JSON for the Scanner's snapshot (D1): what the queries hold, with what JSON cannot carry tagged. A bigint becomes
 * {"$n": "123"}, a Map {"$map": [[k, v]…]}, an Aave market {"$market": id} (rebuilt from the config, so the page's
 * own executor settings apply).
 */
import { MARKETS, getMarket } from '../config'

const isMarket = (v: object): v is { id: string } =>
  'id' in v && 'pool' in v && 'chain' in v && typeof v.id === 'string' && MARKETS.some((m) => m.id === (v as { id: string }).id)

export function encodeSnapshot(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (typeof v === 'bigint') return { $n: v.toString() }
    if (v instanceof Map) return { $map: [...v.entries()] }
    if (v && typeof v === 'object' && !Array.isArray(v) && isMarket(v)) return { $market: v.id }
    return v
  })
}

export function decodeSnapshot<T = unknown>(text: string): T {
  return JSON.parse(text, (_, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length !== 1) return v
    if (typeof o.$n === 'string') return BigInt(o.$n)
    if (Array.isArray(o.$map)) return new Map(o.$map as [unknown, unknown][])
    if (typeof o.$market === 'string') return getMarket(o.$market)
    return v
  }) as T
}
