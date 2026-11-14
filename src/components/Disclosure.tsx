import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { Download, Eye, EyeOff, FileCheck2 } from 'lucide-react'
import { toast } from 'sonner'
import { NEAR_NETWORK, POOL_ID, provider } from '@/lib/near-config'
import { useShielded } from '@/lib/shielded-context'
import { decodeSignature, useWallet } from '@/lib/wallet'
import { friendlyError, timeAgo, usdcText } from '@/lib/format'
import { DURATION, SPRING, STAGGER } from '@/lib/motion'
import { CopyButton, Notice, SectionLabel, Spinner } from '@/components/ui'

/** Sections rise in one after another. */
const rise = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { ...SPRING.smooth, delay: i * STAGGER.normal * 1.5 },
})

interface ReportEntry {
  direction: 'received'
  amountUsdc: string
  /** USDC base units (6 decimals). */
  amount: string
  memo: string
  /** Note commitment (decimal field element), checkable against the pool's leaves. */
  commitment: string
  leafIndex: number
  timestampMs: number
}

interface Report {
  version: 2
  network: string
  pool: string
  generatedAt: string
  /** NEAR account that signed the report (absent on a plain report). */
  signer?: string
  publicKey?: string
  /** NEP-413 fields: base64 nonce and signature over reportMessage(hash). */
  nonce?: string
  recipient?: string
  signature?: string
  entries: ReportEntry[]
  hash: string
}

// Protocol strings: signed reports are verified against them.
const REPORT_RECIPIENT = 'zerith-report'
const reportMessage = (hash: string) => `Zerith private USDC payment report\nSHA-256: ${hash}`
const hashEntries = (entries: ReportEntry[]) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(entries))))

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
const borshString = (s: string) => {
  const bytes = utf8ToBytes(s)
  return concatBytes(u32le(bytes.length), bytes)
}

/** NEP-413: sha256(borsh(2^31 + 413) || borsh({ message, nonce, recipient, callbackUrl: None })). */
function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  return sha256(concatBytes(u32le(2 ** 31 + 413), borshString(message), nonce, borshString(recipient), new Uint8Array([0])))
}

function saveJson(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function Disclosure() {
  const { keys, notes, leaves, refresh } = useShielded()
  const { accountId, signMessage } = useWallet()

  const [revealed, setRevealed] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [signing, setSigning] = useState(false)
  const [pasted, setPasted] = useState('')
  const [checking, setChecking] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; lines: string[] } | null>(null)

  const candidates = useMemo<ReportEntry[]>(
    () =>
      notes
        .filter((n) => n.memo !== 'merge')
        .map((n) => ({
          direction: 'received' as const,
          amountUsdc: usdcText(n.utxo.amount),
          amount: n.utxo.amount.toString(),
          memo: n.memo,
          commitment: n.commitment.toString(),
          leafIndex: n.leafIndex,
          timestampMs: n.timestampMs,
        }))
        .sort((a, b) => b.timestampMs - a.timestampMs),
    [notes],
  )

  const keyOf = (e: ReportEntry) => e.commitment
  const toggle = (k: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const build = (): Omit<Report, 'signer' | 'publicKey' | 'nonce' | 'recipient' | 'signature'> | null => {
    const entries = candidates.filter((e) => picked.has(keyOf(e)))
    if (!entries.length) return null
    return { version: 2, network: NEAR_NETWORK, pool: POOL_ID, generatedAt: new Date().toISOString(), entries, hash: hashEntries(entries) }
  }

  const downloadPlain = () => {
    const report = build()
    if (report) saveJson(report, `zerith-report-${Date.now()}.json`)
  }

  const downloadSigned = async () => {
    const base = build()
    if (!base || !accountId) return
    setSigning(true)
    try {
      const nonce = crypto.getRandomValues(new Uint8Array(32))
      const { signature, publicKey } = await signMessage({ message: reportMessage(base.hash), recipient: REPORT_RECIPIENT, nonce })
      const report: Report = { ...base, signer: accountId, publicKey, nonce: b64(nonce), recipient: REPORT_RECIPIENT, signature: b64(signature) }
      saveJson(report, `zerith-report-signed-${Date.now()}.json`)
    } catch (err) {
      toast.error(friendlyError(err))
    } finally {
      setSigning(false)
    }
  }

  const verify = async () => {
    setVerifyResult(null)
    let report: Report
    try {
      report = JSON.parse(pasted) as Report
      if (!Array.isArray(report.entries) || typeof report.hash !== 'string') throw new Error('bad')
    } catch {
      setVerifyResult({ ok: false, lines: ['That does not look like a report file.'] })
      return
    }
    setChecking(true)
    try {
      await refresh()
      const lines: string[] = []
      const hashOk = hashEntries(report.entries) === report.hash
      lines.push(hashOk ? 'Report contents match the hash.' : 'Report contents were changed after it was made.')
      let ok = hashOk
      if (report.pool && report.pool !== POOL_ID) {
        lines.push(`Report is for pool ${report.pool}, this app checks ${POOL_ID}.`)
        ok = false
      }

      if (report.signature && report.signer && report.publicKey && report.nonce) {
        let sigOk = false
        try {
          const digest = nep413Hash(reportMessage(report.hash), unb64(report.nonce), report.recipient ?? REPORT_RECIPIENT)
          sigOk = ed25519.verify(unb64(report.signature), digest, decodeSignature(report.publicKey))
        } catch {
          sigOk = false
        }
        let keyOk = false
        if (sigOk) {
          keyOk = await provider
            .viewAccessKey({ accountId: report.signer, publicKey: report.publicKey })
            .then(() => true)
            .catch(() => false)
        }
        lines.push(
          !sigOk
            ? 'Signature does not match the report.'
            : keyOk
              ? `Signed by ${report.signer}.`
              : `Signature is valid, but that key is not (or no longer) an access key of ${report.signer}.`,
        )
        ok = ok && sigOk && keyOk
      } else {
        lines.push('Plain report: not signed, so it does not prove who made it.')
      }

      // Read the latest leaves straight from the pool so the check does not depend on this session.
      const onChain = new Map<number, string>()
      await Promise.all(
        report.entries.map(async (e) => {
          const page = await provider
            .callFunction({ contractId: POOL_ID, method: 'get_notes', args: { from_index: e.leafIndex, limit: 1 } })
            .catch(() => null)
          const note = (page as { commitment: string }[] | null)?.[0]
          if (note) onChain.set(e.leafIndex, BigInt(note.commitment).toString())
          else if (leaves[e.leafIndex] !== undefined) onChain.set(e.leafIndex, leaves[e.leafIndex].toString())
        }),
      )
      for (const e of report.entries) {
        const found = onChain.get(e.leafIndex) === BigInt(e.commitment).toString()
        lines.push(`${found ? 'In the pool' : 'NOT FOUND'}: ${e.amountUsdc} USDC, note #${e.leafIndex}${e.memo ? ` (${e.memo})` : ''}`)
        ok = ok && found
      }
      setVerifyResult({ ok, lines })
    } catch (err) {
      setVerifyResult({ ok: false, lines: [friendlyError(err)] })
    } finally {
      setChecking(false)
    }
  }

  if (!keys) return null
  const viewingKey = bytesToHex(keys.viewPriv)

  return (
    <div className="space-y-4">
      <motion.section {...rise(0)} className="box rounded-2xl p-5">
        <SectionLabel>Viewing key</SectionLabel>
        <p className="text-sm leading-relaxed text-ink-2 text-pretty">
          Anyone with this key can read every payment sent to you, including amounts and memos. It cannot spend or withdraw. Share it only with someone you trust, such as an auditor.
        </p>
        <div className="panel mt-3 overflow-hidden rounded-xl p-3">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={revealed ? 'shown' : 'hidden'}
              initial={{ opacity: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: 'blur(4px)' }}
              transition={{ duration: DURATION.crossFade }}
              className="mono break-all text-xs text-ink"
            >
              {revealed ? viewingKey : '•'.repeat(48)}
            </motion.p>
          </AnimatePresence>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" onClick={() => setRevealed((v) => !v)}>
            {revealed ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />} {revealed ? 'Hide' : 'Reveal'}
          </button>
          {revealed && <CopyButton value={viewingKey} label="Copy key" />}
        </div>
        <div className="mt-3">
          <Notice tone="warn">A shared viewing key cannot be taken back. To stop someone seeing future payments, use a different wallet key.</Notice>
        </div>
      </motion.section>

      <motion.section {...rise(1)} className="box rounded-2xl p-5">
        <SectionLabel>Payment report</SectionLabel>
        <p className="mb-3 text-sm text-ink-2 text-pretty">
          Pick the payments you received that you want to prove. Each entry can be matched to a note in the pool on NEAR. Sign the report with your wallet to prove it came from your account.
        </p>
        {candidates.length === 0 ? (
          <p className="text-sm text-ink-2">No payments found for your keys yet.</p>
        ) : (
          <ul className="space-y-1">
            {candidates.map((e) => {
              const k = keyOf(e)
              const on = picked.has(k)
              return (
                <li key={k}>
                  <label className={`row-hover flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ${on ? 'bg-surface' : ''}`}>
                    <input type="checkbox" className="size-4 accent-[color:var(--ink)]" checked={on} onChange={() => toggle(k)} />
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-display text-lg tabular-nums text-ink">+{e.amountUsdc} USDC</span>
                      <span className="block truncate text-[11px] text-ink-2">
                        {e.memo || 'no memo'} · {timeAgo(e.timestampMs)}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className="btn-ghost" disabled={picked.size === 0 || signing} onClick={downloadPlain}>
            <Download className="size-4" aria-hidden /> Plain report
          </button>
          <button className="btn-primary" disabled={picked.size === 0 || signing || !accountId} onClick={() => void downloadSigned()}>
            {signing ? (
              <>
                <Spinner /> Confirm in wallet...
              </>
            ) : (
              <>
                <Download className="size-4" aria-hidden /> Sign and download
              </>
            )}
          </button>
        </div>
      </motion.section>

      <motion.section {...rise(2)} className="box rounded-2xl p-5">
        <SectionLabel>Check a report</SectionLabel>
        <label htmlFor="report" className="mb-3 block text-sm text-ink-2 text-pretty">
          Paste a report file to check its signature and confirm each payment exists in the pool ({leaves.length} notes loaded).
        </label>
        <textarea id="report" className="field mono h-28 py-3 text-xs" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"version":2,...}' spellCheck={false} />
        <div className="mt-3">
          <button className="btn-ghost" disabled={!pasted.trim() || checking} onClick={() => void verify()}>
            {checking ? <Spinner /> : <FileCheck2 className="size-4" aria-hidden />} Check report
          </button>
        </div>
        {verifyResult && (
          <div className="mt-3">
            <Notice tone={verifyResult.ok ? 'info' : 'error'}>
              <strong>{verifyResult.ok ? 'Report is valid.' : 'Report did not check out.'}</strong>
              {verifyResult.lines.map((l) => (
                <span key={l} className="block">{l}</span>
              ))}
            </Notice>
          </div>
        )}
      </motion.section>
    </div>
  )
}
