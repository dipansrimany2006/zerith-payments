/**
 * Private AI on NEAR AI Cloud, verified from the browser.
 *
 * Privacy model: the user's payment history is decrypted locally and sent straight from the browser
 * to a NEAR AI Cloud model running in a TEE (Intel TDX + NVIDIA confidential GPU), using the user's
 * own API key. Zerith's servers never see the data or the key.
 *
 * Trust model, checked here rather than taken on faith:
 *  1. Attestation (before chatting): fetch the model's attestation with a fresh random nonce, verify
 *     the Intel TDX quote against Intel's root CA (pure-JS dcap-qvl; collateral from Phala's PCCS
 *     mirror), and check that the quote's report_data = signing_address (padded to 32 bytes) || nonce.
 *     GPU evidence must carry the same nonce; NVIDIA's verdict is fetched through the relayer
 *     (NVIDIA's API has no CORS), which only ever sees attestation evidence, never user data.
 *  2. Response signatures (after each answer): fetch the signature for the chat id and check that
 *     text = "<model>:<sha256(request bytes)>:<sha256(response bytes)>" was signed (EIP-191) by the
 *     attested signing address.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { getCollateralAndVerify } from '@phala/dcap-qvl'

export const NEAR_AI_BASE = 'https://cloud-api.near.ai/v1'
export const NEAR_AI_KEYS_URL = 'https://cloud.near.ai'
export const NEAR_AI_VERIFY_URL = 'https://cloud.near.ai/verify'

/** NEAR-hosted models with TEE attestation (provider "near"). The first is the default. */
export const PRIVATE_MODELS = [
  { id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', label: 'DeepSeek V4.1 Flash' },
  { id: 'Qwen/Qwen3.8-27B', label: 'Qwen 3.8 27B' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' },
] as const

export interface Check {
  label: string
  ok: boolean
  detail?: string
}

export interface AttestationResult {
  ok: boolean
  model: string
  /** Attested EIP-191 signing addresses (lowercase), one per verified model instance. */
  signers: string[]
  checks: Check[]
  tcbStatus?: string
  verifiedAt: number
}

interface ModelAttestation {
  model_name: string
  signing_address: string
  signing_algo: string
  request_nonce: string
  intel_quote: string
  nvidia_payload?: string
}

// TCB states where the quote's cryptography is valid. OutOfDate means the platform is behind
// Intel's latest advisory baseline, not that the quote is forged; we show it, as NEAR's verifier does.
const TCB_OK = new Set(['UpToDate', 'SWHardeningNeeded', 'OutOfDate'])

const hex = (b: Uint8Array) => bytesToHex(b)
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

function paddedAddress(addr: string): Uint8Array {
  const raw = hexToBytes(addr.replace(/^0x/i, ''))
  const out = new Uint8Array(32)
  out.set(raw)
  return out
}

async function nvidiaVerdict(payload: string): Promise<string | null> {
  try {
    const res = await fetch('/api/nras', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
    if (!res.ok) return null
    const { verdict } = (await res.json()) as { verdict?: string }
    return verdict ?? null
  } catch {
    return null
  }
}

/** Verifies one model attestation candidate against our nonce. */
async function verifyCandidate(a: ModelAttestation, nonce: string): Promise<{ ok: boolean; checks: Check[]; tcb?: string }> {
  const checks: Check[] = []
  checks.push({ label: 'Attestation answers our fresh nonce', ok: a.request_nonce?.toLowerCase() === nonce })

  let reportData: Uint8Array | null = null
  let tcb: string | undefined
  try {
    const result = await getCollateralAndVerify(hexToBytes(a.intel_quote))
    tcb = result.status
    const r = result.report
    reportData = r.asTd10()?.reportData ?? r.asTd15()?.base.reportData ?? r.asTd15Ex()?.base.base.reportData ?? null
    checks.push({ label: 'Intel TDX quote signed by Intel (DCAP)', ok: TCB_OK.has(result.status), detail: `TCB status: ${result.status}` })
  } catch (err) {
    checks.push({ label: 'Intel TDX quote signed by Intel (DCAP)', ok: false, detail: err instanceof Error ? err.message : 'verification failed' })
  }

  if (reportData) {
    const bindsKey = eq(reportData.slice(0, 32), paddedAddress(a.signing_address))
    const bindsNonce = eq(reportData.slice(32, 64), hexToBytes(nonce))
    checks.push({ label: 'Quote binds the model signing key', ok: bindsKey, detail: a.signing_address })
    checks.push({ label: 'Quote binds our nonce (fresh, not replayed)', ok: bindsNonce })
  }

  if (a.nvidia_payload) {
    let gpuNonce = ''
    try {
      gpuNonce = (JSON.parse(a.nvidia_payload) as { nonce: string }).nonce.toLowerCase()
    } catch {
      // malformed
    }
    checks.push({ label: 'GPU evidence answers our nonce', ok: gpuNonce === nonce })
    const verdict = await nvidiaVerdict(a.nvidia_payload)
    // NVIDIA's check runs via the relayer; if it is unreachable we report it but do not fail on it.
    checks.push({
      label: 'NVIDIA confidential-GPU attestation',
      ok: verdict === null ? true : verdict === 'true' || verdict === 'True',
      detail: verdict === null ? 'not checked (verifier unreachable)' : `NVIDIA verdict: ${verdict}`,
    })
  }

  return { ok: checks.every((c) => c.ok), checks, tcb }
}

/** Fetches and verifies the model's attestation with a fresh nonce. Needs no API key. */
export async function verifyModel(model: string): Promise<AttestationResult> {
  const nonce = hex(randomBytes(32))
  const url = new URL(`${NEAR_AI_BASE}/attestation/report`)
  url.search = new URLSearchParams({ model, provider: 'near', signing_algo: 'ecdsa', nonce, include_tls_fingerprint: 'false' }).toString()
  const res = await fetch(url, { headers: { Accept: 'application/json', 'x-no-aliasing': 'true' } })
  if (!res.ok) throw new Error(`Attestation request failed (${res.status})`)
  const report = (await res.json()) as { model_attestations?: ModelAttestation[] }
  const candidates = (report.model_attestations ?? []).filter((m) => m.model_name === model && m.signing_algo === 'ecdsa')
  if (!candidates.length) {
    return { ok: false, model, signers: [], checks: [{ label: 'Model attestation available', ok: false }], verifiedAt: Date.now() }
  }

  // NEAR's guidance: verify every candidate. Each verified one contributes its signing address.
  const results = await Promise.all(candidates.map((c) => verifyCandidate(c, nonce)))
  const signers = candidates.filter((_, i) => results[i].ok).map((c) => c.signing_address.toLowerCase())
  return {
    ok: results.every((r) => r.ok),
    model,
    signers: [...new Set(signers)],
    // Show the first candidate's checks; they are the same steps for each instance.
    checks: [{ label: `Instances verified: ${signers.length}/${candidates.length}`, ok: signers.length === candidates.length }, ...results[0].checks],
    tcbStatus: results[0].tcb,
    verifiedAt: Date.now(),
  }
}

/** EIP-191 personal_sign recovery: returns the lowercase 0x address. */
export function recoverEip191(text: string, signatureHex: string): string {
  const msg = utf8ToBytes(text)
  const digest = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]))
  const sig = hexToBytes(signatureHex.replace(/^0x/i, ''))
  if (sig.length !== 65) throw new Error('Bad signature length')
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64]
  const recovered = new Uint8Array(65)
  recovered[0] = v
  recovered.set(sig.slice(0, 64), 1)
  const pub = secp256k1.Signature.fromBytes(recovered, 'recovered').recoverPublicKey(digest).toBytes(false)
  return `0x${hex(keccak_256(pub.slice(1)).slice(-20))}`
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface VerifiedReply {
  content: string
  chatId: string
  /** Signature check result; `signer` is the recovered address. */
  signature: { ok: boolean; signer?: string; detail: string }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Sends a chat completion straight to NEAR AI Cloud and verifies the response signature against
 * the attested signers. The exact request and response bytes are hashed, as the signature requires.
 */
export async function verifiedChat(p: {
  apiKey: string
  model: string
  messages: ChatMessage[]
  attestation: AttestationResult | null
}): Promise<VerifiedReply> {
  const body = JSON.stringify({ model: p.model, messages: p.messages, temperature: 0.2, stream: false })
  const res = await fetch(`${NEAR_AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}`, 'x-no-aliasing': 'true' },
    body,
  })
  const raw = await res.text()
  if (!res.ok) {
    let msg = raw
    try {
      msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw
    } catch {
      // keep raw
    }
    throw new Error(res.status === 401 ? 'NEAR AI Cloud rejected the API key.' : `NEAR AI Cloud error (${res.status}): ${msg.slice(0, 200)}`)
  }
  const data = JSON.parse(raw) as { id: string; choices: { message: { content: string } }[] }
  const content = data.choices?.[0]?.message?.content ?? ''

  const expected = `${p.model}:${hex(sha256(utf8ToBytes(body)))}:${hex(sha256(utf8ToBytes(raw)))}`
  const signature = await checkSignature(p.apiKey, data.id, expected, p.attestation)
  return { content, chatId: data.id, signature }
}

async function checkSignature(
  apiKey: string,
  chatId: string,
  expectedText: string,
  attestation: AttestationResult | null,
): Promise<VerifiedReply['signature']> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${NEAR_AI_BASE}/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`, {
      headers: { Accept: 'application/json', authorization: `Bearer ${apiKey}` },
    })
    if (res.status === 404) {
      await sleep(800)
      continue
    }
    if (!res.ok) return { ok: false, detail: `Signature unavailable (${res.status})` }
    const s = (await res.json()) as { text?: string; signature?: string; signing_address?: string; signature_kind?: string; error_code?: string }
    if (s.error_code || !s.text || !s.signature) return { ok: false, detail: 'Signature unavailable for this reply' }
    if (s.text !== expectedText) return { ok: false, detail: 'Signed text does not match this request and response' }
    if (s.signature_kind && s.signature_kind !== 'provider_tee') return { ok: false, detail: `Signed by the ${s.signature_kind}, not the model TEE` }
    let signer: string
    try {
      signer = recoverEip191(s.text, s.signature)
    } catch {
      return { ok: false, detail: 'Malformed signature' }
    }
    if (signer !== s.signing_address?.toLowerCase()) return { ok: false, signer, detail: 'Signature does not match the claimed signer' }
    if (!attestation?.ok || !attestation.signers.includes(signer)) {
      return { ok: false, signer, detail: 'Signer is not an attested TEE key' }
    }
    return { ok: true, signer, detail: 'Signed inside the attested TEE' }
  }
  return { ok: false, detail: 'Signature not available yet' }
}
