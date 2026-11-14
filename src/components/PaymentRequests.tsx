import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, Clock, Link2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useShielded } from '@/lib/shielded-context'
import { findPayment, loadRequests, newRequestId, requestLink, saveRequests, type PaymentRequest } from '@/lib/payment-request'
import { parseUsdc, timeAgo, usdcText } from '@/lib/format'
import { SPRING } from '@/lib/motion'
import { CopyButton, SectionLabel } from '@/components/ui'

/** Receive tab: create shareable payment-request links and see which ones were paid. */
export function PaymentRequests() {
  const { keys, notes } = useShielded()
  const [requests, setRequests] = useState<PaymentRequest[]>(() => loadRequests())
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [label, setLabel] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => saveRequests(requests), [requests])

  const mine = useMemo(() => requests.filter((r) => r.to === keys?.address), [requests, keys])
  const parsed = amount ? parseUsdc(amount) : null
  if (!keys) return null

  const create = () => {
    if (!parsed || parsed <= 0n) return
    const r: PaymentRequest = { id: newRequestId(), to: keys.address, amount: parsed, memo: memo.trim(), label: label.trim() || undefined, createdAt: Date.now() }
    setRequests((list) => [r, ...list])
    void navigator.clipboard?.writeText(requestLink(r)).then(
      () => toast.success('Payment link copied'),
      () => undefined,
    )
    setAmount('')
    setMemo('')
    setOpen(false)
  }

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Payment requests</SectionLabel>
        <button className="btn-ghost text-xs" type="button" onClick={() => setOpen((o) => !o)}>
          <Link2 className="size-3.5" aria-hidden /> New request
        </button>
      </div>

      {open && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING.snappy} className="box mb-3 space-y-2 rounded-2xl p-4">
          <p className="text-xs text-ink-2 text-pretty">
            Anyone with a NEAR wallet and USDC can pay this link. They never see your other payments, and the payment
            lands privately in your balance.
          </p>
          <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
            <input className="field" inputMode="decimal" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in USDC" />
            <input className="field" placeholder="What for, e.g. Invoice 1042" maxLength={48} value={memo} onChange={(e) => setMemo(e.target.value)} aria-label="Memo" />
          </div>
          <input className="field" placeholder="Your name or business (optional, shown to the payer)" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" />
          <button className="btn-primary" disabled={!parsed || parsed <= 0n} onClick={create}>
            Create link
          </button>
        </motion.div>
      )}

      {mine.length === 0 ? (
        <p className="text-xs text-ink-2">No requests yet. Create one to get paid by link, like an invoice.</p>
      ) : (
        <ul className="space-y-1.5">
          {mine.map((r) => {
            const paidBy = findPayment(r, notes)
            return (
              <li key={r.id} className="box flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5">
                {paidBy ? <CheckCircle2 className="size-4 text-ink" aria-label="Paid" /> : <Clock className="size-4 text-ink-2" aria-label="Waiting" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{r.memo || 'Payment request'}</span>
                  <span className="block text-[11px] text-ink-2">
                    {paidBy ? `Paid ${timeAgo(paidBy.timestampMs)}` : `Created ${timeAgo(r.createdAt)} · waiting`}
                  </span>
                </span>
                <span className="tabular-nums text-sm text-ink">{usdcText(r.amount)}</span>
                {!paidBy && <CopyButton value={requestLink(r)} label="Copy link" />}
                <button
                  type="button"
                  className="text-ink-2 hover:text-ink"
                  aria-label="Delete request"
                  onClick={() => setRequests((list) => list.filter((x) => x.id !== r.id))}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
