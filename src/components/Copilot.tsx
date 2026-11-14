import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, BadgeCheck, ChevronDown, Eye, KeyRound, ShieldAlert, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useShielded } from '@/lib/shielded-context'
import { buildLedger, QUICK_PROMPTS, SYSTEM_PROMPT } from '@/lib/ledger'
import {
  NEAR_AI_KEYS_URL,
  NEAR_AI_VERIFY_URL,
  PRIVATE_MODELS,
  verifiedChat,
  verifyModel,
  type AttestationResult,
  type ChatMessage,
  type VerifiedReply,
} from '@/lib/near-ai'
import { friendlyError } from '@/lib/format'
import { SPRING } from '@/lib/motion'
import { Notice, SectionLabel, Spinner } from '@/components/ui'

const KEY_STORAGE = 'zerith.nearai.key'
const MODEL_STORAGE = 'zerith.nearai.model'

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function writeStorage(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // storage unavailable: the key lives for this session only
  }
}

/** Today's date (UTC), for the system prompt. */
const todayUtc = () => new Date().toISOString().slice(0, 10)

interface Turn {
  role: 'user' | 'assistant'
  content: string
  signature?: VerifiedReply['signature']
}

function AttestationCard({ result, verifying, onRetry }: { result: AttestationResult | null; verifying: boolean; onRetry: () => void }) {
  const [open, setOpen] = useState(false)
  const ok = result?.ok
  return (
    <div className="box rounded-2xl p-4">
      <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`flex size-9 items-center justify-center rounded-full ${ok ? 'bg-ink text-canvas' : 'bg-[var(--raised)] text-ink-2'}`} aria-hidden>
          {verifying ? <Spinner /> : ok ? <ShieldCheck className="size-5" /> : <ShieldAlert className="size-5" />}
        </span>
        <span className="flex-1">
          <span className="block text-sm font-semibold text-ink">
            {verifying ? 'Verifying the TEE...' : ok ? 'Running in a verified TEE' : result ? 'TEE not verified' : 'Not verified yet'}
          </span>
          <span className="block text-xs text-ink-2">
            Intel TDX + NVIDIA confidential GPU, checked in your browser{result?.tcbStatus ? ` · TCB ${result.tcbStatus}` : ''}
          </span>
        </span>
        <ChevronDown className={`size-4 text-ink-2 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && result && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING.smooth}
            className="mt-3 space-y-1.5 overflow-hidden border-t border-line pt-3"
          >
            {result.checks.map((c) => (
              <li key={c.label} className="flex items-start gap-2 text-xs">
                <span className={c.ok ? 'text-ink' : 'text-danger'}>{c.ok ? '✓' : '✗'}</span>
                <span className="text-ink-2">
                  {c.label}
                  {c.detail && <span className="block break-all text-[11px] text-muted">{c.detail}</span>}
                </span>
              </li>
            ))}
            <li className="flex flex-wrap gap-3 pt-2 text-xs">
              <button type="button" className="underline underline-offset-2" onClick={onRetry}>
                Re-verify with a new nonce
              </button>
              <a className="underline underline-offset-2" href={NEAR_AI_VERIFY_URL} target="_blank" rel="noreferrer">
                Check independently on NEAR AI
              </a>
            </li>
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Private CFO: questions and reports over the user's private ledger, answered inside an attested TEE. */
export function Copilot() {
  const { notes, balance } = useShielded()
  const [apiKey, setApiKey] = useState(() => readStorage(KEY_STORAGE))
  const [keyDraft, setKeyDraft] = useState('')
  const [model, setModel] = useState(() => readStorage(MODEL_STORAGE) || PRIVATE_MODELS[0].id)
  const [attestation, setAttestation] = useState<AttestationResult | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [showData, setShowData] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const ledger = useMemo(() => buildLedger(notes, balance), [notes, balance])

  const verify = useCallback(async () => {
    setVerifying(true)
    try {
      setAttestation(await verifyModel(model))
    } catch (err) {
      setAttestation({ ok: false, model, signers: [], checks: [{ label: 'Attestation fetched', ok: false, detail: friendlyError(err) }], verifiedAt: Date.now() })
    } finally {
      setVerifying(false)
    }
  }, [model])

  // Verify on mount and whenever the model changes (deferred so it runs outside the render pass).
  useEffect(() => {
    const t = setTimeout(() => void verify(), 0)
    return () => clearTimeout(t)
  }, [verify])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [turns, busy])

  const saveKey = () => {
    const k = keyDraft.trim()
    if (!k) return
    writeStorage(KEY_STORAGE, k)
    setApiKey(k)
    setKeyDraft('')
  }

  const ask = async (question: string) => {
    const q = question.trim()
    if (!q || busy || !apiKey) return
    if (!attestation?.ok) {
      toast.error('The model is not verified yet, so your data was not sent.')
      return
    }
    const history: ChatMessage[] = turns.map((t) => ({ role: t.role, content: t.content }))
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT(ledger, todayUtc()) },
      ...history,
      { role: 'user', content: q },
    ]
    setTurns((t) => [...t, { role: 'user', content: q }])
    setInput('')
    setBusy(true)
    try {
      const reply = await verifiedChat({ apiKey, model, messages, attestation })
      setTurns((t) => [...t, { role: 'assistant', content: reply.content, signature: reply.signature }])
    } catch (err) {
      toast.error(friendlyError(err))
      setTurns((t) => t.slice(0, -1))
      setInput(q)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-4xl font-light text-ink">Private CFO</h2>
          <p className="mt-1 max-w-lg text-sm text-ink-2 text-pretty">
            Ask about your private payments or draft an audit summary. Your ledger is decrypted on this device and sent
            only to an AI model inside a hardware-verified enclave, never to Zerith.
          </p>
        </div>
        <select
          className="field w-auto text-sm"
          aria-label="Model"
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
            writeStorage(MODEL_STORAGE, e.target.value)
          }}
        >
          {PRIVATE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <AttestationCard result={attestation} verifying={verifying} onRetry={() => void verify()} />

      {!apiKey ? (
        <div className="mt-5 max-w-md space-y-3">
          <SectionLabel>Connect NEAR AI Cloud</SectionLabel>
          <p className="text-sm text-ink-2 text-pretty">
            Paste a NEAR AI Cloud API key. It stays in this browser and is sent only to NEAR AI.{' '}
            <a className="underline underline-offset-2" href={NEAR_AI_KEYS_URL} target="_blank" rel="noreferrer">
              Get a key
            </a>
          </p>
          <div className="flex gap-2">
            <input
              className="field flex-1"
              type="password"
              placeholder="sk-..."
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveKey()}
              autoComplete="off"
              aria-label="NEAR AI Cloud API key"
            />
            <button className="btn-primary" disabled={!keyDraft.trim()} onClick={saveKey}>
              <KeyRound className="size-4" aria-hidden /> Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-1 flex-col gap-3">
            {turns.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {QUICK_PROMPTS.map((p) => (
                  <button key={p} className="btn-ghost text-left text-xs" disabled={busy || !attestation?.ok} onClick={() => void ask(p)}>
                    <Sparkles className="size-3.5" aria-hidden /> {p}
                  </button>
                ))}
              </div>
            )}
            {turns.map((t, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={SPRING.smooth}
                className={t.role === 'user' ? 'ml-auto max-w-[85%] rounded-2xl bg-ink px-4 py-2.5 text-sm text-canvas' : 'box max-w-[95%] rounded-2xl px-4 py-3'}
              >
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{t.content}</p>
                {t.signature && (
                  <p className={`mt-2 flex items-center gap-1.5 text-[11px] ${t.signature.ok ? 'text-ink-2' : 'text-danger'}`} title={t.signature.signer}>
                    {t.signature.ok ? <BadgeCheck className="size-3.5" aria-hidden /> : <ShieldAlert className="size-3.5" aria-hidden />}
                    {t.signature.detail}
                    {t.signature.signer ? ` · ${t.signature.signer.slice(0, 10)}…` : ''}
                  </p>
                )}
              </motion.div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-sm text-ink-2">
                <Spinner /> Thinking inside the enclave...
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void ask(input)
            }}
          >
            <input
              className="field flex-1"
              placeholder={attestation?.ok ? 'Ask about your private payments...' : 'Waiting for TEE verification...'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
              aria-label="Question"
            />
            <button className="btn-primary" type="submit" disabled={busy || !input.trim() || !attestation?.ok}>
              Ask <ArrowRight className="btn-arrow size-4" aria-hidden />
            </button>
          </form>

          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-ink-2">
            <button type="button" className="flex items-center gap-1 underline-offset-2 hover:underline" onClick={() => setShowData((s) => !s)}>
              <Eye className="size-3.5" aria-hidden /> {showData ? 'Hide' : 'Show'} exactly what is shared
            </button>
            {turns.length > 0 && (
              <button type="button" className="flex items-center gap-1 underline-offset-2 hover:underline" onClick={() => setTurns([])}>
                <Trash2 className="size-3.5" aria-hidden /> Clear chat
              </button>
            )}
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => {
                writeStorage(KEY_STORAGE, '')
                setApiKey('')
              }}
            >
              Remove API key
            </button>
          </div>
          {showData && (
            <pre className="box mt-3 max-h-60 overflow-auto rounded-2xl p-3 text-[11px] leading-relaxed text-ink-2">{ledger}</pre>
          )}
        </>
      )}

      {notes.length === 0 && (
        <div className="mt-4">
          <Notice>You have no private notes yet. Shield some USDC first, then ask about your payments.</Notice>
        </div>
      )}
    </div>
  )
}
