/**
 * Cloudflare Worker that lets the Auto-loop site reach Tycho's hosted Fynd API: the API sends no CORS header and its
 * key must stay server-side. The key lives in the Worker secret FYND_API_KEY, never in the site.
 *
 * Written to need no change: any chain is forwarded (the API refuses the ones it does not serve, and the app decides
 * which chains it asks for), only POST /v1/{chain}/quote, only from the origins below; everything else answers 404.
 * Deploy: paste this file in the Cloudflare editor (or `npx wrangler deploy proxy/tycho-worker.js --name auto-loop-tycho
 * --compatibility-date 2026-11-01`), add the secret FYND_API_KEY, put the Worker's URL in the GitHub repository
 * variable TYCHO_API_URL (Pages workflow).
 */
const UPSTREAM = 'https://fynd-api.propellerheads.xyz'
const ORIGINS = ['https://soulergonote.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173']
const MAX_BODY = 8192

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? ''
    if (!ORIGINS.includes(origin)) return new Response('not found', { status: 404 })
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    }
    const answer = (status, text) => new Response(text, { status, headers: cors })
    const match = new URL(request.url).pathname.match(/^\/v1\/([a-z0-9-]{1,32})\/quote\/?$/)
    if (!match) return answer(404, 'not found')
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } })
    if (request.method !== 'POST') return answer(405, 'method not allowed')
    if (!env.FYND_API_KEY) return answer(500, 'FYND_API_KEY missing in the Worker')
    const body = await request.text()
    if (body.length > MAX_BODY) return answer(413, 'too large')
    try {
      const res = await fetch(`${UPSTREAM}/v1/${match[1]}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: env.FYND_API_KEY },
        body,
      })
      const headers = { ...cors, 'Content-Type': res.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' }
      const retry = res.headers.get('Retry-After')
      if (retry) headers['Retry-After'] = retry
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return answer(502, 'Fynd API unreachable')
    }
  },
}
