/** USDC has 6 decimals on NEAR. Amounts are always bigint base units; numbers are for display only. */
export const USDC_DECIMALS = 6
const UNIT = 10n ** BigInt(USDC_DECIMALS)

/** Exact decimal text for base units, e.g. 1500000n -> "1.5". */
export function formatUsdc(raw: bigint): string {
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const whole = abs / UNIT
  const frac = (abs % UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** "1.50" style USDC text from base units, with at least 2 decimals and more only when needed. */
export function usdcText(raw: bigint): string {
  const [whole, frac = ''] = formatUsdc(raw).split('.')
  return `${whole}.${frac.padEnd(2, '0')}`
}

/** USDC base units as a plain number, for display and animation only. */
export function usdcNumber(raw: bigint): number {
  return Number(raw) / 10 ** USDC_DECIMALS
}

/** Parses user input like "12", "12.5" or ".25" into base units. Null if it is not a valid amount. */
export function parseUsdc(input: string): bigint | null {
  const value = input.trim()
  const m = /^(\d*)(?:\.(\d*))?$/.exec(value)
  if (!m || (!m[1] && !m[2])) return null
  const frac = m[2] ?? ''
  if (frac.length > USDC_DECIMALS) return null
  return BigInt(m[1] || '0') * UNIT + BigInt(frac.padEnd(USDC_DECIMALS, '0') || '0')
}

/** "3 min ago" from a millisecond timestamp. */
export function timeAgo(ms: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`
  return `${Math.floor(diff / 86400)} d ago`
}

export function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value
}

/** Error codes the pool contract panics with. */
const CONTRACT_MESSAGES: Record<string, string> = {
  ERR_NULLIFIER_SPENT: 'One of these notes was already spent. Scan again and retry.',
  ERR_UNKNOWN_ROOT: 'The pool changed while preparing the proof. Try again.',
  ERR_INVALID_PROOF: 'The proof was rejected. Scan again and retry.',
  ERR_PAUSED: 'The pool is paused right now. Try again later.',
  ERR_AMOUNT_MISMATCH: 'The deposited amount did not match the note. Nothing was taken; try again.',
}

/** Turns wallet, RPC, contract and relayer errors into one short sentence. */
export function friendlyError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : error ? JSON.stringify(error) : ''
  const lower = raw.toLowerCase()
  if (
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('user cancel') ||
    lower.includes('rejected by user') ||
    lower.includes('wallet closed') ||
    lower.includes('window closed') ||
    lower.includes('popup closed') ||
    lower.includes('modal closed') ||
    lower.includes('cancelled') ||
    lower.includes('canceled')
  ) {
    return 'Cancelled in your wallet.'
  }
  for (const [code, message] of Object.entries(CONTRACT_MESSAGES)) {
    if (raw.includes(code)) return message
  }
  if (lower.includes('not enough private balance')) {
    return lower.includes('merging') ? 'Not enough private balance once note-merging fees are included.' : 'Not enough private balance for this amount plus the fee.'
  }
  if (lower.includes('relayer is offline') || lower.includes('relayer error')) {
    return 'The relayer is offline right now. Try again in a moment.'
  }
  if (lower.includes('the account balance') || lower.includes('exceeds the balance') || lower.includes('notenoughbalance')) {
    return 'Not enough USDC or NEAR in your wallet for this.'
  }
  if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('timeout')) {
    return 'Network issue. Check your connection and try again.'
  }
  return raw.split('\n')[0].slice(0, 200) || 'Something went wrong. Try again.'
}
