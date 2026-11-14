/**
 * Zerith NEAR relayer as a Bun server, for local development. The deployed version is the
 * Cloudflare Worker in worker/index.ts; both share server/near-relay-core.ts.
 *
 * Run with: bun run server/relayer.ts   (listens on RELAYER_PORT, default 3001)
 * Needs NEAR_RELAYER_ACCOUNT and NEAR_RELAYER_KEY (ed25519:...) in .env.
 * After `bun run build` it also serves the built app from dist/.
 */
import { join, resolve, sep } from 'node:path'
import { NETWORKS, type NearNetwork } from '../src/lib/near-rpc'
import { createNearRelayer, createRateLimiter, handleNras, handleTransact, json } from './near-relay-core'

const PORT = Number(process.env.PORT || process.env.RELAYER_PORT || 3001)
const NETWORK = (process.env.VITE_NEAR_NETWORK || 'testnet') as NearNetwork
const net = NETWORKS[NETWORK]
const ACCOUNT = process.env.NEAR_RELAYER_ACCOUNT
const KEY = process.env.NEAR_RELAYER_KEY

if (!ACCOUNT || !KEY || !net?.poolId) {
  console.error('Missing NEAR_RELAYER_ACCOUNT / NEAR_RELAYER_KEY in .env, or no pool for this network')
  process.exit(1)
}

const relayer = createNearRelayer({
  accountId: ACCOUNT,
  privateKey: KEY,
  poolId: process.env.VITE_POOL_ID || net.poolId,
  usdcId: net.usdcId,
  rpcUrls: process.env.NEAR_RPC_URL ? [process.env.NEAR_RPC_URL, ...net.rpcUrls] : net.rpcUrls,
  minFee: process.env.RELAYER_MIN_FEE ? BigInt(process.env.RELAYER_MIN_FEE) : undefined,
})
const limited = createRateLimiter()
const DIST = resolve(import.meta.dir, '../dist')

async function staticFile(pathname: string): Promise<Response> {
  const path = resolve(DIST, '.' + decodeURIComponent(pathname))
  if (path.startsWith(DIST + sep)) {
    const file = Bun.file(path)
    if (await file.exists()) {
      const cache = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      return new Response(file, { headers: { 'cache-control': cache } })
    }
  }
  const index = Bun.file(join(DIST, 'index.html'))
  if (await index.exists()) return new Response(index, { headers: { 'cache-control': 'no-cache' } })
  return json({ error: 'Not found' }, 404)
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
    // The app calls /api/*; the Vite dev proxy strips the prefix, so accept both forms.
    const route = url.pathname.replace(/^\/api(?=\/)/, '')

    if (req.method === 'GET' && route === '/info') return json(relayer.info())
    if (req.method === 'POST' && route === '/transact') {
      if (limited(ip)) return json({ error: 'Too many requests. Try again in a minute.' }, 429)
      return handleTransact(relayer, req)
    }
    if (req.method === 'POST' && route === '/nras') {
      if (limited(ip)) return json({ error: 'Too many requests. Try again in a minute.' }, 429)
      return handleNras(req)
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return staticFile(url.pathname)
    return json({ error: 'Not found' }, 404)
  },
})

console.log(`Zerith relayer ${relayer.accountId} on ${NETWORK}, listening on :${PORT}`)
