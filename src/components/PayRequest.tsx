import { useState } from 'react'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useWallet } from '@/lib/wallet'
import { useShielded } from '@/lib/shielded-context'
import { stageText, useActions } from '@/lib/use-actions'
import { requestMemo, type IncomingRequest } from '@/lib/payment-request'
import { IS_TESTNET, USDC_FAUCET_URL, txUrl } from '@/lib/near-config'
import { shortAddress } from '@/lib/shielded-keys'
import { friendlyError, usdcText } from '@/lib/format'
import { Notice, Row, Spinner, SuccessMark } from '@/components/ui'

/**
 * Opened from a payment link (#pay?...). The payer needs only a NEAR wallet with USDC: paying
 * shields USDC straight into a note for the requester, so no Zerith unlock is required.
 */
export function PayRequest({ request, onDone }: { request: IncomingRequest; onDone: () => void }) {
  const { accountId, connect, connecting } = useWallet()
  const { usdcBalance, keys, balance, relayer } = useShielded()
  const actions = useActions()
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const memo = requestMemo(request)
  const fee = relayer?.minFee ?? 0n
  const canPayPrivately = !!keys && !!relayer && balance >= request.amount + fee

  const pay = async (fromPrivate: boolean) => {
    setError(null)
    try {
      const hash = fromPrivate
        ? await actions.sendPrivate({ amount: request.amount, to: request.to, memo })
        : await actions.shield({ amount: request.amount, to: request.to, memo })
      setTxHash(hash)
      toast.success('Paid privately')
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  if (txHash) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center gap-4 py-8">
        <SuccessMark />
        <h2 className="font-display text-4xl font-light text-ink">Paid</h2>
        <p className="max-w-md text-sm text-ink-2">
          {usdcText(request.amount)} USDC is now in {request.label ?? 'the recipient'}’s private balance. Only they can see it.
        </p>
        <a className="mono text-xs underline" href={txUrl(txHash)} target="_blank" rel="noreferrer">
          View transaction
        </a>
        <button className="btn-ghost" onClick={onDone}>
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col justify-center py-6">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-2">Payment request</p>
      <h2 className="mt-2 font-display text-5xl font-light text-ink">
        {usdcText(request.amount)} <span className="text-2xl text-muted">USDC</span>
      </h2>
      <p className="mt-2 text-sm text-ink-2">
        to <span className="font-semibold text-ink">{request.label ?? 'a Zerith address'}</span>
        {request.memo && <> · {request.memo}</>}
      </p>

      <div className="mt-5 max-w-md rounded-2xl border border-line p-4">
        <Row label="Recipient" value={<span className="mono text-xs">{shortAddress(request.toText)}</span>} />
        <Row label="Amount" value={`${usdcText(request.amount)} USDC`} strong />
        <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-2 text-pretty">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          The payment becomes an encrypted note only the recipient can open. On-chain, nobody can see who it went to.
        </p>
      </div>

      <div className="mt-5 max-w-md space-y-3">
        {!accountId ? (
          <button className="btn-primary" disabled={connecting} onClick={() => void connect()}>
            {connecting ? 'Connecting...' : 'Connect NEAR wallet to pay'} <ArrowRight className="btn-arrow size-4" aria-hidden />
          </button>
        ) : (
          <>
            <button className="btn-primary w-full" disabled={actions.busy || (usdcBalance !== null && usdcBalance < request.amount)} onClick={() => void pay(false)}>
              {actions.busy ? (
                <>
                  <Spinner /> {actions.stage ? stageText(actions.stage) : 'Working...'}
                </>
              ) : (
                <>
                  Pay from wallet ({usdcBalance === null ? '…' : usdcText(usdcBalance)} USDC) <ArrowRight className="btn-arrow size-4" aria-hidden />
                </>
              )}
            </button>
            {canPayPrivately && (
              <button className="btn-ghost w-full" disabled={actions.busy} onClick={() => void pay(true)}>
                Pay from private balance (+{usdcText(fee)} fee, no public trail)
              </button>
            )}
            {usdcBalance !== null && usdcBalance < request.amount && (
              <Notice tone="warn">
                Your wallet has {usdcText(usdcBalance)} USDC.{' '}
                {IS_TESTNET && (
                  <a className="underline" href={USDC_FAUCET_URL} target="_blank" rel="noreferrer">
                    Get testnet USDC
                  </a>
                )}
              </Notice>
            )}
          </>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <button className="text-xs text-ink-2 underline-offset-2 hover:underline" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}
