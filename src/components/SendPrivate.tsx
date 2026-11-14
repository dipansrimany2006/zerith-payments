import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowLeftRight, ArrowRight, ExternalLink, Lock, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { IS_TESTNET, USDC_FAUCET_URL, txUrl } from '@/lib/near-config'
import { decodeAddress, shortAddress } from '@/lib/shielded-keys'
import { useShielded } from '@/lib/shielded-context'
import { stageText, useActions } from '@/lib/use-actions'
import { formatUsdc, friendlyError, parseUsdc, shortHash, usdcText } from '@/lib/format'
import { DURATION, SPRING } from '@/lib/motion'
import { Badge, Notice, Row, Spinner, Stepper, SuccessMark } from '@/components/ui'

/** Memo bytes; the encrypted note has room for more, but short memos keep notes small. */
export const MAX_MEMO_BYTES = 64

type Phase = 'select' | 'confirm' | 'success'
type Source = 'wallet' | 'private'
const PHASES: readonly Phase[] = ['select', 'confirm', 'success']
const STEP_LABELS = ['Select', 'Confirm', 'Success'] as const

/** Each phase slides in from the right and leaves to the left. */
const SLIDE = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
  transition: SPRING.smooth,
}

/** The round badge between the two boxes. It flips to ink once the payment is ready. */
function LinkBadge({ active }: { active: boolean }) {
  return (
    <div className="relative flex items-center justify-center md:w-12" aria-hidden>
      <div className="absolute inset-y-6 left-1/2 hidden w-px -translate-x-1/2 bg-line md:block" />
      <motion.span
        className={`relative z-10 flex size-11 items-center justify-center rounded-full transition-colors duration-300 ${active ? 'bg-ink text-canvas' : 'box text-ink'}`}
        animate={{ rotate: active ? 180 : 0 }}
        whileHover={{ scale: 1.08 }}
        transition={SPRING.chevron}
      >
        <ArrowLeftRight className="size-4 rotate-90 md:rotate-0" />
      </motion.span>
    </div>
  )
}

const SOURCES: { id: Source; title: string; sub: string }[] = [
  { id: 'wallet', title: 'From wallet', sub: 'Public USDC' },
  { id: 'private', title: 'From private balance', sub: 'Via relayer' },
]

function TxLink({ hash }: { hash: string }) {
  return (
    <a className="mono inline-flex min-h-8 items-center gap-1 text-xs text-ink underline-offset-4 hover:underline" href={txUrl(hash)} target="_blank" rel="noopener noreferrer">
      {shortHash(hash)} <ExternalLink className="size-3" aria-hidden />
    </a>
  )
}

export function SendPrivate() {
  const { keys, balance, usdcBalance, relayer, notes, loadedOnce } = useShielded()
  const actions = useActions()

  const [phase, setPhase] = useState<Phase>('select')
  const [source, setSource] = useState<Source>('wallet')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const decoded = useMemo(() => decodeAddress(recipient), [recipient])
  const toSelf = !!keys && recipient === keys.address
  const memoBytes = new TextEncoder().encode(memo).length
  const parsed = useMemo(() => (amount ? parseUsdc(amount) : null), [amount])

  const fee = source === 'private' ? (relayer?.minFee ?? null) : 0n
  const available = source === 'wallet' ? usdcBalance : loadedOnce ? balance : null
  const max = available === null || fee === null ? null : available > fee ? available - fee : 0n

  // Payments spend at most two notes; more notes are merged first, each merge paying one relayer fee.
  const unspent = notes.filter((n) => !n.spent).map((n) => n.utxo.amount).sort((a, b) => (b > a ? 1 : -1))
  const needsMerge =
    source === 'private' && parsed !== null && fee !== null && unspent.length > 2 && (unspent[0] ?? 0n) + (unspent[1] ?? 0n) < parsed + fee

  const insufficient = parsed !== null && max !== null && parsed > max
  const amountProblem =
    amount && parsed === null
      ? 'Enter a valid amount (up to 6 decimals).'
      : parsed === 0n
        ? 'Enter an amount above zero.'
        : source === 'private' && !relayer
          ? 'The relayer is offline right now, so private sends are unavailable. Sending from your wallet still works.'
          : insufficient
            ? source === 'wallet'
              ? 'Not enough USDC in your wallet.'
              : 'Not enough private balance for this amount plus the relayer fee.'
            : source === 'private' && toSelf
              ? 'This is already your private balance. Sending it to yourself only costs a fee.'
              : null

  const ready =
    !!keys &&
    !!decoded &&
    parsed !== null &&
    parsed > 0n &&
    !insufficient &&
    max !== null &&
    memoBytes <= MAX_MEMO_BYTES &&
    (source === 'wallet' || !!relayer)

  const send = async () => {
    if (!ready || !decoded || parsed === null) return
    setError(null)
    try {
      const hash =
        source === 'wallet'
          ? await actions.shield({ amount: parsed, to: decoded, memo })
          : await actions.sendPrivate({ amount: parsed, to: decoded, memo })
      setTxHash(hash)
      toast.success(toSelf ? 'Private balance topped up' : 'Private payment sent', {
        action: { label: 'View', onClick: () => window.open(txUrl(hash), '_blank', 'noopener,noreferrer') },
      })
      setPhase('success')
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  const reset = () => {
    setPhase('select')
    setError(null)
    setTxHash(null)
    setRecipient('')
    setAmount('')
    setMemo('')
  }

  const sending = actions.busy
  const recipientLabel = toSelf ? 'Myself' : shortAddress(recipient)

  return (
    <div className="flex h-full flex-col">
      <Stepper steps={STEP_LABELS} current={PHASES.indexOf(phase)} />

      <AnimatePresence mode="wait" initial={false}>
        {phase === 'select' && (
          <motion.div key="select" {...SLIDE} className="mt-8 flex flex-1 flex-col">
            <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Pay from">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={source === s.id}
                  onClick={() => setSource(s.id)}
                  className={`relative min-h-14 rounded-2xl border p-3 text-left transition-colors ${source === s.id ? 'border-ink' : 'border-line hover:border-ink-2'}`}
                >
                  {source === s.id && <motion.span layoutId="send-source" className="absolute inset-0 rounded-2xl bg-surface" transition={SPRING.snappy} aria-hidden />}
                  <span className="relative block text-sm font-semibold text-ink">{s.title}</span>
                  <span className="relative block text-[11px] text-ink-2">{s.sub}</span>
                </button>
              ))}
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:gap-0">
              <div className="box rounded-2xl p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-ink">{source === 'wallet' ? 'Public wallet' : 'Private balance'}</p>
                    <p className="text-[11px] text-ink-2">
                      {available !== null ? `${usdcText(available)} USDC available` : 'Reading your balance...'}
                    </p>
                  </div>
                  <Badge>{source === 'wallet' ? <Wallet className="size-4" /> : <Lock className="size-4" />}</Badge>
                </div>

                <label htmlFor="amount" className="mt-8 block text-[11px] text-ink-2">
                  You send
                </label>
                <div className="line-field mt-1 flex items-baseline gap-2 pb-1">
                  <input
                    id="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.]/g, '')
                      if (v === '' || /^\d*\.?\d{0,6}$/.test(v)) setAmount(v)
                    }}
                    placeholder="0.00"
                    className="w-full min-w-0 bg-transparent font-display text-4xl font-light tabular-nums text-ink outline-none placeholder:text-muted"
                  />
                  <span className="font-display text-2xl text-ink">USDC</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {['1', '5', '10'].map((v) => (
                    <motion.button
                      key={v}
                      type="button"
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.94 }}
                      transition={SPRING.snappy}
                      onClick={() => setAmount(v)}
                      className="min-h-9 rounded-full border border-line px-3 text-xs font-semibold tabular-nums text-ink transition-colors hover:border-ink"
                    >
                      {v}
                    </motion.button>
                  ))}
                  {max !== null && max > 0n && (
                    <motion.button
                      type="button"
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.94 }}
                      transition={SPRING.snappy}
                      onClick={() => setAmount(formatUsdc(max))}
                      className="min-h-9 rounded-full border border-line px-3 text-xs font-semibold tabular-nums text-ink transition-colors hover:border-ink"
                    >
                      Max
                    </motion.button>
                  )}
                </div>
                {source === 'wallet' && IS_TESTNET && usdcBalance === 0n && (
                  <p className="mt-3 text-[11px] text-ink-2">
                    No USDC yet?{' '}
                    <a href={USDC_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-ink underline-offset-4 hover:underline">
                      Get testnet USDC
                    </a>
                  </p>
                )}
              </div>

              <LinkBadge active={ready} />

              <div className="box rounded-2xl p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">Zerith address</p>
                    <p className="truncate text-[11px] text-ink-2">{decoded ? recipientLabel : 'Who gets paid'}</p>
                  </div>
                  <Badge>
                    <Lock className="size-4" />
                  </Badge>
                </div>

                <div className="mt-8 flex items-center justify-between gap-2">
                  <label htmlFor="recipient" className="text-[11px] text-ink-2">
                    Recipient
                  </label>
                  {keys && (
                    <button type="button" className="min-h-8 text-xs font-semibold text-ink underline-offset-4 hover:underline" onClick={() => setRecipient(keys.address)}>
                      Myself
                    </button>
                  )}
                </div>
                <input
                  id="recipient"
                  className="field mono mt-1 text-xs"
                  placeholder="shld1..."
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.trim())}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!recipient && !decoded}
                />
                {recipient && !decoded && <p className="mt-1 text-[11px] text-danger">Not a valid Zerith address.</p>}
                {toSelf && source === 'wallet' && <p className="mt-1 text-[11px] text-ink-2">Tops up your own private balance.</p>}

                <p className="mt-5 text-[11px] text-ink-2">They receive</p>
                <p className="font-display text-4xl font-light tabular-nums text-muted">
                  {parsed ? usdcText(parsed) : '0.00'} <span className="text-2xl">USDC</span>
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label htmlFor="memo" className="block text-[11px] text-ink-2">
                Private memo (optional)
              </label>
              <input id="memo" className="field mt-1" placeholder="Invoice 1042" value={memo} onChange={(e) => setMemo(e.target.value)} autoComplete="off" />
              <p className={`mt-1 text-[11px] tabular-nums ${memoBytes > MAX_MEMO_BYTES ? 'text-danger' : 'text-ink-2'}`}>
                {memoBytes}/{MAX_MEMO_BYTES} bytes. Only you and the recipient can read it.
              </p>
            </div>

            {amountProblem && (
              <div className="mt-3">
                <Notice tone="warn">{amountProblem}</Notice>
              </div>
            )}
            {needsMerge && !amountProblem && (
              <div className="mt-3">
                <Notice>Your balance is spread over several notes. They are merged first, and each merge costs one more relayer fee.</Notice>
              </div>
            )}

            <div className="mt-auto flex flex-col gap-4 border-t border-line pt-5 sm:flex-row sm:items-end sm:justify-between">
              <dl className="flex flex-wrap gap-x-8 gap-y-2">
                <div>
                  <dt className="text-[11px] text-ink-2">Relayer fee</dt>
                  <dd className="text-sm font-semibold tabular-nums text-ink">
                    {source === 'wallet' ? 'None' : fee !== null ? `${usdcText(fee)} USDC` : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-2">Sent by</dt>
                  <dd className="text-sm font-semibold text-ink">{source === 'wallet' ? 'Your wallet' : 'Relayer'}</dd>
                </div>
              </dl>
              <button className="btn-primary" disabled={!ready} onClick={() => setPhase('confirm')}>
                Review payment <ArrowRight className="btn-arrow size-4" aria-hidden />
              </button>
            </div>
          </motion.div>
        )}

        {phase === 'confirm' && (
          <motion.div key="confirm" {...SLIDE} className="mt-8 flex flex-1 flex-col">
            <h3 className="font-display text-3xl font-light text-ink">Review payment</h3>
            <div className="box mt-4 rounded-2xl px-5 py-3">
              <Row label="From" value={source === 'wallet' ? 'Public wallet' : 'Private balance'} />
              <Row label="To" value={<span className={toSelf ? '' : 'mono text-xs'}>{recipientLabel}</span>} />
              <Row label="Amount" value={`${usdcText(parsed ?? 0n)} USDC`} strong />
              {source === 'private' && <Row label="Relayer fee" value={`${usdcText(fee ?? 0n)} USDC${needsMerge ? ' + merge fees' : ''}`} />}
              <Row label="Memo" value={memo || 'None'} />
            </div>
            <p className="mt-3 text-[11px] text-ink-2">
              {source === 'wallet'
                ? 'Your deposit is public. Who it is for stays hidden. Your wallet will ask you to confirm.'
                : 'Nothing on chain links this payment to your account. The relayer submits it for you.'}
            </p>

            {sending && actions.stage && (
              <p className="mt-5 flex items-center gap-2 text-xs font-semibold text-ink" aria-live="polite">
                <Spinner className="size-3.5" /> {stageText(actions.stage)}
              </p>
            )}
            {error && (
              <div className="mt-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}

            <div className="mt-auto flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:justify-end">
              <button type="button" className="btn-ghost min-h-12" disabled={sending} onClick={() => setPhase('select')}>
                <ArrowLeft className="size-4" aria-hidden /> Back
              </button>
              <button className="btn-primary" disabled={!ready || sending} onClick={() => void send()}>
                {sending ? (
                  <>
                    <Spinner /> Sending...
                  </>
                ) : (
                  <>
                    Confirm and send <ArrowRight className="btn-arrow size-4" aria-hidden />
                  </>
                )}
              </button>
            </div>
          </motion.div>
        )}

        {phase === 'success' && (
          <motion.div key="success" {...SLIDE} className="mt-8 flex flex-1 flex-col items-center text-center">
            <SuccessMark />
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...SPRING.smooth, delay: DURATION.checkDraw }}
              className="mt-5 max-w-sm"
            >
              <h3 className="font-display text-3xl font-light text-ink">{toSelf ? 'Balance topped up' : 'Payment sent'}</h3>
              <p className="mt-2 text-sm text-ink-2 text-pretty">
                {toSelf
                  ? `${usdcText(parsed ?? 0n)} USDC is now in your private balance.`
                  : `${usdcText(parsed ?? 0n)} USDC is in the pool for ${shortAddress(recipient)}. For the best privacy, the recipient should wait a while before withdrawing.`}
              </p>
            </motion.div>
            {txHash && (
              <div className="mt-4">
                <TxLink hash={txHash} />
              </div>
            )}
            <button className="btn-primary mt-auto" onClick={reset}>
              Send another <ArrowRight className="btn-arrow size-4" aria-hidden />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
