/**
 * Cloudflare Worker that lets the Auto-loop site reach Tycho's hosted Fynd API: the API sends no CORS header and its
 * key must stay server-side. The key lives in the Worker secret FYND_API_KEY, never in the site.
 *
 * Only POST /v1/{chain}/quote is forwarded (any chain: the API refuses the ones it does not serve), only from the
 * origins below; everything else answers 404.
 * Deploy: `npx wrangler deploy proxy/tycho-worker.js --name auto-loop-tycho --compatibility-date 2026-11-01`, then
 * `npx wrangler secret put FYND_API_KEY --name auto-loop-tycho`. The Worker's URL goes in the GitHub variable
 * TYCHO_API_URL (Pages workflow).
 */
const UPSTREAM = 'https://fynd-api.propellerheads.xyz'
const ORIGINS = ['https://soulergonote.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173']

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? ''
    const cors = ORIGINS.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
      : {}
    const match = new URL(request.url).pathname.match(/^\/v1\/([a-z]+)\/quote$/)
    if (!match || !ORIGINS.includes(origin)) return new Response('not found', { status: 404, headers: cors })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } })
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors })
    const body = await request.text()
    if (body.length > 4096) return new Response('too large', { status: 413, headers: cors })
    const res = await fetch(`${UPSTREAM}/v1/${match[1]}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: env.FYND_API_KEY },
      body,
    })
    return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' } })
  },
}
