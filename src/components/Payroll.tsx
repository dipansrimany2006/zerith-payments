import { useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Download, FileUp, Users } from 'lucide-react'
import { toast } from 'sonner'
import { useShielded } from '@/lib/shielded-context'
import { stageText, useActions } from '@/lib/use-actions'
import { MAX_SHIELD_TXS, type RowResult } from '@/lib/actions'
import { MAX_PAYROLL_ROWS, SAMPLE_CSV, parsePayroll, resultsCsv } from '@/lib/payroll'
import { IS_TESTNET, USDC_FAUCET_URL, txUrl } from '@/lib/near-config'
import { shortAddress, encodeAddress } from '@/lib/shielded-keys'
import { friendlyError, usdcText } from '@/lib/format'
import { SPRING, STAGGER } from '@/lib/motion'
import { Notice, Row, SectionLabel, Spinner } from '@/components/ui'

type Source = 'wallet' | 'private'

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** Pay many people at once: from the wallet (one approval) or from the private balance (via relayer). */
export function Payroll() {
  const { balance, usdcBalance, relayer } = useShielded()
  const actions = useActions()
  const [text, setText] = useState('')
  const [source, setSource] = useState<Source>('wallet')
  const [results, setResults] = useState<RowResult[]>([])
  const [walletHashes, setWalletHashes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const parsed = useMemo(() => parsePayroll(text), [text])
  const rows = parsed.flatMap((p) => (p.row ? [p.row] : []))
  const invalid = parsed.filter((p) => p.error)
  const total = rows.reduce((s, r) => s + r.amount, 0n)
  const hasAccounts = rows.some((r) => r.target.kind === 'account')
  const fee = relayer?.minFee ?? 0n
  const fees = source === 'private' ? fee * BigInt(rows.length) : 0n
  const walletTxs = Math.ceil(rows.length / 2)

  const problem =
    rows.length === 0
      ? null
      : invalid.length
        ? `Fix ${invalid.length} invalid line${invalid.length > 1 ? 's' : ''} first.`
        : rows.length > MAX_PAYROLL_ROWS
          ? `At most ${MAX_PAYROLL_ROWS} payments per run.`
          : source === 'wallet' && hasAccounts
            ? 'Paying NEAR accounts directly is only possible from your private balance (it would be public otherwise). Use Zerith addresses, or switch the source.'
            : source === 'wallet' && walletTxs > MAX_SHIELD_TXS
              ? `At most ${MAX_SHIELD_TXS * 2} recipients per wallet batch.`
              : source === 'wallet' && usdcBalance !== null && usdcBalance < total
                ? 'Your wallet does not hold enough USDC for this payroll.'
                : source === 'private' && !relayer
                  ? 'The relayer is offline.'
                  : source === 'private' && balance < total + fees
                    ? 'Your private balance does not cover the payroll plus fees.'
                    : null

  const run = async () => {
    setError(null)
    setResults([])
    setWalletHashes([])
    try {
      if (source === 'wallet') {
        const hashes = await actions.shieldMany(rows)
        setWalletHashes(hashes)
        // Two recipients per deposit transaction, in order.
        setResults(rows.map((_, index) => ({ index, ok: true, txHash: hashes[Math.floor(index / 2)] })))
        toast.success(`Paid ${rows.length} people privately in ${hashes.length} transaction${hashes.length > 1 ? 's' : ''}`)
      } else {
        const res = await actions.payFromPrivate(rows, (r) => setResults((prev) => [...prev, r]))
        const paid = res.filter((r) => r.ok).length
        if (paid === rows.length) toast.success(`Paid all ${paid} payments privately`)
        else setError(`Stopped after ${paid} of ${rows.length}: ${friendlyError(res.find((r) => !r.ok)?.error)}`)
      }
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  const done = walletHashes.length > 0 || results.length > 0

  return (
    <div className="flex flex-col">
      <h2 className="font-display text-4xl font-light text-ink">Payroll</h2>
      <p className="mb-6 mt-1 max-w-lg text-sm text-ink-2 text-pretty">
        Pay your team or contractors in one go. Each person gets a private note only they can open; nobody can see who
        was paid what.
      </p>

      <SectionLabel>1 · Who to pay</SectionLabel>
      <textarea
        className="field mono min-h-36 text-xs"
        placeholder={'recipient,amount,memo\nshld1…,250.00,October salary\nbob.testnet,120.50,Invoice 1042'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={actions.busy}
        aria-label="Payroll CSV"
        spellCheck={false}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn-ghost text-xs" type="button" onClick={() => fileRef.current?.click()} disabled={actions.busy}>
          <FileUp className="size-3.5" aria-hidden /> Upload CSV
        </button>
        <button className="btn-ghost text-xs" type="button" onClick={() => download(SAMPLE_CSV, 'zerith-payroll-template.csv')}>
          <Download className="size-3.5" aria-hidden /> Template
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (f) setText(await f.text())
            e.target.value = ''
          }}
        />
      </div>

      {parsed.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {parsed.map((p, i) => (
            <motion.div
              key={`${p.line}-${i}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...SPRING.smooth, delay: Math.min(i, 10) * STAGGER.tight }}
              className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${p.error ? 'border border-danger' : 'box'}`}
            >
              <span className="w-6 text-[11px] text-muted">{p.line}</span>
              {p.row ? (
                <>
                  <span className="mono min-w-0 flex-1 truncate text-xs text-ink">
                    {p.row.target.kind === 'account' ? p.row.target.accountId : shortAddress(encodeAddress(p.row.target.to.ownerPub, p.row.target.to.viewPub))}
                  </span>
                  <span className="hidden max-w-40 truncate text-xs text-ink-2 sm:block">{p.row.memo}</span>
                  <span className="tabular-nums text-ink">{usdcText(p.row.amount)}</span>
                  {(() => {
                    const idx = rows.indexOf(p.row)
                    const r = results.find((x) => x.index === idx)
                    if (!r) return null
                    return r.ok ? (
                      <a className="text-xs underline" href={txUrl(r.txHash!)} target="_blank" rel="noreferrer">
                        paid
                      </a>
                    ) : (
                      <span className="text-xs text-danger">failed</span>
                    )
                  })()}
                </>
              ) : (
                <span className="flex-1 text-xs text-danger">{p.error}</span>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="mt-6">
            <SectionLabel>2 · Pay from</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              {(['wallet', 'private'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={actions.busy}
                  onClick={() => setSource(s)}
                  className={`rounded-2xl border p-3 text-left transition-colors ${source === s ? 'border-ink bg-[var(--raised)]' : 'border-line'}`}
                >
                  <span className="block text-sm font-semibold text-ink">{s === 'wallet' ? 'Wallet USDC' : 'Private balance'}</span>
                  <span className="block text-xs text-ink-2">
                    {s === 'wallet'
                      ? `One approval · ${usdcBalance === null ? '…' : usdcText(usdcBalance)} available`
                      : `No public trail · ${usdcText(balance)} available`}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-line p-4">
            <Row label="Payments" value={rows.length} />
            <Row label="Total" value={`${usdcText(total)} USDC`} />
            {source === 'private' ? (
              <Row label={`Relayer fees (${usdcText(fee)} each)`} value={`${usdcText(fees)} USDC`} />
            ) : (
              <Row label="Wallet transactions" value={`${walletTxs} (2 people each, one approval)`} />
            )}
            <Row label="You pay" value={`${usdcText(total + fees)} USDC`} strong />
            <p className="mt-2 text-xs text-ink-2 text-pretty">
              {source === 'wallet'
                ? 'Visible on-chain: your account deposited this total. Hidden: who received it and how it was split.'
                : 'Visible on-chain: nothing that links these payments to you. NEAR-account recipients and amounts are public on their side.'}
            </p>
          </div>

          {problem && (
            <div className="mt-4">
              <Notice tone="warn">
                {problem}
                {IS_TESTNET && source === 'wallet' && problem.includes('enough USDC') && (
                  <>
                    {' '}
                    <a className="underline" href={USDC_FAUCET_URL} target="_blank" rel="noreferrer">
                      Get testnet USDC
                    </a>
                  </>
                )}
              </Notice>
            </div>
          )}
          {error && (
            <div className="mt-4">
              <Notice tone="error">{error}</Notice>
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button className="btn-primary" disabled={!!problem || actions.busy} onClick={() => void run()}>
              {actions.busy ? (
                <>
                  <Spinner /> {actions.stage ? stageText(actions.stage) : 'Working...'}
                </>
              ) : (
                <>
                  <Users className="size-4" aria-hidden /> Pay {rows.length} {rows.length === 1 ? 'person' : 'people'}
                </>
              )}
            </button>
            {done && (
              <button className="btn-ghost text-xs" onClick={() => download(resultsCsv(rows, results), 'zerith-payroll-results.csv')}>
                <Download className="size-3.5" aria-hidden /> Results CSV
              </button>
            )}
          </div>

          {walletHashes.length > 0 && (
            <div className="mt-4 space-y-1 text-xs">
              {walletHashes.map((h, i) => (
                <a key={h} className="mono block underline-offset-2 hover:underline" href={txUrl(h)} target="_blank" rel="noreferrer">
                  Deposit {i + 1}: {h.slice(0, 10)}…
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
