import { NETWORKS, createProvider, type NearNetwork } from '@/lib/near-rpc'

/** The NEAR network this build talks to (VITE_NEAR_NETWORK, default testnet). */
export const NEAR_NETWORK = ((import.meta.env.VITE_NEAR_NETWORK as string | undefined) || 'testnet') as NearNetwork
export const NET = NETWORKS[NEAR_NETWORK]
export const POOL_ID: string = (import.meta.env.VITE_POOL_ID as string | undefined) || NET.poolId
export const USDC_ID = NET.usdcId
export const IS_TESTNET = NEAR_NETWORK === 'testnet'
export const NETWORK_NAME = IS_TESTNET ? 'NEAR Testnet' : 'NEAR'

/** Shared read-only RPC client for the app. */
export const provider = createProvider(NET.rpcUrls)

export const txUrl = (hash: string) => `${NET.explorer}/txns/${hash}`
export const accountUrl = (id: string) => `${NET.explorer}/address/${id}`

/** Where testnet users get USDC. */
export const USDC_FAUCET_URL = 'https://faucet.circle.com'
