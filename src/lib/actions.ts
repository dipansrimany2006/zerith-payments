/**
 * The three Zerith flows on NEAR, independent of the UI:
 *
 *  - shield:   wallet USDC -> a note for any shielded address (the user's own or someone else's).
 *              Sent by the user's wallet with usdc.ft_transfer_call; the deposit is public, the
 *              note's owner is not.
 *  - send:     note(s) -> a note for another shielded address. Sent by the relayer; nothing public
 *              links it to the user's account.
 *  - withdraw: note(s) -> USDC at any NEAR account. Sent by the relayer.
 *
 * Every transaction spends at most two notes. If two are not enough, notes are first merged
 * (each merge is one private transaction and pays the relayer fee).
 */
import { MerkleTree, Utxo, prepareTransaction, type PrepareParams, type ShieldedAddress } from '@/lib/zerith'
import { proveTransaction } from '@/lib/prover'
import { POOL_ID, USDC_ID } from '@/lib/near-config'
import type { FunctionCall } from '@/lib/wallet'
import type { OwnedNote, RelayerInfo } from '@/lib/shielded-context'
import type { ShieldedKeys } from '@/lib/shielded-keys'

export type Stage =
  | { step: 'download' }
  | { step: 'prove'; label: string }
  | { step: 'sign' }
  | { step: 'relay'; label: string }
  | { step: 'sync' }

export interface ActionEnv {
  /** Null when the user has not unlocked; only shielding works then. */
  keys: ShieldedKeys | null
  leaves: bigint[]
  notes: OwnedNote[]
  relayer: RelayerInfo | null
  /** Wallet function call (for deposits). */
  call: (fc: FunctionCall) => Promise<string>
  /** Several wallet transactions with one approval where supported. */
  callMany: (fcs: FunctionCall[]) => Promise<string[]>
  waitForLeaves: (count: number) => Promise<void>
  /** Latest leaves and notes after a refresh; used between merge steps. */
  snapshot: () => { leaves: bigint[]; notes: OwnedNote[] }
  onStage?: (s: Stage) => void
}

const GAS_300T = '300000000000000'

function treeOf(leaves: bigint[]) {
  const t = new MerkleTree()
  for (const l of leaves) t.insert(l)
  return t
}

const shuffle = <T,>(a: T[]): T[] => (Math.random() < 0.5 ? a : [...a].reverse())

async function relay(body: unknown): Promise<string> {
  const res = await fetch('/api/transact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string }
  if (!res.ok || !data.txHash) throw new Error(data.error ?? `Relayer error (${res.status})`)
  return data.txHash
}

async function proveAndRelay(env: ActionEnv, params: Omit<PrepareParams, 'tree'>, label: string, leaves: bigint[]) {
  env.onStage?.({ step: 'prove', label })
  const prepared = prepareTransaction({ ...params, tree: treeOf(leaves) })
  const proof_args = await proveTransaction(prepared)
  env.onStage?.({ step: 'relay', label })
  const txHash = await relay({ proof_args, ext_data: prepared.extData })
  env.onStage?.({ step: 'sync' })
  await env.waitForLeaves(leaves.length + 2)
  return txHash
}

function requireKeys(env: ActionEnv): ShieldedKeys {
  if (!env.keys) throw new Error('Unlock your Zerith keys first')
  return env.keys
}

function requireRelayer(env: ActionEnv): RelayerInfo {
  if (!env.relayer) throw new Error('The relayer is offline. Try again in a moment.')
  return env.relayer
}

/**
 * Returns at most two unspent notes worth at least `need`, merging notes first when necessary.
 * Each merge costs one relayer fee, which is accounted for up front.
 */
async function selectInputs(env: ActionEnv, need: bigint): Promise<Utxo[]> {
  const fee = requireRelayer(env).minFee
  const keys = requireKeys(env)
  for (let round = 0; ; round++) {
    // Always read the latest scan: earlier steps (merges, previous payroll rows) change the notes.
    const { leaves, notes } = env.snapshot()
    const unspent = notes.filter((n) => !n.spent).sort((a, b) => (b.utxo.amount > a.utxo.amount ? 1 : -1))
    const total = unspent.reduce((s, n) => s + n.utxo.amount, 0n)
    const merges = BigInt(Math.max(0, unspent.length - 2))
    if (total < need) throw new Error('Not enough private balance for this amount plus fees.')

    const single = [...unspent].reverse().find((n) => n.utxo.amount >= need)
    if (single) return [single.utxo]
    if (unspent.length >= 2 && unspent[0].utxo.amount + unspent[1].utxo.amount >= need) {
      return [unspent[0].utxo, unspent[1].utxo]
    }
    if (total - merges * fee < need) throw new Error('Not enough private balance once note-merging fees are included.')

    // Merge the two largest notes into one, then try again.
    const [a, b] = unspent
    const merged = Utxo.owned(a.utxo.amount + b.utxo.amount - fee, keys)
    await proveAndRelay(
      env,
      {
        inputs: [a.utxo, b.utxo],
        outputs: [{ utxo: merged, to: keys, memo: 'merge' }],
        extAmount: 0n,
        fee,
        relayer: env.relayer!.relayer,
      },
      `Merging notes (${round + 1})`,
      leaves,
    )
  }
}

/** Wallet USDC -> one note for `to`. */
export async function shield(env: ActionEnv, p: { amount: bigint; to: ShieldedAddress; memo?: string }): Promise<string> {
  if (p.amount <= 0n) throw new Error('Enter an amount')
  env.onStage?.({ step: 'prove', label: 'Preparing the deposit' })
  const prepared = prepareTransaction({
    tree: treeOf(env.leaves),
    inputs: [],
    outputs: [{ utxo: new Utxo(p.amount, p.to.ownerPub), to: p.to, memo: p.memo }],
    extAmount: p.amount,
  })
  const proof_args = await proveTransaction(prepared)
  env.onStage?.({ step: 'sign' })
  const txHash = await env.call({
    receiverId: USDC_ID,
    methodName: 'ft_transfer_call',
    args: {
      receiver_id: POOL_ID,
      amount: p.amount.toString(),
      msg: JSON.stringify({ proof_args, ext_data: prepared.extData }),
    },
    gas: GAS_300T,
    deposit: '1',
  })
  env.onStage?.({ step: 'sync' })
  await env.waitForLeaves(env.leaves.length + 2)
  return txHash
}

/** Private notes -> a note for another shielded address, through the relayer. */
export async function sendPrivate(env: ActionEnv, p: { amount: bigint; to: ShieldedAddress; memo?: string }): Promise<string> {
  if (p.amount <= 0n) throw new Error('Enter an amount')
  const { minFee, relayer } = requireRelayer(env)
  const keys = requireKeys(env)
  const inputs = await selectInputs(env, p.amount + minFee)
  const { leaves } = env.snapshot()
  const change = inputs.reduce((s, u) => s + u.amount, 0n) - p.amount - minFee
  return proveAndRelay(
    env,
    {
      inputs,
      outputs: shuffle([
        { utxo: new Utxo(p.amount, p.to.ownerPub), to: p.to, memo: p.memo },
        { utxo: Utxo.owned(change, keys), to: keys },
      ]),
      extAmount: 0n,
      fee: minFee,
      relayer,
    },
    'Sending privately',
    leaves,
  )
}

/** Private notes -> USDC at a NEAR account, through the relayer. */
export async function withdraw(env: ActionEnv, p: { amount: bigint; recipient: string }): Promise<string> {
  if (p.amount <= 0n) throw new Error('Enter an amount')
  const { minFee, relayer } = requireRelayer(env)
  const keys = requireKeys(env)
  const inputs = await selectInputs(env, p.amount + minFee)
  const { leaves } = env.snapshot()
  const change = inputs.reduce((s, u) => s + u.amount, 0n) - p.amount - minFee
  return proveAndRelay(
    env,
    {
      inputs,
      outputs: [{ utxo: Utxo.owned(change, keys), to: keys }],
      extAmount: -p.amount,
      fee: minFee,
      relayer,
      recipient: p.recipient,
    },
    'Withdrawing',
    leaves,
  )
}

// ------------------------------------------------------------------ batches

/** One payment in a batch: a shielded address, or (private source only) a NEAR account. */
export type PayTarget = { kind: 'shielded'; to: ShieldedAddress } | { kind: 'account'; accountId: string }

export interface PayRow {
  target: PayTarget
  amount: bigint
  memo?: string
}

/** Max wallet transactions per batch: all proofs use one root, which the pool keeps for 30 txs. */
export const MAX_SHIELD_TXS = 25

/**
 * Wallet USDC -> notes for many shielded addresses. Two recipients per deposit (the circuit has two
 * outputs), all proved up front against the same root and sent with one wallet approval.
 */
export async function shieldMany(env: ActionEnv, rows: PayRow[]): Promise<string[]> {
  if (!rows.length) throw new Error('Nothing to pay')
  const targets = rows.map((r) => {
    if (r.target.kind !== 'shielded') throw new Error('Paying NEAR accounts needs the private balance as the source')
    if (r.amount <= 0n) throw new Error('Every amount must be positive')
    return { ...r, to: r.target.to }
  })
  const pairs: (typeof targets)[] = []
  for (let i = 0; i < targets.length; i += 2) pairs.push(targets.slice(i, i + 2))
  if (pairs.length > MAX_SHIELD_TXS) throw new Error(`At most ${MAX_SHIELD_TXS * 2} recipients per wallet batch`)

  const tree = treeOf(env.leaves)
  const calls: FunctionCall[] = []
  for (const [i, pair] of pairs.entries()) {
    env.onStage?.({ step: 'prove', label: `Preparing deposit ${i + 1} of ${pairs.length}` })
    const total = pair.reduce((s, r) => s + r.amount, 0n)
    const prepared = prepareTransaction({
      tree,
      inputs: [],
      outputs: pair.map((r) => ({ utxo: new Utxo(r.amount, r.to.ownerPub), to: r.to, memo: r.memo })),
      extAmount: total,
    })
    const proof_args = await proveTransaction(prepared)
    calls.push({
      receiverId: USDC_ID,
      methodName: 'ft_transfer_call',
      args: { receiver_id: POOL_ID, amount: total.toString(), msg: JSON.stringify({ proof_args, ext_data: prepared.extData }) },
      gas: GAS_300T,
      deposit: '1',
    })
  }
  env.onStage?.({ step: 'sign' })
  const hashes = await env.callMany(calls)
  env.onStage?.({ step: 'sync' })
  await env.waitForLeaves(env.leaves.length + 2 * pairs.length)
  return hashes
}

export interface RowResult {
  index: number
  ok: boolean
  txHash?: string
  error?: string
}

/**
 * Private balance -> many recipients, one relayed transaction each (shielded addresses get a
 * private note, NEAR accounts a withdrawal). Stops at the first failure so nothing is paid twice.
 */
export async function payFromPrivate(
  env: ActionEnv,
  rows: PayRow[],
  onRow: (r: RowResult) => void,
): Promise<RowResult[]> {
  const results: RowResult[] = []
  for (const [index, row] of rows.entries()) {
    try {
      const rowEnv = { ...env, onStage: (s: Stage) => env.onStage?.(s.step === 'prove' || s.step === 'relay' ? { ...s, label: `Payment ${index + 1} of ${rows.length}` } : s) }
      const txHash =
        row.target.kind === 'shielded'
          ? await sendPrivate(rowEnv, { amount: row.amount, to: row.target.to, memo: row.memo })
          : await withdraw(rowEnv, { amount: row.amount, recipient: row.target.accountId })
      const r = { index, ok: true, txHash }
      results.push(r)
      onRow(r)
    } catch (err) {
      const r = { index, ok: false, error: err instanceof Error ? err.message : String(err) }
      results.push(r)
      onRow(r)
      break
    }
  }
  return results
}
