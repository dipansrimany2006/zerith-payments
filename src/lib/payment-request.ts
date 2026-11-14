/**
 * Payment requests: a payee shares a link carrying their Zerith address, an amount and a memo.
 * Anyone with a NEAR wallet and USDC can pay it; no Zerith account is needed. The memo embeds a
 * short request id, so the payee's app can mark the request paid when the matching note arrives.
 * The link itself is public, so it only ever contains what the payer must see anyway.
 */
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { decodeAddress, type DecodedAddress } from '@/lib/shielded-keys'
import type { OwnedNote } from '@/lib/shielded-context'

export interface PaymentRequest {
  id: string
  to: string
  amount: bigint
  memo: string
  /** Optional name shown to the payer, e.g. a business name. */
  label?: string
  createdAt: number
}

const STORAGE = 'zerith.requests.v1'
const TAG = /\[req:([0-9a-f]{8})\]/

export const newRequestId = () => bytesToHex(randomBytes(4))

/** The memo the payer's note will carry. Stays within the 64-byte memo limit. */
export function requestMemo(r: Pick<PaymentRequest, 'id' | 'memo'>): string {
  const tag = `[req:${r.id}]`
  const room = 64 - tag.length - 1
  let memo = r.memo
  while (new TextEncoder().encode(memo).length > room) memo = memo.slice(0, -1)
  return memo ? `${memo} ${tag}` : tag
}

export function requestLink(r: PaymentRequest, origin = window.location.origin): string {
  const q = new URLSearchParams({ to: r.to, amount: r.amount.toString(), memo: r.memo, id: r.id })
  if (r.label) q.set('label', r.label)
  return `${origin}/#pay?${q.toString()}`
}

export interface IncomingRequest {
  id: string
  to: DecodedAddress
  toText: string
  amount: bigint
  memo: string
  label?: string
}

/** Reads a request from the current URL hash (#pay?...), or null. */
export function readRequestFromHash(hash = window.location.hash): IncomingRequest | null {
  if (!hash.startsWith('#pay?')) return null
  const q = new URLSearchParams(hash.slice(5))
  const toText = q.get('to') ?? ''
  const to = decodeAddress(toText)
  const amountText = q.get('amount') ?? ''
  const id = q.get('id') ?? ''
  if (!to || !/^\d{1,30}$/.test(amountText) || !/^[0-9a-f]{8}$/.test(id)) return null
  const amount = BigInt(amountText)
  if (amount <= 0n) return null
  return { id, to, toText, amount, memo: (q.get('memo') ?? '').slice(0, 64), label: q.get('label')?.slice(0, 40) || undefined }
}

export function loadRequests(): PaymentRequest[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) ?? '[]') as (Omit<PaymentRequest, 'amount'> & { amount: string })[]
    return raw.map((r) => ({ ...r, amount: BigInt(r.amount) }))
  } catch {
    return []
  }
}

export function saveRequests(list: PaymentRequest[]) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(list.map((r) => ({ ...r, amount: r.amount.toString() }))))
  } catch {
    // storage unavailable: requests last for this session only
  }
}

/** The note that paid a request: same id in the memo and at least the requested amount. */
export function findPayment(r: PaymentRequest, notes: OwnedNote[]): OwnedNote | undefined {
  return notes.find((n) => TAG.exec(n.memo)?.[1] === r.id && n.utxo.amount >= r.amount)
}
