import { motion } from 'framer-motion'
import { ArrowDownLeft, Check, Repeat2, type LucideIcon } from 'lucide-react'
import { useShielded, type OwnedNote } from '@/lib/shielded-context'
import { timeAgo, usdcText } from '@/lib/format'
import { SPRING, STAGGER } from '@/lib/motion'
import { Badge, SectionLabel } from '@/components/ui'

const LIMIT = 6

/** Merge notes are created by the app when it combines two of your notes; they carry this memo. */
const isMerge = (n: OwnedNote) => n.memo === 'merge'

function kindOf(n: OwnedNote): { label: string; icon: LucideIcon } {
  if (isMerge(n)) return { label: 'Notes merged', icon: Repeat2 }
  if (n.spent) return { label: 'Spent', icon: Check }
  return { label: 'Received', icon: ArrowDownLeft }
}

function ActivityRow({ note, index }: { note: OwnedNote; index: number }) {
  const kind = kindOf(note)
  const Icon = kind.icon
  const memo = note.memo && !isMerge(note) ? note.memo : ''
  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING.smooth, delay: index * STAGGER.tight }}
      className="row-hover group -mx-3 flex items-center gap-3 rounded-2xl px-3 py-2.5"
      aria-label={`${kind.label} ${usdcText(note.utxo.amount)} USDC, ${timeAgo(note.timestampMs)}`}
    >
      <span className="transition-transform duration-300 group-hover:scale-105">
        <Badge>
          <Icon className="size-4" />
        </Badge>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{kind.label}</p>
        <p className="truncate text-[11px] text-ink-2">{memo ? `“${memo}”` : note.spent ? 'Used in a payment' : 'Available'}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`font-display text-base leading-tight tabular-nums ${note.spent ? 'text-muted line-through' : 'text-ink'}`}>
          {usdcText(note.utxo.amount)}
        </p>
        <p className="text-[11px] text-ink-2">{timeAgo(note.timestampMs)}</p>
      </div>
    </motion.li>
  )
}

function Placeholder({ children }: { children: string }) {
  return <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-xs text-ink-2 text-pretty">{children}</p>
}

/** Your private notes, newest first, decrypted in this browser. Nobody else can see them. */
export function Activity() {
  const { keys, notes, loadedOnce, error } = useShielded()

  let body
  if (!keys) {
    body = <Placeholder>Unlock to see your private activity. It is decrypted only in this browser.</Placeholder>
  } else if (!loadedOnce && !error) {
    body = (
      <ul aria-label="Loading activity" className="space-y-3">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3 py-1.5">
            <span className="skeleton size-10 rounded-full" />
            <span className="flex-1 space-y-1.5">
              <span className="skeleton block h-3 w-20" />
              <span className="skeleton block h-2.5 w-28" />
            </span>
            <span className="skeleton h-4 w-12" />
          </li>
        ))}
      </ul>
    )
  } else if (error && !loadedOnce) {
    body = <Placeholder>Could not load your activity. It will retry on the next scan.</Placeholder>
  } else if (notes.length === 0) {
    body = <Placeholder>No activity yet. Notes you receive or top up show up here.</Placeholder>
  } else {
    const recent = [...notes].sort((a, b) => b.timestampMs - a.timestampMs || b.leafIndex - a.leafIndex).slice(0, LIMIT)
    body = (
      <ul>
        {recent.map((n, i) => (
          <ActivityRow key={n.commitment.toString()} note={n} index={i} />
        ))}
      </ul>
    )
  }

  return (
    <section aria-label="Recent activity">
      <SectionLabel>Recent activity</SectionLabel>
      {body}
    </section>
  )
}
