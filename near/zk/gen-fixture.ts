// Builds the proof fixtures for the NEAR sandbox tests: a full join-split scenario.
//
//   1. deposit         Alice shields 1.50 USDC                    (ext +1_500_000)
//   2. transfer        Alice pays Bob 0.40 privately, 0.02 relayer fee, 1.08 change
//   3. withdraw_bob    Bob withdraws to bob.test.near: 0.39 + 0.01 relayer fee
//   4. withdraw_carol  Alice withdraws 1.00 to carol.test.near (not registered with USDC),
//                      keeps 0.08 change; the pool must hold the payout for Carol to claim
//
// Proofs are generated against the exact tree the contract will have at each step.
//
// Usage: node near/zk/gen-fixture.ts <transaction.wasm> <transaction.zkey> <vk.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs'
import * as snarkjs from 'snarkjs'
import {
  MerkleTree,
  Utxo,
  ZEROS,
  TREE_LEVELS,
  extDataHash,
  keypairFromSeed,
  prepareTransaction,
  prove,
  publicAmount,
  tryDecryptUtxo,
  type ExtData,
  type PrepareParams,
} from '../../src/lib/zerith.ts'

const [wasm, zkey, vkPath, outPath] = process.argv.slice(2)
if (!outPath) throw new Error('usage: gen-fixture.ts <wasm> <zkey> <vk.json> <out.json>')
const vk = JSON.parse(readFileSync(vkPath, 'utf8'))

const RELAYER = 'relayer.test.near'
const alice = keypairFromSeed(new TextEncoder().encode('fixture-alice'))
const bob = keypairFromSeed(new TextEncoder().encode('fixture-bob'))
const tree = new MerkleTree()
const proveTimes: number[] = []

async function step(params: Omit<PrepareParams, 'tree'>) {
  const { circuitInput, extData, outputs } = prepareTransaction({ ...params, tree })
  const t0 = performance.now()
  const proofArgs = await prove(circuitInput, wasm, zkey)
  proveTimes.push(performance.now() - t0)

  const publicSignals = [
    circuitInput.root,
    circuitInput.publicAmount,
    circuitInput.extDataHash,
    ...circuitInput.inputNullifier,
    ...circuitInput.outputCommitment,
  ].map(String)
  const snarkProof = {
    pi_a: [...proofArgs.proof.a, '1'],
    pi_b: [...proofArgs.proof.b, ['1', '0']],
    pi_c: [...proofArgs.proof.c, '1'],
    protocol: 'groth16',
    curve: 'bn128',
  }
  if (!(await snarkjs.groth16.verify(vk, publicSignals, snarkProof))) throw new Error('local verify failed')

  // Insert outputs as the contract will, and record their leaf indices.
  for (const u of outputs) {
    u.index = tree.leaves.length
    tree.insert(u.commitment())
  }
  return { fixture: { proof_args: proofArgs, ext_data: extData, root_after: String(tree.root()) }, outputs, extData }
}

// 1. deposit: Alice shields 1.5 USDC into one note (+ a zero note for padding).
const aliceNote = Utxo.owned(1_500_000n, alice)
const deposit = await step({
  inputs: [],
  outputs: [{ utxo: aliceNote, to: alice, memo: 'savings' }],
  extAmount: 1_500_000n,
})

// 2. private transfer: 0.40 to Bob, 0.02 relayer fee, 1.08 change to Alice. No USDC leaves the pool.
const bobNote = new Utxo(400_000n, bob.ownerPub)
const aliceChange = Utxo.owned(1_080_000n, alice)
const transfer = await step({
  inputs: [aliceNote],
  outputs: [
    { utxo: bobNote, to: bob, memo: 'invoice #42' },
    { utxo: aliceChange, to: alice },
  ],
  extAmount: 0n,
  fee: 20_000n,
  relayer: RELAYER,
})

// Bob finds his note by trial decryption, exactly as a wallet scan would.
const bobFound = tryDecryptUtxo(bob, transfer.extData.encrypted_outputs[0], bobNote.commitment(), bobNote.index!)
if (!bobFound || bobFound.utxo.amount !== 400_000n || bobFound.memo !== 'invoice #42') throw new Error('Bob cannot decrypt')
if (tryDecryptUtxo(alice, transfer.extData.encrypted_outputs[0], bobNote.commitment(), bobNote.index!)) {
  throw new Error('Alice must not be able to read Bob note')
}

// 3. Bob withdraws everything: 0.39 to bob.test.near, 0.01 relayer fee.
const withdrawBob = await step({
  inputs: [bobFound.utxo],
  outputs: [],
  extAmount: -390_000n,
  fee: 10_000n,
  recipient: 'bob.test.near',
  relayer: RELAYER,
})

// 4. Alice sends 1.00 to an account that is not registered with USDC; keeps 0.08.
const aliceChange2 = Utxo.owned(80_000n, alice)
const withdrawCarol = await step({
  inputs: [aliceChange],
  outputs: [{ utxo: aliceChange2, to: alice }],
  extAmount: -1_000_000n,
  recipient: 'carol.test.near',
})

// A transfer whose ext data was changed after proving (relayer raises its fee).
const tampered: ExtData = { ...transfer.extData, fee: '30000' }

const fixture = {
  empty_root: String(ZEROS[TREE_LEVELS]),
  relayer: RELAYER,
  deposit: deposit.fixture,
  transfer: transfer.fixture,
  withdraw_bob: withdrawBob.fixture,
  withdraw_carol: withdrawCarol.fixture,
  tampered_transfer_ext_data: tampered,
  // Cross-checks for the contract's own encodings.
  checks: {
    transfer_ext_data_hash: String(extDataHash(transfer.extData)),
    transfer_public_amount: String(publicAmount(0n, 20_000n)),
  },
}
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n')
const avg = Math.round(proveTimes.reduce((a, b) => a + b, 0) / proveTimes.length)
console.log(`wrote ${outPath}: 4 proofs, avg ${avg} ms each, all verified locally`)
process.exit(0)
