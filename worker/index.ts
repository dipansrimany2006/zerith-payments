/**
 * Cloudflare Worker: serves the built app (dist/, via the ASSETS binding) and runs the NEAR
 * relayer at /api/*.
 *
 * Every relay request goes through one Durable Object instance. Worker isolates do not share
 * memory, so this is what keeps transactions in order (no access-key nonce collisions) and the
 * rate limit global.
 */
import { DurableObject } from 'cloudflare:workers'
import { NETWORKS, type NearNetwork } from '../src/lib/near-rpc'
import { createNearRelayer, createRateLimiter, handleNras, handleTransact, json } from '../server/near-relay-core'

interface Env {
  ASSETS: Fetcher
  RELAYER: DurableObjectNamespace<Relayer>
  NEAR_NETWORK?: string
  NEAR_RELAYER_ACCOUNT: string
  /** Secret: `bunx wrangler secret put NEAR_RELAYER_KEY` (ed25519:...). */
  NEAR_RELAYER_KEY: string
  /** Optional secret: a private RPC tried before the public ones. */
  NEAR_RPC_URL?: string
  RELAYER_MIN_FEE?: string
}

const netOf = (env: Env) => NETWORKS[(env.NEAR_NETWORK || 'testnet') as NearNetwork]

export class Relayer extends DurableObject<Env> {
  private relayer = createNearRelayer({
    accountId: this.env.NEAR_RELAYER_ACCOUNT,
    privateKey: this.env.NEAR_RELAYER_KEY,
    poolId: netOf(this.env).poolId,
    usdcId: netOf(this.env).usdcId,
    rpcUrls: this.env.NEAR_RPC_URL ? [this.env.NEAR_RPC_URL, ...netOf(this.env).rpcUrls] : netOf(this.env).rpcUrls,
    minFee: this.env.RELAYER_MIN_FEE ? BigInt(this.env.RELAYER_MIN_FEE) : undefined,
  })
  private limited = createRateLimiter()

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url)
    if (req.method === 'GET' && pathname === '/api/info') return json(this.relayer.info())
    if (req.method === 'POST' && pathname === '/api/transact') {
      const ip = req.headers.get('cf-connecting-ip') || 'unknown'
      if (this.limited(ip)) return json({ error: 'Too many requests. Try again in a minute.' }, 429)
      return handleTransact(this.relayer, req)
    }
    return json({ error: 'Not found' }, 404)
  }
}

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url)
    // Stateless: NVIDIA GPU attestation check for the private AI assistant.
    if (pathname === '/api/nras' && req.method === 'POST') return handleNras(req)
    if (pathname.startsWith('/api/')) {
      if (!env.NEAR_RELAYER_ACCOUNT || !env.NEAR_RELAYER_KEY) return json({ error: 'Relayer is not configured' }, 503)
      return env.RELAYER.get(env.RELAYER.idFromName('relayer')).fetch(req)
    }
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>
