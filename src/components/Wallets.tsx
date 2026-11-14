import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Droplets, ExternalLink, LogOut, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { ZerithMark } from '@/components/Logo'
import { Activity } from '@/components/Activity'
import { IS_TESTNET, NETWORK_NAME, USDC_FAUCET_URL, accountUrl } from '@/lib/near-config'
import { useShielded } from '@/lib/shielded-context'
import { useWallet } from '@/lib/wallet'
import { friendlyError, usdcNumber } from '@/lib/format'
import { SPRING, STAGGER } from '@/lib/motion'
import { AnimatedNumber, Badge } from '@/components/ui'

const shortAccount = (id: string) => (id.length > 22 ? `${id.slice(0, 10)}...${id.slice(-8)}` : id)

function ConnectPill() {
  const { accountId, connecting, connect } = useWallet()
  const onClick = async () => {
    if (accountId) {
      window.open(accountUrl(accountId), '_blank', 'noopener,noreferrer')
      return
    }
    try {
      await connect()
    } catch (err) {
      toast.error(friendlyError(err))
    }
  }
  return (
    <motion.button
      type="button"
      data-tour="wallet"
      onClick={() => void onClick()}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.96 }}
      transition={SPRING.snappy}
      title={accountId ?? undefined}
      className="inline-flex min-h-10 max-w-[200px] items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-canvas"
    >
      <span className={`size-2 shrink-0 rounded-full ${accountId ? 'bg-success' : 'bg-muted'}`} aria-hidden />
      <span className="truncate">{accountId ? shortAccount(accountId) : connecting ? 'Connecting...' : 'Connect'}</span>
    </motion.button>
  )
}

function WalletRow({
  index,
  show,
  icon,
  name,
  sub,
  amount,
  amountSub,
}: {
  index: number
  show: boolean
  icon: ReactNode
  name: string
  sub: ReactNode
  amount: ReactNode
  amountSub: string
}) {
  return (
    <motion.li
      initial={{ opacity: 0, x: -12 }}
      animate={show ? { opacity: 1, x: 0 } : { opacity: 0, x: -12 }}
      transition={{ ...SPRING.smooth, delay: index * STAGGER.normal }}
      className="row-hover group -mx-3 flex items-center gap-3 rounded-2xl px-3 py-3"
    >
      <span className="transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105">
        <Badge>{icon}</Badge>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{name}</p>
        <p className="truncate text-[11px] text-ink-2">{sub}</p>
      </div>
      <div className="text-right">
        <p className="font-display text-lg leading-tight text-ink">{amount}</p>
        <p className="text-[11px] text-ink-2">{amountSub}</p>
      </div>
    </motion.li>
  )
}

const Dash = () => <span className="text-muted">—</span>
const Skeleton = () => <span className="skeleton inline-block h-4 w-14 align-middle" aria-label="Loading" />

/** Middle column: balances, pool stats and recent private activity. */
export function Wallets({ show }: { show: boolean }) {
  const { accountId, walletName, disconnect } = useWallet()
  const { keys, loadedOnce, notes, balance: shielded, usdcBalance, leaves } = useShielded()
  const isConnected = !!accountId
  const unspent = notes.filter((n) => !n.spent)

  const total = (usdcBalance ?? 0n) + (keys ? shielded : 0n)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-4xl font-light tracking-tight text-ink">Wallets</h1>
        <ConnectPill />
      </div>

      {isConnected && (
        <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-ink-2">
          <span className="truncate">{walletName ?? 'NEAR wallet'}</span>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="inline-flex min-h-8 items-center gap-1 font-semibold text-ink underline-offset-4 hover:underline"
          >
            <LogOut className="size-3.5" aria-hidden /> Disconnect
          </button>
        </div>
      )}

      <div className="mt-8 flex items-end justify-between gap-3">
        <div>
          <p className="text-base font-medium text-ink">USDC</p>
          <p className="text-[11px] text-ink-2">{NETWORK_NAME}</p>
        </div>
        <div className="text-right">
          <p className="font-display text-2xl text-ink">
            {!isConnected ? <Dash /> : !loadedOnce ? <Skeleton /> : <>$ <AnimatedNumber value={usdcNumber(total)} /></>}
          </p>
          <p className="text-[11px] text-ink-2">Total balance</p>
        </div>
      </div>

      <ul data-tour="balances" className="mt-6">
        <WalletRow
          index={0}
          show={show}
          icon={<Wallet className="size-4" />}
          name="Public wallet"
          sub={
            isConnected && IS_TESTNET ? (
              <a
                href={USDC_FAUCET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-ink underline-offset-4 hover:underline"
              >
                <Droplets className="size-3" aria-hidden /> Get testnet USDC <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : (
              'Visible on chain'
            )
          }
          amount={!isConnected ? <Dash /> : !loadedOnce ? <Skeleton /> : usdcBalance === null ? <Dash /> : <AnimatedNumber value={usdcNumber(usdcBalance)} />}
          amountSub="USDC"
        />
        <WalletRow
          index={1}
          show={show}
          icon={<ZerithMark className="size-5" pupil="var(--canvas)" />}
          name="Zerith"
          sub={keys ? `${unspent.length} unspent note${unspent.length === 1 ? '' : 's'}` : 'Locked'}
          amount={!keys ? <Dash /> : !loadedOnce ? <Skeleton /> : <AnimatedNumber value={usdcNumber(shielded)} />}
          amountSub="USDC"
        />
      </ul>

      <motion.dl
        className="mt-4 flex gap-8 border-t border-line pt-4"
        initial={{ opacity: 0, y: 8 }}
        animate={show ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
        transition={{ ...SPRING.smooth, delay: 2 * STAGGER.normal }}
      >
        <div>
          <dt className="text-[11px] text-ink-2">Notes in pool</dt>
          <dd className="font-display text-lg tabular-nums text-ink">{loadedOnce ? leaves.length : <Skeleton />}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-ink-2">Network</dt>
          <dd className="font-display text-lg text-ink">{NETWORK_NAME}</dd>
        </div>
      </motion.dl>

      {isConnected && (
        <motion.div
          className="mt-8"
          initial={{ opacity: 0, y: 8 }}
          animate={show ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
          transition={{ ...SPRING.smooth, delay: 3 * STAGGER.normal }}
        >
          <Activity />
        </motion.div>
      )}
    </div>
  )
}
