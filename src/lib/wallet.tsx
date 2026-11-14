/**
 * NEAR wallet connection through NEAR Connect (@hot-labs/near-connect): HOT, Meteor, Intear,
 * MyNearWallet, Nightly, OKX and others, each running in a sandboxed iframe.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { NearConnector, type NearWalletBase } from '@hot-labs/near-connect'
import { IS_TESTNET, NEAR_NETWORK } from '@/lib/near-config'

export interface FunctionCall {
  receiverId: string
  methodName: string
  args: object
  /** Gas in units (e.g. 300 Tgas = 300_000_000_000_000). */
  gas: string
  /** Attached deposit in yoctoNEAR. */
  deposit: string
}

interface WalletState {
  accountId: string | null
  /** Wallet name, e.g. "Meteor Wallet". */
  walletName: string | null
  connecting: boolean
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  /** NEP-413 message signing. Returns the raw ed25519 signature (64 bytes) and the signing key. */
  signMessage: (params: { message: string; recipient: string; nonce: Uint8Array }) => Promise<{ signature: Uint8Array; publicKey: string }>
  /** Signs and sends one function call; resolves with the transaction hash. */
  call: (fc: FunctionCall) => Promise<string>
  /**
   * Signs and sends several transactions with one wallet approval when the wallet supports it
   * (falls back to one approval each). Resolves with the hashes in order.
   */
  callMany: (fcs: FunctionCall[]) => Promise<string[]>
}

type Outcome = {
  status?: unknown
  transaction: { hash: string }
  receipts_outcome?: { outcome: { status: unknown } }[]
}

/** Throws if the transaction or any of its receipts failed (e.g. the pool's ft_on_transfer). */
function checkOutcome(outcome: Outcome): string {
  const status = outcome?.status as { Failure?: unknown } | undefined
  if (status && typeof status === 'object' && 'Failure' in status) throw new Error(JSON.stringify(status.Failure))
  const failed = outcome?.receipts_outcome?.find((r) => {
    const s = r.outcome.status as { Failure?: unknown }
    return typeof s === 'object' && s && 'Failure' in s
  })
  if (failed) throw new Error(JSON.stringify((failed.outcome.status as { Failure: unknown }).Failure))
  return outcome.transaction.hash
}

const toAction = (fc: FunctionCall) => ({
  type: 'FunctionCall' as const,
  params: { methodName: fc.methodName, args: fc.args, gas: fc.gas, deposit: fc.deposit },
})

const WalletContext = createContext<WalletState | null>(null)

let connectorSingleton: NearConnector | null = null
function getConnector(): NearConnector {
  connectorSingleton ??= new NearConnector({
    network: NEAR_NETWORK,
    features: { signMessage: true, signAndSendTransaction: true, ...(IS_TESTNET ? { testnet: true } : { mainnet: true }) },
    footerBranding: null,
  })
  return connectorSingleton
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Decode(s: string): Uint8Array {
  let n = 0n
  for (const ch of s) {
    const i = BASE58.indexOf(ch)
    if (i < 0) throw new Error('Invalid base58')
    n = n * 58n + BigInt(i)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  for (const ch of s) {
    if (ch !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

/** NEP-413 says base64, but some wallets return "ed25519:<base58>". Normalize to 64 raw bytes. */
export function decodeSignature(sig: string): Uint8Array {
  const s = sig.trim()
  if (s.startsWith('ed25519:')) return base58Decode(s.slice(8))
  try {
    const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
    if (b.length === 64) return b
  } catch {
    // not base64
  }
  return base58Decode(s)
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<NearWalletBase | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    const connector = getConnector()
    const onIn = (e: { wallet: NearWalletBase; accounts: { accountId: string }[] }) => {
      setWallet(e.wallet)
      setAccountId(e.accounts[0]?.accountId ?? null)
    }
    const onOut = () => {
      setWallet(null)
      setAccountId(null)
    }
    connector.on('wallet:signIn', onIn)
    connector.on('wallet:signOut', onOut)
    // Restore a previous session.
    connector
      .getConnectedWallet()
      .then(({ wallet: w, accounts }) => {
        setWallet(w)
        setAccountId(accounts[0]?.accountId ?? null)
      })
      .catch(() => undefined)
    return () => {
      connector.off('wallet:signIn', onIn)
      connector.off('wallet:signOut', onOut)
    }
  }, [])

  const connect = useCallback(async () => {
    setConnecting(true)
    try {
      await getConnector().connect()
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    await getConnector().disconnect().catch(() => undefined)
    setWallet(null)
    setAccountId(null)
  }, [])

  const signMessage = useCallback<WalletState['signMessage']>(
    async ({ message, recipient, nonce }) => {
      if (!wallet || !accountId) throw new Error('Connect a NEAR wallet first')
      const signed = await wallet.signMessage({ message, recipient, nonce, signerId: accountId, network: NEAR_NETWORK })
      if (signed.accountId && signed.accountId !== accountId) throw new Error('The wallet signed with a different account')
      return { signature: decodeSignature(signed.signature), publicKey: signed.publicKey }
    },
    [wallet, accountId],
  )

  const call = useCallback<WalletState['call']>(
    async (fc) => {
      if (!wallet || !accountId) throw new Error('Connect a NEAR wallet first')
      const outcome = await wallet.signAndSendTransaction({
        signerId: accountId,
        receiverId: fc.receiverId,
        network: NEAR_NETWORK,
        actions: [toAction(fc)],
      })
      return checkOutcome(outcome as unknown as Outcome)
    },
    [wallet, accountId],
  )

  const callMany = useCallback<WalletState['callMany']>(
    async (fcs) => {
      if (!wallet || !accountId) throw new Error('Connect a NEAR wallet first')
      if (fcs.length === 1 || !wallet.manifest.features?.signAndSendTransactions) {
        const hashes: string[] = []
        for (const fc of fcs) hashes.push(await call(fc))
        return hashes
      }
      const outcomes = await wallet.signAndSendTransactions({
        signerId: accountId,
        network: NEAR_NETWORK,
        transactions: fcs.map((fc) => ({ receiverId: fc.receiverId, actions: [toAction(fc)] })),
      })
      return outcomes.map((o) => checkOutcome(o as unknown as Outcome))
    },
    [wallet, accountId, call],
  )

  const value = useMemo<WalletState>(
    () => ({
      accountId,
      walletName: wallet?.manifest.name ?? null,
      connecting,
      connect,
      disconnect,
      signMessage,
      call,
      callMany,
    }),
    [accountId, wallet, connecting, connect, disconnect, signMessage, call, callMany],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider')
  return ctx
}
