import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { keypairFromSeed, type Keypair } from '@/lib/zerith'

/** BN254 scalar field size. */
export const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n

// Protocol constants: keys are derived from the wallet's NEP-413 signature over exactly these
// values, so changing any of them gives every user new keys and strands notes already sent.
export const KEY_DERIVATION_MESSAGE = [
  'Zerith: derive private payment keys (NEAR v1)',
  '',
  'Signing creates your shielded address and viewing key on this device.',
  'It does not send a transaction and costs nothing.',
  'Only sign this on the Zerith app.',
].join('\n')
export const KEY_DERIVATION_RECIPIENT = 'zerith'
/** NEP-413 needs a 32-byte nonce; a fixed one keeps the signature, and so the keys, deterministic. */
export const KEY_DERIVATION_NONCE = sha256(utf8ToBytes('zerith/keys/near/v1'))

export const ADDRESS_PREFIX = 'shld1'

export interface ShieldedKeys extends Keypair {
  /** Shareable shielded address: ownerPub + viewPub. */
  address: string
}

export function bigintToBytes32(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(64, '0'))
}

export function bytes32ToBigint(bytes: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(bytes)}`)
}

/**
 * Keys from the raw 64-byte ed25519 signature. Ed25519 is deterministic, so the same NEAR access
 * key always yields the same shielded keys. A different access key (another wallet or device
 * holding a different key for the same account) yields a different shielded address.
 */
export function deriveKeysFromSignature(signature: Uint8Array): ShieldedKeys {
  if (signature.length !== 64) throw new Error('Unexpected signature length')
  const kp = keypairFromSeed(signature)
  return { ...kp, address: encodeAddress(kp.ownerPub, kp.viewPub) }
}

export function encodeAddress(ownerPub: bigint, viewPub: Uint8Array): string {
  return `${ADDRESS_PREFIX}${bytesToHex(bigintToBytes32(ownerPub))}${bytesToHex(viewPub)}`
}

export interface DecodedAddress {
  ownerPub: bigint
  viewPub: Uint8Array
}

export function decodeAddress(input: string): DecodedAddress | null {
  const value = input.trim()
  if (!value.startsWith(ADDRESS_PREFIX)) return null
  const hex = value.slice(ADDRESS_PREFIX.length)
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) return null
  const bytes = hexToBytes(hex)
  const ownerPub = bytes32ToBigint(bytes.slice(0, 32))
  if (ownerPub >= FIELD_SIZE) return null
  return { ownerPub, viewPub: bytes.slice(32, 64) }
}

export function shortAddress(address: string): string {
  return address.length > 18 ? `${address.slice(0, 11)}...${address.slice(-6)}` : address
}
