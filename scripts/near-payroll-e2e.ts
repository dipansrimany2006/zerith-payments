/**
 * Payroll check on NEAR testnet: pays 4 shielded recipients from a wallet in 2 deposit transactions
 * (2 recipients each), with every proof made against the SAME root up front, exactly like the app's
 * one-approval wallet payroll. Then each recipient finds their note by trial decryption.
 *
 * Run: NEAR_TESTER_ACCOUNT=<id>.testnet node scripts/near-payroll-e2e.ts
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Account, KeyPair, KeyPairSigner, teraToGas, type KeyPairString } from 'near-api-js'
import { NETWORKS, createProvider, fetchNotes, view } from '../src/lib/near-rpc.ts'
import { MerkleTree, Utxo, keypairFromSeed, prepareTransaction, prove, tryDecryptUtxo } from '../src/lib/zerith.ts'

const NET = NETWORKS.testnet
const TESTER = process.env.NEAR_TESTER_ACCOUNT
if (!TESTER) throw new Error('Set NEAR_TESTER_ACCOUNT')
const provider = createProvider(NET.rpcUrls)
const cred = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${TESTER}.json`, 'utf8'))
const tester = new Account(TESTER, provider, new KeyPairSigner(KeyPair.fromString(cred.private_key as KeyPairString)))
const wasm = readFileSync('public/zk/transaction.wasm')
const zkey = readFileSync('public/zk/transaction.zkey')

const run = Date.now()
const staff = ['ana', 'ben', 'chen', 'dara'].map((n, i) => ({
  name: n,
  keys: keypairFromSeed(new TextEncoder().encode(`payroll-${n}-${run}`)),
  amount: BigInt(100_000 * (i + 1)), // 0.10, 0.20, 0.30, 0.40
}))

const notes0 = await fetchNotes(provider, NET.poolId)
const tree = new MerkleTree()
for (const n of notes0) tree.insert(BigInt(n.commitment))
console.log(`pool has ${notes0.length} notes; proving 2 deposits against root ${String(tree.root()).slice(0, 12)}…`)

// Prove everything first, against one root (as the browser does before one wallet approval).
const txs = []
for (let i = 0; i < staff.length; i += 2) {
  const pair = staff.slice(i, i + 2)
  const total = pair.reduce((s, p) => s + p.amount, 0n)
  const prepared = prepareTransaction({
    tree,
    inputs: [],
    outputs: pair.map((p) => ({ utxo: new Utxo(p.amount, p.keys.ownerPub), to: p.keys, memo: `October salary - ${p.name}` })),
    extAmount: total,
  })
  txs.push({ total, proof_args: await prove(prepared.circuitInput, wasm, zkey), ext_data: prepared.extData })
}

for (const [i, t] of txs.entries()) {
  const res = await tester.callFunctionRaw({
    contractId: NET.usdcId,
    methodName: 'ft_transfer_call',
    args: { receiver_id: NET.poolId, amount: t.total.toString(), msg: JSON.stringify({ proof_args: t.proof_args, ext_data: t.ext_data }) },
    deposit: 1n,
    gas: teraToGas('300'),
  })
  const failed = res.receipts_outcome.find((r) => typeof r.outcome.status === 'object' && 'Failure' in r.outcome.status)
  if (failed) throw new Error(`deposit ${i + 1} failed: ${JSON.stringify(failed.outcome.status)}`)
  console.log(`deposit ${i + 1} (2 people, ${Number(t.total) / 1e6} USDC): ${NET.explorer}/txns/${res.transaction.hash}`)
}

for (let i = 0; i < 40 && (await view<number>(provider, NET.poolId, 'notes_count')) < notes0.length + 4; i++) await new Promise((r) => setTimeout(r, 1000))
const after = await fetchNotes(provider, NET.poolId, notes0.length)
for (const p of staff) {
  const found = after.map((n) => tryDecryptUtxo(p.keys, n, BigInt(n.commitment), n.leaf_index)).find((x) => x && x.utxo.amount > 0n)
  if (!found || found.utxo.amount !== p.amount) throw new Error(`${p.name} did not get ${p.amount}`)
  console.log(`  ${p.name} found ${Number(found.utxo.amount) / 1e6} USDC, memo "${found.memo}"`)
}
console.log('PAYROLL E2E PASSED')
process.exit(0)
