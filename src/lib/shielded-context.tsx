import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useWallet } from '@/lib/wallet'
import { POOL_ID, USDC_ID, provider } from '@/lib/near-config'
import { fetchNotes, view, type NoteView } from '@/lib/near-rpc'
import {
  KEY_DERIVATION_MESSAGE,
  KEY_DERIVATION_NONCE,
  KEY_DERIVATION_RECIPIENT,
  deriveKeysFromSignature,
  type ShieldedKeys,
} from '@/lib/shielded-keys'
import { tryDecryptUtxo, type Utxo } from '@/lib/zerith'

/** A note addressed to the unlocked keys. Zero-amount padding notes are skipped. */
export interface OwnedNote {
  utxo: Utxo
  commitment: bigint
  leafIndex: number
  memo: string
  timestampMs: number
  nullifier: bigint
  spent: boolean
}

export interface RelayerInfo {
  relayer: string
  minFee: bigint
  pool: string
}

interface ShieldedState {
  keys: ShieldedKeys | null
  unlocking: boolean
  unlock: () => Promise<void>
  lock: () => void
  /** Every commitment in the pool, in leaf order (the client copy of the tree). */
  leaves: bigint[]
  notes: OwnedNote[]
  /** Unspent shielded balance in USDC base units. */
  balance: bigint
  /** The connected account's public USDC balance, or null if unknown. */
  usdcBalance: bigint | null
  relayer: RelayerInfo | null
  refreshing: boolean
  loadedOnce: boolean
  error: string | null
  refresh: () => Promise<void>
  /** Polls until the pool has at least `count` leaves, then refreshes. */
  waitForLeaves: (count: number) => Promise<void>
  /** Latest scanned leaves and own notes, read synchronously (for multi-step flows). */
  snapshot: () => { leaves: bigint[]; notes: OwnedNote[] }
}

const ShieldedContext = createContext<ShieldedState | null>(null)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function ShieldedProvider({ children }: { children: ReactNode }) {
  const { accountId, signMessage } = useWallet()

  // Keys belong to one account: they are only visible while that account is connected.
  const [keyState, setKeyState] = useState<{ owner: string; keys: ShieldedKeys } | null>(null)
  const keys = keyState && keyState.owner === accountId ? keyState.keys : null
  const [unlocking, setUnlocking] = useState(false)
  const [leaves, setLeaves] = useState<bigint[]>([])
  const [notes, setNotes] = useState<OwnedNote[]>([])
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null)
  const [relayer, setRelayer] = useState<RelayerInfo | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Incremental cache of on-chain notes; only new leaves are fetched on each refresh.
  const cache = useRef<NoteView[]>([])
  const owned = useRef<{ keys: ShieldedKeys | null; scanned: number; notes: OwnedNote[] }>({ keys: null, scanned: 0, notes: [] })
  const busy = useRef(false)

  const unlock = useCallback(async () => {
    if (!accountId) throw new Error('Connect a NEAR wallet first')
    setUnlocking(true)
    try {
      const { signature } = await signMessage({
        message: KEY_DERIVATION_MESSAGE,
        recipient: KEY_DERIVATION_RECIPIENT,
        nonce: KEY_DERIVATION_NONCE,
      })
      setKeyState({ owner: accountId, keys: deriveKeysFromSignature(signature) })
    } finally {
      setUnlocking(false)
    }
  }, [accountId, signMessage])

  const lock = useCallback(() => {
    setKeyState(null)
    setNotes([])
    owned.current = { keys: null, scanned: 0, notes: [] }
  }, [])

  const refresh = useCallback(async () => {
    if (!POOL_ID || busy.current) return
    busy.current = true
    setRefreshing(true)
    try {
      const fresh = await fetchNotes(provider, POOL_ID, cache.current.length)
      cache.current = [...cache.current, ...fresh]
      setLeaves(cache.current.map((n) => BigInt(n.commitment)))

      if (accountId) {
        const bal = await view<string>(provider, USDC_ID, 'ft_balance_of', { account_id: accountId }).catch(() => null)
        setUsdcBalance(bal === null ? null : BigInt(bal))
      } else {
        setUsdcBalance(null)
      }

      if (keys) {
        if (owned.current.keys !== keys) owned.current = { keys, scanned: 0, notes: [] }
        // Trial-decrypt only notes we have not looked at yet.
        for (const n of cache.current.slice(owned.current.scanned)) {
          const found = tryDecryptUtxo(keys, n, BigInt(n.commitment), n.leaf_index)
          if (found && found.utxo.amount > 0n) {
            owned.current.notes.push({
              utxo: found.utxo,
              commitment: BigInt(n.commitment),
              leafIndex: n.leaf_index,
              memo: found.memo,
              timestampMs: Number(n.timestamp_ms),
              nullifier: found.utxo.nullifier(),
              spent: false,
            })
          }
        }
        owned.current.scanned = cache.current.length
        // Spent is final, so only unspent notes need checking again.
        await Promise.all(
          owned.current.notes
            .filter((n) => !n.spent)
            .map(async (n) => {
              n.spent = await view<boolean>(provider, POOL_ID, 'is_spent', { nullifier: n.nullifier.toString() })
            }),
        )
        setNotes([...owned.current.notes].sort((a, b) => b.leafIndex - a.leafIndex))
      }
      setError(null)
      setLoadedOnce(true)
    } catch (err) {
      setError(err instanceof Error ? err.message.split('\n')[0] : 'Could not load the pool')
    } finally {
      busy.current = false
      setRefreshing(false)
    }
  }, [accountId, keys])

  const waitForLeaves = useCallback(
    async (count: number) => {
      for (let i = 0; i < 30; i++) {
        const n = await view<number>(provider, POOL_ID, 'notes_count').catch(() => 0)
        if (n >= count) break
        await sleep(1000)
      }
      await refresh()
    },
    [refresh],
  )

  useEffect(() => {
    fetch('/api/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { relayer: string; minFee: string; pool: string } | null) => {
        if (info?.relayer) setRelayer({ relayer: info.relayer, minFee: BigInt(info.minFee), pool: info.pool })
      })
      .catch(() => undefined)
  }, [])

  // Load on mount and whenever the account or keys change, then poll gently.
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0)
    const id = setInterval(() => void refresh(), 20_000)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [refresh])

  const snapshot = useCallback(
    () => ({
      leaves: cache.current.map((n) => BigInt(n.commitment)),
      notes: owned.current.keys ? owned.current.notes.map((n) => ({ ...n })) : [],
    }),
    [],
  )

  const balance = useMemo(() => notes.filter((n) => !n.spent).reduce((s, n) => s + n.utxo.amount, 0n), [notes])

  const value = useMemo<ShieldedState>(
    () => ({
      keys,
      unlocking,
      unlock,
      lock,
      leaves,
      notes: keys ? notes : [],
      balance: keys ? balance : 0n,
      usdcBalance,
      relayer,
      refreshing,
      loadedOnce,
      error,
      refresh,
      waitForLeaves,
      snapshot,
    }),
    [keys, unlocking, unlock, lock, leaves, notes, balance, usdcBalance, relayer, refreshing, loadedOnce, error, refresh, waitForLeaves, snapshot],
  )

  return <ShieldedContext.Provider value={value}>{children}</ShieldedContext.Provider>
}

export function useShielded(): ShieldedState {
  const ctx = useContext(ShieldedContext)
  if (!ctx) throw new Error('useShielded must be used inside ShieldedProvider')
  return ctx
}
