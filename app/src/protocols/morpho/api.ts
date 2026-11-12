/** Morpho's public GraphQL API (CORS open). Used for market lists and asset yields; anything signed is re-read on-chain. */
export const MORPHO_API = 'https://blue-api.morpho.org/graphql'

export async function gql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(MORPHO_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  })
  if (!res.ok) throw new Error(`API Morpho : HTTP ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(`API Morpho : ${body.errors[0].message}`)
  if (!body.data) throw new Error('API Morpho : réponse vide')
  return body.data
}
