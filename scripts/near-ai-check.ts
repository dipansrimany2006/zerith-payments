/**
 * Checks the Private CFO path end to end without a browser: attestation (Intel TDX quote, key and
 * nonce binding, GPU nonce), one verified chat completion, and its TEE response signature.
 *
 * Run: bun scripts/near-ai-check.ts   (needs NEAR_AI_API_KEY in .env; the NVIDIA verdict is
 * reported as "not checked" unless the relayer is running on :3001)
 */
import { PRIVATE_MODELS, verifiedChat, verifyModel } from '../src/lib/near-ai'

const key = process.env.NEAR_AI_API_KEY
if (!key) throw new Error('Set NEAR_AI_API_KEY in .env')
const model = process.env.NEAR_AI_MODEL || PRIVATE_MODELS[0].id

// The browser calls /api/nras on its own origin; point it at the local relayer here.
const orig = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  orig(String(input).startsWith('/api/') ? `http://localhost:3001${String(input)}` : input, init)) as typeof fetch

const att = await verifyModel(model)
console.log(`attestation for ${model}: ${att.ok ? 'VERIFIED' : 'NOT VERIFIED'} (TCB ${att.tcbStatus})`)
for (const c of att.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.label}${c.detail ? ` (${c.detail})` : ''}`)
if (!att.ok) process.exit(1)

const ledger = 'Private balance (unspent): 1.08 USDC\n2026-11-14 10:00 | 0.40 | unspent | note | invoice #42\n2026-11-15 09:30 | 0.68 | unspent | note |'
const t0 = Date.now()
const reply = await verifiedChat({
  apiKey: key,
  model,
  attestation: att,
  messages: [
    { role: 'system', content: `Answer only from this ledger.\n${ledger}` },
    { role: 'user', content: 'What is my unspent balance and which payment mentions an invoice? One sentence.' },
  ],
})
console.log(`\nreply in ${Date.now() - t0} ms: ${reply.content.trim()}`)
console.log(`signature: ${reply.signature.ok ? 'VERIFIED' : 'NOT VERIFIED'} - ${reply.signature.detail} ${reply.signature.signer ?? ''}`)
process.exit(reply.signature.ok ? 0 : 1)
