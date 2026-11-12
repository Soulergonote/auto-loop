import type { UseQueryResult } from '@tanstack/react-query'

/**
 * `combine` for useQueries: the results plus their data alone. The combined value is structurally shared by
 * TanStack, so `data` keeps its identity until a query's data really changes (a status flip does not), which
 * lets it stand as a hook dependency where the results array, new at every render, cannot.
 */
export function withData<T>(queries: UseQueryResult<T>[]) {
  return { queries, data: queries.map((q) => q.data) }
}
