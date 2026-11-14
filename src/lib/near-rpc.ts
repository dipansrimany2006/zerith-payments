/**
 * NEAR RPC helpers shared by the app, the relayer and scripts. Nothing here reads import.meta.env,
 * so Bun, Node and Cloudflare Workers can import it too.
 */
import { FailoverRpcProvider, JsonRpcProvider } from 'near-api-js'
import type { EncryptedOutput, ExtData, ProofArgs } from './zerith'

export type NearNetwork = 'testnet' | 'mainnet'

export interface NetworkConfig {
  network: NearNetwork
  rpcUrls: string[]
  poolId: string
  usdcId: string
  explorer: string
}

/** Public deployment facts. The pool and token ids are not secrets. */
export const NETWORKS: Record<NearNetwork, NetworkConfig> = {
  testnet: {
    network: 'testnet',
    rpcUrls: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
    poolId: 'zerith-pool-e975a5.testnet',
    // Circle's USDC on NEAR testnet (6 decimals). Get some at https://faucet.circle.com
    usdcId: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    explorer: 'https://testnet.nearblocks.io',
  },
  mainnet: {
    network: 'mainnet',
    rpcUrls: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
    poolId: '', // not deployed yet
    usdcId: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    explorer: 'https://nearblocks.io',
  },
}

export function createProvider(rpcUrls: string[]) {
  const providers = rpcUrls.map((url) => new JsonRpcProvider({ url }))
  return providers.length === 1 ? providers[0] : new FailoverRpcProvider(providers)
}

export type Provider = ReturnType<typeof createProvider>

export async function view<T>(provider: Provider, contractId: string, method: string, args: object = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args: args as Record<string, unknown> })) as T
}

/** One on-chain note, as returned by the pool's `get_notes` view. */
export interface NoteView extends EncryptedOutput {
  leaf_index: number
  commitment: string
  timestamp_ms: string
}

const PAGE = 100

/** Reads every note from `fromIndex` on, in leaf order. */
export async function fetchNotes(provider: Provider, poolId: string, fromIndex = 0): Promise<NoteView[]> {
  const out: NoteView[] = []
  for (let i = fromIndex; ; i += PAGE) {
    const page = await view<NoteView[]>(provider, poolId, 'get_notes', { from_index: i, limit: PAGE })
    out.push(...page)
    if (page.length < PAGE) return out
  }
}

export interface TransactRequest {
  proof_args: ProofArgs
  ext_data: ExtData
}

/** Pulls the contract's ERR_* code (or a short message) out of a NEAR error. */
export function nearErrorCode(err: unknown): string {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : JSON.stringify(err)
  const code = /ERR_[A-Z_]+/.exec(text)?.[0]
  if (code) return code
  return err instanceof Error ? err.message.split('\n')[0] : 'Transaction failed'
}

/** NEAR account id rules (NEP-0001), used to validate recipients before spending gas. */
export function isValidAccountId(id: string): boolean {
  return (
    id.length >= 2 &&
    id.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id)
  )
}
