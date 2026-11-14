import { isValidAccountId } from '@/lib/near-rpc'
import { decodeAddress } from '@/lib/shielded-keys'
import { parseUsdc } from '@/lib/format'
import type { PayRow } from '@/lib/actions'

export const MAX_PAYROLL_ROWS = 50
export const MAX_MEMO_BYTES = 64

export interface ParsedRow {
  line: number
  raw: string
  row?: PayRow
  error?: string
}

/** Splits one CSV line, honouring double quotes. */
function splitCsv(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else quoted = !quoted
    } else if ((ch === ',' || ch === ';' || ch === '\t') && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

/**
 * Parses "recipient, amount, memo" lines. A recipient is a Zerith address (shld1...) or a NEAR
 * account id. A header line and blank lines are skipped.
 */
export function parsePayroll(text: string): ParsedRow[] {
  const rows: ParsedRow[] = []
  const lines = text.split(/\r?\n/)
  for (const [i, raw] of lines.entries()) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const [recipient = '', amountText = '', ...memoParts] = splitCsv(raw)
    if (rows.length === 0 && /^(recipient|to|address)$/i.test(recipient)) continue // header
    const line = i + 1
    const memo = memoParts.join(', ')
    const amount = parseUsdc(amountText)
    if (amount === null || amount <= 0n) {
      rows.push({ line, raw, error: `Invalid amount "${amountText}"` })
      continue
    }
    if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) {
      rows.push({ line, raw, error: `Memo is over ${MAX_MEMO_BYTES} bytes` })
      continue
    }
    const shielded = decodeAddress(recipient)
    if (shielded) {
      rows.push({ line, raw, row: { target: { kind: 'shielded', to: shielded }, amount, memo } })
    } else if (isValidAccountId(recipient)) {
      rows.push({ line, raw, row: { target: { kind: 'account', accountId: recipient }, amount, memo } })
    } else {
      rows.push({ line, raw, error: `"${recipient.slice(0, 24)}" is not a Zerith address or NEAR account` })
    }
  }
  return rows
}

export const SAMPLE_CSV = `recipient,amount,memo
shld1...,250.00,October salary - design
alice.testnet,120.50,Contractor invoice 2026-10
`

export function resultsCsv(rows: PayRow[], results: { index: number; ok: boolean; txHash?: string; error?: string }[]): string {
  const lines = ['recipient,amount_base_units,memo,status,tx']
  rows.forEach((r, i) => {
    const res = results.find((x) => x.index === i)
    const who = r.target.kind === 'account' ? r.target.accountId : 'shielded address'
    const status = res ? (res.ok ? 'paid' : `failed: ${res.error ?? ''}`) : 'not sent'
    lines.push([who, r.amount.toString(), `"${(r.memo ?? '').replace(/"/g, '""')}"`, `"${status}"`, res?.txHash ?? ''].join(','))
  })
  return lines.join('\n') + '\n'
}
