import type { OwnedNote } from '@/lib/shielded-context'
import { usdcText } from '@/lib/format'

/**
 * The private payment ledger the AI assistant sees: one row per note the user owns, decrypted
 * locally. This is the only user data that leaves the browser, and only to the attested TEE.
 */
export function buildLedger(notes: OwnedNote[], balance: bigint): string {
  const rows = [...notes]
    .sort((a, b) => a.leafIndex - b.leafIndex)
    .map((n) => {
      const date = new Date(n.timestampMs).toISOString().slice(0, 16).replace('T', ' ')
      const kind = n.memo === 'merge' ? 'internal-merge' : 'note'
      const memo = n.memo && n.memo !== 'merge' ? n.memo.replace(/[\n|]/g, ' ') : ''
      return `${date} | ${usdcText(n.utxo.amount)} | ${n.spent ? 'spent' : 'unspent'} | ${kind} | ${memo}`
    })
  return [
    `Private balance (unspent): ${usdcText(balance)} USDC`,
    `Notes: ${notes.length}`,
    '',
    'date (UTC) | amount USDC | status | kind | memo',
    ...rows,
  ].join('\n')
}

export const SYSTEM_PROMPT = (ledger: string, today: string) => `You are Zerith's private CFO assistant. You run inside a hardware-attested Trusted Execution Environment, so the user's private payment data stays confidential.

Today is ${today}. Amounts are USDC on NEAR. The ledger below lists the user's private notes in the Zerith shielded pool:
- A note is money the user can spend. "spent" notes were later used in a payment or withdrawal.
- Notes with a memo are usually payments the user received; notes without a memo are often change from the user's own payments or deposits.
- "internal-merge" rows are the app combining the user's own notes; they are not income or expenses.
- The ledger has no counterparty names: the protocol hides them.

Answer only from this ledger. If something cannot be known from it, say so plainly. Be concise, use exact amounts, and prefer short tables or bullet lists. Never invent transactions. Do not give tax or legal advice beyond summarising the numbers.

LEDGER
${ledger}`

export const QUICK_PROMPTS = [
  'Summarise my private payments this month.',
  'Write an audit summary I can share with my accountant.',
  'List payments whose memo mentions an invoice.',
  'How much have I received in total, and how much is still unspent?',
]
