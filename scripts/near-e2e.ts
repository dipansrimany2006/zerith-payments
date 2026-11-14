/**
 * End-to-end test of Zerith on NEAR testnet, using the real pool, the real relayer and real proofs.
 *
 *   1. shield   TESTER deposits 0.50 USDC into a note for Alice     (ft_transfer_call, signed by TESTER)
 *   2. send     Alice pays Bob 0.20 privately                       (via relayer, fee = relayer minFee)
 *   3. withdraw Bob withdraws 0.15 to TESTER's account               (via relayer)
 *
 * Prerequisites:
 *   - the relayer running locally:            bun run server/relayer.ts   (port 3001)
 *   - a testnet account with >= 0.5 USDC, key in ~/.near-credentials/testnet/<id>.json
 *     (USDC from https://faucet.circle.com, network "NEAR Testnet")
 *
 * Run: NEAR_TESTER_ACCOUNT=<id>.testnet node scripts/near-e2e.ts
 * (node, not bun: snarkjs worker threads crash under bun)
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Account, KeyPair, KeyPairSigner, teraToGas, type KeyPairString } from 'near-api-js'
import { NETWORKS, createProvider, fetchNotes, view } from '../src/lib/near-rpc.ts'
import { MerkleTree, Utxo, keypairFromSeed, prepareTransaction, prove, tryDecryptUtxo, type Keypair, type PrepareParams } from '../src/lib/zerith.ts'

const NET = NETWORKS.testnet
const RELAYER = process.env.RELAYER_URL || 'http://localhost:3001'
const TESTER = process.env.NEAR_TESTER_ACCOUNT
if (!TESTER) throw new Error('Set NEAR_TESTER_ACCOUNT')

const provider = createProvider(NET.rpcUrls)
const cred = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${TESTER}.json`, 'utf8'))
const tester = new Account(TESTER, provider, new KeyPairSigner(KeyPair.fromString(cred.private_key as KeyPairString)))
const wasm = readFileSync('public/zk/transaction.wasm')
const zkey = readFileSync('public/zk/transaction.zkey')

const run = Date.now().toString()
const alice = keypairFromSeed(new TextEncoder().encode(`e2e-alice-${run}`))
const bob = keypairFromSeed(new TextEncoder().encode(`e2e-bob-${run}`))

const usdc = (v: bigint) => (Number(v) / 1e6).toFixed(2)
const log = (msg: string) => console.log(`[${((Date.now() - Number(run)) / 1000).toFixed(1)}s] ${msg}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function tree() {
  const notes = await fetchNotes(provider, NET.poolId)
  const t = new MerkleTree()
  for (const n of notes) t.insert(BigInt(n.commitment))
  return { t, notes }
}

async function waitForCount(count: number) {
  for (let i = 0; i < 40; i++) {
    if ((await view<number>(provider, NET.poolId, 'notes_count')) >= count) return
    await sleep(1000)
  }
  throw new Error('timed out waiting for the pool')
}

/** Finds `keys`' unspent notes by trial decryption. */
async function myNotes(keys: Keypair) {
  const { notes } = await tree()
  const mine: Utxo[] = []
  for (const n of notes) {
    const found = tryDecryptUtxo(keys, n, BigInt(n.commitment), n.leaf_index)
    if (!found || found.utxo.amount === 0n) continue
    const spent = await view<boolean>(provider, NET.poolId, 'is_spent', { nullifier: found.utxo.nullifier().toString() })
    if (!spent) mine.push(found.utxo)
  }
  return mine
}

async function relayTx(params: Omit<PrepareParams, 'tree'>) {
  const { t, notes } = await tree()
  const prepared = prepareTransaction({ ...params, tree: t })
  const t0 = Date.now()
  const proof_args = await prove(prepared.circuitInput, wasm, zkey)
  log(`  proof generated in ${Date.now() - t0} ms`)
  const res = await fetch(`${RELAYER}/api/transact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proof_args, ext_data: prepared.extData }),
  })
  const body = (await res.json()) as { txHash?: string; error?: string }
  if (!body.txHash) throw new Error(`relayer: ${body.error}`)
  await waitForCount(notes.length + 2)
  return body.txHash
}

const info = (await (await fetch(`${RELAYER}/api/info`)).json()) as { relayer: string; minFee: string }
const fee = BigInt(info.minFee)
log(`pool ${NET.poolId}, relayer ${info.relayer}, fee ${usdc(fee)} USDC`)

const testerStart = BigInt(await view<string>(provider, NET.usdcId, 'ft_balance_of', { account_id: TESTER }))
log(`tester ${TESTER} has ${usdc(testerStart)} USDC`)
if (testerStart < 500_000n) throw new Error('Tester needs at least 0.50 testnet USDC (https://faucet.circle.com)')

// 1. shield: tester deposits 0.50 into a note for Alice.
{
  const { t, notes } = await tree()
  const amount = 500_000n
  const prepared = prepareTransaction({
    tree: t,
    inputs: [],
    outputs: [{ utxo: new Utxo(amount, alice.ownerPub), to: alice, memo: 'e2e deposit' }],
    extAmount: amount,
  })
  const proof_args = await prove(prepared.circuitInput, wasm, zkey)
  const res = await tester.callFunctionRaw({
    contractId: NET.usdcId,
    methodName: 'ft_transfer_call',
    args: { receiver_id: NET.poolId, amount: amount.toString(), msg: JSON.stringify({ proof_args, ext_data: prepared.extData }) },
    deposit: 1n,
    gas: teraToGas('300'),
  })
  await waitForCount(notes.length + 2)
  log(`1. shielded 0.50 for Alice: ${NET.explorer}/txns/${res.transaction.hash}`)
}

// 2. Alice pays Bob 0.20 privately.
{
  const [note] = await myNotes(alice)
  if (!note) throw new Error('Alice cannot find her note')
  log(`   Alice found her note: ${usdc(note.amount)} USDC (leaf ${note.index})`)
  const tx = await relayTx({
    inputs: [note],
    outputs: [
      { utxo: new Utxo(200_000n, bob.ownerPub), to: bob, memo: 'e2e invoice' },
      { utxo: Utxo.owned(note.amount - 200_000n - fee, alice), to: alice },
    ],
    extAmount: 0n,
    fee,
    relayer: info.relayer,
  })
  log(`2. Alice -> Bob 0.20 privately: ${NET.explorer}/txns/${tx}`)
}

// 3. Bob withdraws 0.15 to the tester's account.
{
  const [note] = await myNotes(bob)
  if (!note) throw new Error('Bob cannot find his note')
  log(`   Bob found his note: ${usdc(note.amount)} USDC`)
  const before = BigInt(await view<string>(provider, NET.usdcId, 'ft_balance_of', { account_id: TESTER }))
  const tx = await relayTx({
    inputs: [note],
    outputs: [{ utxo: Utxo.owned(note.amount - 150_000n - fee, bob), to: bob }],
    extAmount: -150_000n,
    fee,
    relayer: info.relayer,
    recipient: TESTER,
  })
  await sleep(3000)
  const after = BigInt(await view<string>(provider, NET.usdcId, 'ft_balance_of', { account_id: TESTER }))
  log(`3. Bob withdrew 0.15 to ${TESTER}: ${NET.explorer}/txns/${tx}`)
  if (after - before !== 150_000n) throw new Error(`expected +0.15 USDC, got ${usdc(after - before)}`)
}

const aliceLeft = (await myNotes(alice)).reduce((s, u) => s + u.amount, 0n)
const bobLeft = (await myNotes(bob)).reduce((s, u) => s + u.amount, 0n)
log(`done. Alice private: ${usdc(aliceLeft)}, Bob private: ${usdc(bobLeft)} (expected ${usdc(300_000n - fee)} and ${usdc(50_000n - fee)})`)
if (aliceLeft !== 300_000n - fee || bobLeft !== 50_000n - fee) throw new Error('unexpected private balances')
log('E2E PASSED')
process.exit(0)
