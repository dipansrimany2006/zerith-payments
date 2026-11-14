import { useCallback, useState } from 'react'
import { useShielded } from '@/lib/shielded-context'
import { useWallet } from '@/lib/wallet'
import {
  payFromPrivate,
  sendPrivate,
  shield,
  shieldMany,
  withdraw,
  type ActionEnv,
  type PayRow,
  type RowResult,
  type Stage,
} from '@/lib/actions'

/**
 * Binds the Zerith flows to the current wallet and scan state, and tracks progress.
 * `stage` is null when idle. Shielding works without unlocked keys (e.g. paying a request link);
 * everything that spends notes needs them.
 */
export function useActions() {
  const shielded = useShielded()
  const { call, callMany } = useWallet()
  const [stage, setStage] = useState<Stage | null>(null)

  const run = useCallback(
    async <T,>(fn: (env: ActionEnv) => Promise<T>): Promise<T> => {
      const { keys, leaves, notes, relayer, waitForLeaves, snapshot } = shielded
      setStage({ step: 'download' })
      try {
        return await fn({ keys, leaves, notes, relayer, call, callMany, waitForLeaves, snapshot, onStage: setStage })
      } finally {
        setStage(null)
      }
    },
    [shielded, call, callMany],
  )

  return {
    stage,
    busy: stage !== null,
    shield: (p: Parameters<typeof shield>[1]) => run((env) => shield(env, p)),
    shieldMany: (rows: PayRow[]) => run((env) => shieldMany(env, rows)),
    sendPrivate: (p: Parameters<typeof sendPrivate>[1]) => run((env) => sendPrivate(env, p)),
    withdraw: (p: Parameters<typeof withdraw>[1]) => run((env) => withdraw(env, p)),
    payFromPrivate: (rows: PayRow[], onRow: (r: RowResult) => void) => run((env) => payFromPrivate(env, rows, onRow)),
  }
}

/** Short text for a progress stage. */
export function stageText(s: Stage): string {
  switch (s.step) {
    case 'download':
      return 'Loading the prover...'
    case 'prove':
      return `${s.label}: generating proof...`
    case 'sign':
      return 'Confirm in your wallet...'
    case 'relay':
      return `${s.label}: submitting...`
    case 'sync':
      return 'Waiting for NEAR to confirm...'
  }
}
