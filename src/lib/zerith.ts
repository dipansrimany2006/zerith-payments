// Zerith client library for the NEAR join-split pool.
//
// Must stay byte-for-byte compatible with near/contracts/pool (ext data encoding,
// account-free public amount, Poseidon tree) and circuits/transaction.circom.
// Keys reuse the existing Zerith scheme (src/lib/shielded-keys.ts): ownerPub = Poseidon(ownerPriv),
// x25519 viewing key, same ECIES sealing.

import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { poseidon1, poseidon2, poseidon3 } from 'poseidon-lite'

export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
export const TREE_LEVELS = 20
export const N_INS = 2
export const N_OUTS = 2
export const MAX_AMOUNT = 1n << 120n

// ------------------------------------------------------------------ helpers

export const bigintToBytes32 = (v: bigint) => hexToBytes(v.toString(16).padStart(64, '0'))
export const bytes32ToBigint = (b: Uint8Array) => BigInt(`0x${bytesToHex(b)}`)
export const randomField = () => bytes32ToBigint(randomBytes(32)) % FIELD_SIZE
export const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
export const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

const mod = (v: bigint) => ((v % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE

// -------------------------------------------------------------------- keys

export interface Keypair {
  ownerPriv: bigint
  ownerPub: bigint
  viewPriv: Uint8Array
  viewPub: Uint8Array
}

/** Public half of a keypair: what a sender needs to pay someone (the shld1 address). */
export interface ShieldedAddress {
  ownerPub: bigint
  viewPub: Uint8Array
}

export function keypairFromSeed(seed: Uint8Array): Keypair {
  const ownerPriv = bytes32ToBigint(sha256(concatBytes(utf8ToBytes('shielded/spend/v1'), seed))) % FIELD_SIZE
  const viewPriv = sha256(concatBytes(utf8ToBytes('shielded/view/v1'), seed))
  return { ownerPriv, ownerPub: poseidon1([ownerPriv]), viewPriv, viewPub: x25519.getPublicKey(viewPriv) }
}

export const randomKeypair = () => keypairFromSeed(randomBytes(32))

// -------------------------------------------------------------------- notes

export class Utxo {
  amount: bigint
  ownerPub: bigint
  blinding: bigint
  /** Set when we own the note and can spend it. */
  ownerPriv?: bigint
  /** Leaf index once the note is in the tree. */
  index?: number

  constructor(amount: bigint, ownerPub: bigint, blinding: bigint = randomField(), ownerPriv?: bigint, index?: number) {
    if (amount < 0n || amount >= MAX_AMOUNT) throw new Error('amount out of range')
    this.amount = amount
    this.ownerPub = ownerPub
    this.blinding = blinding
    this.ownerPriv = ownerPriv
    this.index = index
  }

  static owned(amount: bigint, keys: Keypair, blinding?: bigint) {
    return new Utxo(amount, keys.ownerPub, blinding, keys.ownerPriv)
  }

  /** Zero-amount padding input; never needs to exist in the tree. */
  static dummy() {
    return Utxo.owned(0n, randomKeypair())
  }

  commitment(): bigint {
    return poseidon3([this.amount, this.ownerPub, this.blinding])
  }

  nullifier(): bigint {
    if (this.ownerPriv === undefined) throw new Error('cannot compute nullifier without the spend key')
    return poseidon3([this.ownerPriv, this.commitment(), BigInt(this.index ?? 0)])
  }
}

const NOTE_VERSION = 2
const NONCE_LEN = 24

const symmetricKey = (shared: Uint8Array, eph: Uint8Array) =>
  sha256(concatBytes(utf8ToBytes('shielded/ecies/v1'), shared, eph))

export interface EncryptedOutput {
  ephemeral_pub: string
  ciphertext: string
}

/** plaintext = version | amount(32) | blinding(32) | memo; ciphertext = nonce | sealed */
export function encryptUtxo(utxo: Utxo, to: ShieldedAddress, memo = ''): EncryptedOutput {
  const eph = x25519.keygen()
  const shared = x25519.getSharedSecret(eph.secretKey, to.viewPub)
  const nonce = randomBytes(NONCE_LEN)
  const plain = concatBytes(
    Uint8Array.of(NOTE_VERSION),
    bigintToBytes32(utxo.amount),
    bigintToBytes32(utxo.blinding),
    utf8ToBytes(memo),
  )
  const sealed = xchacha20poly1305(symmetricKey(shared, eph.publicKey), nonce).encrypt(plain)
  return { ephemeral_pub: toB64(eph.publicKey), ciphertext: toB64(concatBytes(nonce, sealed)) }
}

/** Returns the note if it is addressed to `keys` and matches the on-chain commitment. */
export function tryDecryptUtxo(
  keys: Keypair,
  out: EncryptedOutput,
  commitment: bigint,
  leafIndex: number,
): { utxo: Utxo; memo: string } | null {
  try {
    const eph = fromB64(out.ephemeral_pub)
    const blob = fromB64(out.ciphertext)
    const shared = x25519.getSharedSecret(keys.viewPriv, eph)
    const plain = xchacha20poly1305(symmetricKey(shared, eph), blob.slice(0, NONCE_LEN)).decrypt(blob.slice(NONCE_LEN))
    if (plain[0] !== NOTE_VERSION || plain.length < 65) return null
    const utxo = new Utxo(bytes32ToBigint(plain.slice(1, 33)), keys.ownerPub, bytes32ToBigint(plain.slice(33, 65)), keys.ownerPriv, leafIndex)
    if (utxo.commitment() !== commitment) return null // forged or not ours
    return { utxo, memo: new TextDecoder().decode(plain.slice(65)) }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- merkle tree

export const ZEROS: bigint[] = (() => {
  const z = [0n]
  for (let i = 0; i < TREE_LEVELS; i++) z.push(poseidon2([z[i], z[i]]))
  return z
})()

/** Client copy of the pool tree; leaves must be appended in on-chain order. */
export class MerkleTree {
  leaves: bigint[] = []

  insert(leaf: bigint) {
    this.leaves.push(leaf)
  }

  root(): bigint {
    return this.path(0).root
  }

  path(index: number) {
    let layer = this.leaves.slice()
    let idx = index
    const pathElements: bigint[] = []
    for (let level = 0; level < TREE_LEVELS; level++) {
      pathElements.push((idx % 2 === 0 ? layer[idx + 1] : layer[idx - 1]) ?? ZEROS[level])
      const next: bigint[] = []
      for (let i = 0; i < layer.length; i += 2) next.push(poseidon2([layer[i], layer[i + 1] ?? ZEROS[level]]))
      layer = next
      idx = Math.floor(idx / 2)
    }
    return { root: layer[0] ?? ZEROS[TREE_LEVELS], pathElements }
  }
}

// ---------------------------------------------------------------- ext data

export interface ExtData {
  recipient: string | null
  ext_amount: string
  relayer: string | null
  fee: string
  encrypted_outputs: [EncryptedOutput, EncryptedOutput]
}

const u32le = (n: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
const intLe = (v: bigint, bytes: number) => {
  let x = v < 0n ? (1n << BigInt(bytes * 8)) + v : v
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}
const str = (s: string) => concatBytes(u32le(utf8ToBytes(s).length), utf8ToBytes(s))
const bytes = (b: Uint8Array) => concatBytes(u32le(b.length), b)

/**
 * sha256 over the borsh encoding of
 * (recipient: String, ext_amount: i128, relayer: String, fee: u128, [(ephemeral [u8;32], ciphertext Vec<u8>); 2]),
 * top 3 bits cleared, read big-endian. Mirrors ExtData::hash in the contract.
 */
export function extDataHash(e: ExtData): bigint {
  const parts = [str(e.recipient ?? ''), intLe(BigInt(e.ext_amount), 16), str(e.relayer ?? ''), intLe(BigInt(e.fee), 16)]
  for (const o of e.encrypted_outputs) parts.push(fromB64(o.ephemeral_pub), bytes(fromB64(o.ciphertext)))
  const h = sha256(concatBytes(...parts))
  h[0] &= 0x1f
  return bytes32ToBigint(h)
}

export const publicAmount = (extAmount: bigint, fee: bigint) => mod(extAmount - fee)

// ------------------------------------------------------------------ transact

export interface ProofArgs {
  proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] }
  root: string
  input_nullifiers: [string, string]
  output_commitments: [string, string]
}

export interface PrepareParams {
  tree: MerkleTree
  inputs: Utxo[]
  outputs: { utxo: Utxo; to: ShieldedAddress; memo?: string }[]
  extAmount: bigint
  fee?: bigint
  recipient?: string | null
  relayer?: string | null
}

export function prepareTransaction(p: PrepareParams) {
  const fee = p.fee ?? 0n
  if (p.inputs.length > N_INS || p.outputs.length > N_OUTS) throw new Error('too many inputs or outputs')
  const inputs = [...p.inputs]
  while (inputs.length < N_INS) inputs.push(Utxo.dummy())
  const outputs = [...p.outputs]
  while (outputs.length < N_OUTS) {
    const k = randomKeypair()
    outputs.push({ utxo: Utxo.owned(0n, k), to: k })
  }

  const sumIn = inputs.reduce((s, u) => s + u.amount, 0n)
  const sumOut = outputs.reduce((s, o) => s + o.utxo.amount, 0n)
  if (sumIn + p.extAmount - fee !== sumOut) throw new Error(`unbalanced: in ${sumIn} + ext ${p.extAmount} - fee ${fee} != out ${sumOut}`)

  const root = p.tree.root()
  const paths = inputs.map((u) => {
    if (u.amount === 0n) return { pathElements: Array(TREE_LEVELS).fill(0n), index: u.index ?? 0 }
    if (u.index === undefined) throw new Error('input note has no leaf index')
    return { pathElements: p.tree.path(u.index).pathElements, index: u.index }
  })

  const extData: ExtData = {
    recipient: p.recipient ?? null,
    ext_amount: p.extAmount.toString(),
    relayer: p.relayer ?? null,
    fee: fee.toString(),
    encrypted_outputs: outputs.map((o) => encryptUtxo(o.utxo, o.to, o.memo)) as [EncryptedOutput, EncryptedOutput],
  }

  const circuitInput = {
    root,
    publicAmount: publicAmount(p.extAmount, fee),
    extDataHash: extDataHash(extData),
    inputNullifier: inputs.map((u) => u.nullifier()),
    outputCommitment: outputs.map((o) => o.utxo.commitment()),
    inAmount: inputs.map((u) => u.amount),
    inPrivateKey: inputs.map((u) => u.ownerPriv!),
    inBlinding: inputs.map((u) => u.blinding),
    inPathIndices: paths.map((x) => x.index),
    inPathElements: paths.map((x) => x.pathElements),
    outAmount: outputs.map((o) => o.utxo.amount),
    outPubkey: outputs.map((o) => o.utxo.ownerPub),
    outBlinding: outputs.map((o) => o.utxo.blinding),
  }
  return { circuitInput, extData, outputs: outputs.map((o) => o.utxo) }
}

export type PrepareResult = ReturnType<typeof prepareTransaction>

/** Generates the Groth16 proof and returns the contract's `proof_args`. */
export async function prove(
  circuitInput: ReturnType<typeof prepareTransaction>['circuitInput'],
  wasm: string | Uint8Array,
  zkey: string | Uint8Array,
): Promise<ProofArgs> {
  const snarkjs = await import('snarkjs')
  const { proof } = await snarkjs.groth16.fullProve(circuitInput as never, wasm as never, zkey as never)
  return {
    proof: {
      a: [proof.pi_a[0], proof.pi_a[1]],
      b: [
        [proof.pi_b[0][0], proof.pi_b[0][1]],
        [proof.pi_b[1][0], proof.pi_b[1][1]],
      ],
      c: [proof.pi_c[0], proof.pi_c[1]],
    },
    root: circuitInput.root.toString(),
    input_nullifiers: circuitInput.inputNullifier.map(String) as [string, string],
    output_commitments: circuitInput.outputCommitment.map(String) as [string, string],
  }
}
