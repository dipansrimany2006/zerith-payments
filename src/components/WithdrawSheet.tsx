import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, ExternalLink, X } from 'lucide-react'
import { toast } from 'sonner'
import { NETWORK_NAME, txUrl } from '@/lib/near-config'
import { isValidAccountId } from '@/lib/near-rpc'
import { useShielded } from '@/lib/shielded-context'
import { useWallet } from '@/lib/wallet'
import { stageText, useActions } from '@/lib/use-actions'
import { formatUsdc, friendlyError, parseUsdc, shortHash, usdcText } from '@/lib/format'
import { DURATION, SPRING } from '@/lib/motion'
import { Notice, Row, Spinner, Stepper, SuccessMark } from '@/components/ui'

const FRESH_NOTE_MS = 15 * 60 * 1000

/**
 * Withdraws part or all of the private balance to any NEAR account. The relayer submits the
 * transaction and takes its fee from the private balance, so the destination needs no NEAR.
 */
export function WithdrawSheet({ onClose }: { onClose: () => void }) {
  const { accountId } = useWallet()
  const { balance, relayer, notes } = useShielded()
  const actions = useActions()

  const [destination, setDestination] = useState(accountId ?? '')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [done, setDone] = useState<{ amount: bigint; to: string } | null>(null)
  const [openedAt] = useState(() => Date.now())

  const fee = relayer?.minFee ?? null
  const max = fee !== null && balance > fee ? balance - fee : 0n
  const parsed = useMemo(() => (amount ? parseUsdc(amount) : null), [amount])
  const dest = destination.trim().toLowerCase()
  const validDestination = isValidAccountId(dest)
  const busy = actions.busy

  const amountProblem =
    amount && parsed === null
      ? 'Enter a valid amount (up to 6 decimals).'
      : parsed === 0n
        ? 'Enter an amount above zero.'
        : parsed !== null && fee !== null && parsed > max
          ? `You can withdraw up to ${usdcText(max)} USDC after the relayer fee.`
          : null

  const unspent = notes.filter((n) => !n.spent)
  const fresh = unspent.some((n) => openedAt - n.timestampMs < FRESH_NOTE_MS)
  const toOwnAccount = !!accountId && dest === accountId
  const canStart = !!relayer && validDestination && parsed !== null && parsed > 0n && !amountProblem && !busy && !done

  // Escape closes the dialog, except while a withdrawal is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const withdraw = async () => {
    if (!canStart || parsed === null) return
    setError(null)
    try {
      const hash = await actions.withdraw({ amount: parsed, recipient: dest })
      setTxHash(hash)
      setDone({ amount: parsed, to: dest })
      toast.success(`${usdcText(parsed)} USDC withdrawn`, {
        action: { label: 'View', onClick: () => window.open(txUrl(hash), '_blank', 'noopener,noreferrer') },
      })
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: DURATION.backdrop }}
      onClick={() => !busy && onClose()}
    >
      <div className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-sm" />
      <motion.section
        role="dialog"
        aria-modal="true"
        aria-label="Withdraw"
        className="frame relative max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[28px] sm:rounded-[28px]"
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        transition={SPRING.popup}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <h3 className="font-display text-3xl font-light text-ink">Withdraw USDC</h3>
          <motion.button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            whileHover={{ rotate: 90 }}
            whileTap={{ scale: 0.9 }}
            transition={SPRING.chevron}
            className="flex size-11 items-center justify-center rounded-full text-ink hover:bg-surface disabled:opacity-40"
          >
            <X className="size-5" />
          </motion.button>
        </div>

        <div className="px-6 pt-4">
          <Stepper steps={['Details', 'Prove', 'Done']} current={done ? 2 : busy ? 1 : 0} />
        </div>

        <div className="space-y-4 px-6 pb-6 pt-6">
          {done ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <SuccessMark />
              <p className="text-sm font-semibold text-ink">
                {usdcText(done.amount)} USDC withdrawn to {done.to}
              </p>
              {txHash && (
                <a className="mono inline-flex min-h-8 items-center gap-1 text-xs text-ink underline-offset-4 hover:underline" href={txUrl(txHash)} target="_blank" rel="noopener noreferrer">
                  {shortHash(txHash)} <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              <button className="btn-primary mt-2 w-full" onClick={onClose}>
                Done
              </button>
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="withdraw-amount" className="block text-[11px] text-ink-2">
                    Amount
                  </label>
                  <button
                    type="button"
                    className="min-h-8 text-xs font-semibold text-ink underline-offset-4 hover:underline disabled:opacity-40"
                    disabled={busy || max === 0n}
                    onClick={() => setAmount(formatUsdc(max))}
                  >
                    Max {usdcText(max)}
                  </button>
                </div>
                <div className="line-field mt-1 flex items-baseline gap-2 pb-1">
                  <input
                    id="withdraw-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    autoFocus
                    value={amount}
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.]/g, '')
                      if (v === '' || /^\d*\.?\d{0,6}$/.test(v)) setAmount(v)
                    }}
                    placeholder="0.00"
                    className="w-full min-w-0 bg-transparent font-display text-4xl font-light tabular-nums text-ink outline-none placeholder:text-muted"
                  />
                  <span className="font-display text-2xl text-ink">USDC</span>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-ink-2" htmlFor="destination">
                  {NETWORK_NAME} account
                </label>
                <input
                  id="destination"
                  className="field mono mt-1 text-xs"
                  placeholder="alice.testnet"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value.trim())}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!destination && !validDestination}
                />
                <p className={`mt-1 text-[11px] ${destination && !validDestination ? 'text-danger' : 'text-ink-2'}`}>
                  {destination && !validDestination
                    ? 'Not a valid NEAR account id.'
                    : toOwnAccount
                      ? 'Your connected account. A fresh account no one links to you is more private.'
                      : 'Any NEAR account, named or implicit.'}
                </p>
              </div>

              <div className="panel rounded-2xl px-4 py-2">
                <Row label="Private balance" value={`${usdcText(balance)} USDC`} />
                <Row label="Relayer fee" value={fee !== null ? `${usdcText(fee)} USDC` : '—'} />
                <Row label="They receive" value={`${usdcText(parsed ?? 0n)} USDC`} strong />
              </div>

              {amountProblem && <Notice tone="warn">{amountProblem}</Notice>}
              {!relayer && <Notice tone="warn">The relayer is not reachable right now, so withdrawals are unavailable. Try again in a moment.</Notice>}
              {fresh && !busy && (
                <Notice tone="warn">A payment arrived minutes ago. Waiting longer before you withdraw makes it harder to match to the deposit.</Notice>
              )}
              {busy && actions.stage && (
                <p className="flex items-center gap-2 text-xs font-semibold text-ink" aria-live="polite">
                  <Spinner className="size-3.5" /> {stageText(actions.stage)}
                </p>
              )}
              {error && <Notice tone="error">{error}</Notice>}

              <button className="btn-primary w-full" disabled={!canStart} onClick={() => void withdraw()}>
                {busy ? (
                  <>
                    <Spinner /> Withdrawing...
                  </>
                ) : (
                  <>
                    Withdraw <ArrowRight className="btn-arrow size-4" aria-hidden />
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </motion.section>
    </motion.div>
  )
}
