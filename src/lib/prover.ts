import { bytesToHex } from '@noble/hashes/utils.js'
import { prove, type PrepareResult, type ProofArgs } from '@/lib/zerith'
import { ZK_WASM, ZK_ZKEY } from '@/lib/zk-artifacts'

interface ProvingFiles {
  wasm: Uint8Array
  zkey: Uint8Array
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
}

async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not download the proving files (${res.status}). Try again.`)
  return new Uint8Array(await res.arrayBuffer())
}

let files: Promise<ProvingFiles> | null = null

/**
 * Downloads the circuit and the Groth16 key (about 14 MB) and checks both against the hashes
 * pinned in zk-artifacts.ts, so a tampered file is refused. Cached for the session.
 */
export function loadProvingFiles(): Promise<ProvingFiles> {
  files ??= (async () => {
    const [wasm, zkey] = await Promise.all([download(ZK_WASM.url), download(ZK_ZKEY.url)])
    const [w, z] = await Promise.all([sha256Hex(wasm), sha256Hex(zkey)])
    if (w !== ZK_WASM.sha256 || z !== ZK_ZKEY.sha256) {
      throw new Error('The proving files do not match the expected hashes. Reload the page and try again.')
    }
    return { wasm, zkey }
  })().catch((err: unknown) => {
    files = null
    throw err
  })
  return files
}

/** Proves a prepared transaction in the browser (about a second on a laptop). */
export async function proveTransaction(prepared: PrepareResult): Promise<ProofArgs> {
  const { wasm, zkey } = await loadProvingFiles()
  return prove(prepared.circuitInput, wasm, zkey)
}
