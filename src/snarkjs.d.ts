declare module 'snarkjs' {
  /** A file path or URL, or bytes already in memory. */
  export type ProvingFile = string | { type: 'mem'; data: Uint8Array }

  export interface PlonkProof {
    protocol: string
    curve: string
    [key: string]: unknown
  }

  export interface FullProveResult {
    proof: PlonkProof
    publicSignals: string[]
  }

  export interface Groth16Proof {
    pi_a: string[]
    pi_b: string[][]
    pi_c: string[]
    protocol: string
    curve: string
  }

  export const groth16: {
    fullProve(input: Record<string, unknown>, wasmFile: ProvingFile, zkeyFile: ProvingFile): Promise<{ proof: Groth16Proof; publicSignals: string[] }>
    verify(vk: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>
  }

  export const plonk: {
    fullProve(input: Record<string, unknown>, wasmFile: ProvingFile, zkeyFile: ProvingFile): Promise<FullProveResult>
    verify(vk: unknown, publicSignals: string[], proof: PlonkProof): Promise<boolean>
    /** Returns `[24 proof words],[5 public signals]` as hex strings, in the verifier's order. */
    exportSolidityCallData(proof: PlonkProof, publicSignals: string[]): Promise<string>
  }
}
