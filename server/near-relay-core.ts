/**
 * NEAR relayer shared by the Bun server (server/relayer.ts) and the Cloudflare Worker (worker/index.ts).
 *
 * It submits private transfers and withdrawals to the pool so the user's own NEAR account never
 * appears on-chain, and earns the fee the proof binds to it. It cannot change the recipient,
 * amount or fee: they are hashed into the proof (extDataHash). New recipients are registered with
 * USDC first, so withdrawals to fresh accounts land directly.
 */
import { Account, KeyPair, KeyPairSigner, teraToGas, type KeyPairString } from 'near-api-js'
import {
  createProvider,
  isValidAccountId,
  nearErrorCode,
  view,
  type Provider,
  type TransactRequest,
} from '../src/lib/near-rpc'

export const DEFAULT_MIN_FEE = 20_000n // 0.02 USDC: covers ~66 Tgas, note storage and a possible USDC registration
const USDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n // 0.00125 NEAR
const MAX_BODY = 12_000

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Simple per-client rate limit: `limit` requests per minute. */
export function createRateLimiter(limit = 20) {
  const hits = new Map<string, number[]>()
  return (ip: string): boolean => {
    const now = Date.now()
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
    recent.push(now)
    hits.set(ip, recent)
    return recent.length > limit
  }
}

/** Runs tasks one at a time, so access-key nonces never collide. */
function createQueue() {
  let queue: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }
}

export interface NearRelayerOptions {
  accountId: string
  privateKey: string
  poolId: string
  usdcId: string
  rpcUrls: string[]
  minFee?: bigint
}

const isDecimal = (v: unknown, signed = false): v is string =>
  typeof v === 'string' && (signed ? /^-?\d{1,40}$/ : /^\d{1,80}$/).test(v)
const isB64 = (v: unknown): v is string => typeof v === 'string' && v.length <= 1_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(v)

/** Checks the request shape and the relayer's terms. The contract re-checks everything. */
function parseRequest(body: unknown, relayerId: string, minFee: bigint): TransactRequest {
  const b = body as Partial<TransactRequest>
  const p = b?.proof_args
  const e = b?.ext_data
  if (!p || !e) throw new Error('Missing proof_args or ext_data')
  const pts = [...(p.proof?.a ?? []), ...(p.proof?.b?.flat() ?? []), ...(p.proof?.c ?? [])]
  if (pts.length !== 8 || !pts.every((x) => isDecimal(x))) throw new Error('Malformed proof')
  if (!isDecimal(p.root)) throw new Error('Malformed root')
  if (p.input_nullifiers?.length !== 2 || !p.input_nullifiers.every((x) => isDecimal(x))) throw new Error('Malformed nullifiers')
  if (p.output_commitments?.length !== 2 || !p.output_commitments.every((x) => isDecimal(x))) throw new Error('Malformed commitments')
  if (!isDecimal(e.ext_amount, true) || !isDecimal(e.fee)) throw new Error('Malformed amounts')
  if (BigInt(e.ext_amount) > 0n) throw new Error('Deposits are sent by the user with ft_transfer_call, not the relayer')
  if (e.relayer !== relayerId) throw new Error(`The proof must name this relayer (${relayerId})`)
  if (BigInt(e.fee) < minFee) throw new Error(`Fee is below the relayer minimum of ${minFee} base units`)
  if (BigInt(e.ext_amount) < 0n) {
    if (typeof e.recipient !== 'string' || !isValidAccountId(e.recipient)) throw new Error('Invalid recipient account')
  } else if (e.recipient !== null) {
    throw new Error('A private transfer has no recipient account')
  }
  if (e.encrypted_outputs?.length !== 2 || !e.encrypted_outputs.every((o) => isB64(o.ephemeral_pub) && isB64(o.ciphertext))) {
    throw new Error('Malformed encrypted outputs')
  }
  return { proof_args: p, ext_data: e }
}

export function createNearRelayer(opts: NearRelayerOptions) {
  const minFee = opts.minFee ?? DEFAULT_MIN_FEE
  const provider: Provider = createProvider(opts.rpcUrls)
  const signer = new KeyPairSigner(KeyPair.fromString(opts.privateKey as KeyPairString))
  const account = new Account(opts.accountId, provider, signer)
  const enqueue = createQueue()

  async function ensureUsdcRegistration(accountId: string) {
    const bal = await view<unknown>(provider, opts.usdcId, 'storage_balance_of', { account_id: accountId })
    if (bal) return
    await account.callFunction({
      contractId: opts.usdcId,
      methodName: 'storage_deposit',
      args: { account_id: accountId, registration_only: true },
      deposit: USDC_STORAGE_DEPOSIT,
      gas: teraToGas('30'),
    })
  }

  /** Validates, pre-checks against pool state, then submits `transact`. Returns the tx hash. */
  async function relay(body: unknown): Promise<string> {
    const req = parseRequest(body, opts.accountId, minFee)
    const { proof_args: p, ext_data: e } = req

    // Cheap view checks first, so stale or replayed proofs cost no gas.
    const [known, spent0, spent1] = await Promise.all([
      view<boolean>(provider, opts.poolId, 'is_known_root', { root: p.root }),
      view<boolean>(provider, opts.poolId, 'is_spent', { nullifier: p.input_nullifiers[0] }),
      view<boolean>(provider, opts.poolId, 'is_spent', { nullifier: p.input_nullifiers[1] }),
    ])
    if (!known) throw new Error('ERR_UNKNOWN_ROOT')
    if (spent0 || spent1) throw new Error('ERR_NULLIFIER_SPENT')

    return enqueue(async () => {
      if (e.recipient) await ensureUsdcRegistration(e.recipient)
      const res = await account.callFunctionRaw({
        contractId: opts.poolId,
        methodName: 'transact',
        args: req,
        gas: teraToGas('300'),
        deposit: 0n,
      })
      const status = res.status as { Failure?: unknown } | string
      if (typeof status === 'object' && status && 'Failure' in status) throw new Error(nearErrorCode(status.Failure))
      return res.transaction.hash
    })
  }

  const info = () => ({
    relayer: opts.accountId,
    minFee: minFee.toString(),
    pool: opts.poolId,
    usdc: opts.usdcId,
  })

  return { relay, info, accountId: opts.accountId }
}

export type NearRelayer = ReturnType<typeof createNearRelayer>

const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu'

/**
 * POST /nras: forwards NEAR AI GPU attestation evidence to NVIDIA's verifier (which has no CORS)
 * and returns its overall verdict. It only ever sees attestation evidence, never user data.
 */
export async function handleNras(req: Request): Promise<Response> {
  const text = await req.text()
  if (text.length > 400_000) return json({ error: 'Request too large' }, 413)
  try {
    const payload = JSON.parse(text) as { nonce?: unknown; evidence_list?: unknown }
    if (typeof payload.nonce !== 'string' || !Array.isArray(payload.evidence_list)) throw new Error('Malformed GPU evidence')
    const res = await fetch(NRAS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })
    if (!res.ok) return json({ error: `NVIDIA verifier error (${res.status})` }, 502)
    const body = (await res.json()) as [string, string][]
    const jwt = body?.[0]?.[1]
    const claims = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>
    return json({ verdict: String(claims['x-nvidia-overall-att-result']) })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'NVIDIA verification failed' }, 400)
  }
}

/** POST /transact: size limit, relay, JSON answer. */
export async function handleTransact(relayer: NearRelayer, req: Request): Promise<Response> {
  const text = await req.text()
  if (text.length > MAX_BODY) return json({ error: 'Request too large' }, 413)
  try {
    return json({ txHash: await relayer.relay(JSON.parse(text)) })
  } catch (err) {
    return json({ error: nearErrorCode(err) }, 400)
  }
}
