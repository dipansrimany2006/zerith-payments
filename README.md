# Zerith: private USDC payments on NEAR

Zerith lets anyone with a NEAR account **send and receive USDC privately**. You shield USDC into a
pool, pay any Zerith address privately, and withdraw to any NEAR account. On-chain, nobody can link
who paid whom. A viewing key lets you prove your payments to an auditor when you choose to.

> Built for the NEAR Hackathon (Privacy & Private AI, Real-World Money). This repository started from
> an earlier version of Zerith built for Circle's Arc chain (EVM, PLONK, fixed note sizes). Everything
> in it now is the NEAR version: a new Rust contract, a new join-split circuit, NEAR wallet login and
> a NEAR relayer.

**Live app:** https://zerith.dipansrimany.workers.dev (NEAR testnet)

**Status:** live on **NEAR testnet**. Pool: [`zerith-pool-e975a5.testnet`](https://testnet.nearblocks.io/address/zerith-pool-e975a5.testnet).
It uses Circle's testnet USDC. Get some at [faucet.circle.com](https://faucet.circle.com) by choosing
"NEAR Testnet". The proving key comes from a **development** trusted setup, and the contract is
**unaudited**, so don't use it with real funds.

## How it works

```
 wallet USDC ──ft_transfer_call──▶ ┌──────────────── Zerith pool (Rust, NEAR) ────────────────┐
 (public)       + ZK proof         │ Poseidon Merkle tree of encrypted notes (any amount)     │
                                   │ Groth16 verifier on NEAR's native alt_bn128 functions    │
 relayer ───── transact + proof ──▶│ spent nullifiers · claimable relayer fees and payouts    │──▶ USDC to any
 (pays gas, user stays hidden)     └──────────────────────────────────────────────────────────┘    NEAR account
```

- **Notes.** A note is `Poseidon(amount, ownerPub, blinding)`, encrypted to the recipient's viewing
  key (x25519 + XChaCha20-Poly1305) and stored on-chain. Wallets find their notes by trial decryption.
- **Join-split transactions.** Every transaction spends 2 notes and creates 2, with one Groth16 proof.
  Unused slots are zero-amount padding, so deposits, transfers and withdrawals all look the same
  on-chain.
- **Binding the details.** Recipient, amounts, relayer fee and encrypted outputs are hashed into the
  proof, so a relayer can't change any of them.
- **Keys.** Keys come from a NEP-413 message signed by your NEAR wallet. Nothing is stored and there
  is no seed phrase to back up. The same wallet key always gives the same Zerith address (`shld1…`).

### Payroll and payment requests

- **Payroll.** Paste or upload a CSV of `recipient, amount, memo`. A recipient is a `shld1…` address
  or a NEAR account.
  - **From your wallet,** each deposit carries **two recipients**, because the circuit has two outputs.
    Every proof is made against the same Merkle root before anything is sent, and then the whole run
    goes out with **one wallet approval** (`signAndSendTransactions`). On-chain, people can see your
    account deposited the total, but not who received it or how it was split.
  - **From your private balance,** each payment is a relayed private transfer, or a withdrawal for
    NEAR-account recipients. Nothing links them to you. The run stops at the first failure so nobody is
    paid twice, and a results CSV records the transaction hashes.
- **Payment requests.** The Receive tab creates links like `…/#pay?to=shld1…&amount=…&memo=…&id=…`.
  - The payer needs **only a NEAR wallet with USDC**. They don't need a Zerith account or unlock,
    because paying shields the USDC straight into a note for the requester.
  - The memo carries a `[req:id]` tag, so the requester's app marks the request as paid once a
    matching note of at least the requested amount arrives.

### Private CFO: AI over your private ledger, verified in the browser

The **Private CFO** tab answers questions about your payments and drafts audit summaries using
**NEAR AI Cloud** models that run inside TEEs (Intel TDX plus NVIDIA confidential GPUs).

- **Where your data goes.** Your ledger is decrypted on your device and sent straight from the browser
  to NEAR AI with your own API key. It never reaches Zerith's servers.
- **Before any data is sent,** the browser
  ([`src/lib/near-ai.ts`](src/lib/near-ai.ts)):
  - fetches the model's attestation with a fresh random nonce
  - verifies the **Intel TDX quote** against Intel's root CA with the pure-JS
    [`@phala/dcap-qvl`](https://www.npmjs.com/package/@phala/dcap-qvl), getting collateral from Phala's PCCS
  - checks that the quote's `report_data` binds the model's signing key and our nonce
  - checks that the GPU evidence carries the same nonce, and gets NVIDIA's verdict through the relayer,
    because NVIDIA's API has no CORS. The relayer only sees attestation evidence, never your data.
- **After every answer,** the browser fetches the response signature and checks that
  `model:sha256(request):sha256(response)` was signed (EIP-191) by the attested key.
- **Nothing is sent unless the attestation verifies.** "Show exactly what is shared" displays the ledger
  that goes to the model.

| Action | Who sends it | What is public |
| --- | --- | --- |
| Shield (wallet to a note for any address) | your wallet (`ft_transfer_call`) | your account and the amount, not who the note is for |
| Private send (note to note) | relayer | nothing that links you |
| Withdraw (note to NEAR account) | relayer | the destination and amount, not the source |

## Repository

| Path | What |
| --- | --- |
| `near/contracts/pool` | Shielded pool contract in Rust (near-sdk 5): deposits, `transact`, `claim`, Groth16 verifier, Poseidon tree |
| `near/contracts/mock-ft` | Test-only NEP-141 token used by the sandbox tests |
| `circuits/transaction.circom` | 2-in/2-out join-split circuit (about 26k constraints, 7 public inputs) |
| `near/zk/` | Trusted-setup script (dev), verifying-key and Poseidon-constant generators, test fixture generator |
| `src/` | React app: NEAR Connect wallet login, in-browser proving, send, receive, withdraw, Private CFO and audit |
| `src/lib/near-ai.ts` | NEAR AI Cloud client: TEE attestation verification (Intel TDX, NVIDIA), verified chat, response-signature checks |
| `src/lib/zerith.ts` | Client library shared by the app, relayer and scripts (notes, encryption, tree, ext-data hash, proving) |
| `server/` | Relayer (Bun): validates requests, registers new recipients with USDC, submits `transact`; forwards GPU attestation evidence to NVIDIA |
| `worker/` | The same relayer as a Cloudflare Worker, plus static hosting |
| `scripts/near-e2e.ts` | End-to-end test against testnet: shield, then private send, then withdraw |
| `scripts/near-payroll-e2e.ts` | Testnet payroll check: 4 recipients in 2 deposits, all proved against one root |
| `scripts/near-ai-check.ts` | Private CFO check: attestation, one verified chat and its TEE signature (needs `NEAR_AI_API_KEY`) |

More detail on the contract and its benchmarks is in [near/README.md](near/README.md).

## Run it

You need [bun](https://bun.sh), Node 22+ (for snarkjs), and for the contract: Rust,
[`cargo-near`](https://github.com/near/cargo-near) and [`near` CLI](https://near.cli.rs).

```bash
bun install

# Relayer (needs a funded NEAR testnet account)
cat >> .env <<EOF
NEAR_RELAYER_ACCOUNT=<your-relayer>.testnet
NEAR_RELAYER_KEY=ed25519:...
EOF
bun run relayer            # :3001

# App (proxies /api to the relayer)
bun run dev                # http://localhost:5173
```

### Contract tests (local NEAR sandbox, real proofs)

```bash
bun run near:build         # builds the wasm with cargo-near
bun run near:test          # unit tests + end-to-end join-split scenario with a gas report
```

### Testnet end-to-end

```bash
NEAR_TESTER_ACCOUNT=<account with ≥0.5 testnet USDC>.testnet bun run e2e:testnet
```

### Rebuilding the circuit and keys (optional)

```bash
bun run zk:setup           # compile circuit, dev Groth16 setup, vk.rs, browser proving files
bun run zk:fixture         # regenerate the sandbox-test proofs (needed after zk:setup)
```

## Costs (measured on the NEAR sandbox)

| | Gas | ≈ NEAR |
| --- | --- | --- |
| Shield | 66 Tgas | 0.0066 |
| Private send | 62 Tgas | 0.0062 |
| Withdraw | 66 Tgas | 0.0066 |

Generating a proof takes about 0.6 s in Node. The relayer charges 0.02 USDC per private send or
withdrawal.

## Limitations

- **Trusted setup.** It's a dev setup with one contribution. Mainnet needs a public phase-2 ceremony.
- **One address per wallet key.** Keys are tied to the NEAR access key that signs. The same account
  used from a different key, for example in another wallet app, gets a different Zerith address.
- **Relayer trust.** The relayer can't steal funds or change a payment, but it sees request metadata
  such as your IP address. It doesn't run in a TEE.
- **Private CFO trust.** The Private CFO depends on NEAR AI Cloud's TEE and on Intel's and NVIDIA's
  attestation roots. The NVIDIA verdict comes through the relayer, and the browser doesn't check its
  JWT signature. You need your own NEAR AI Cloud API key.
- **Storage and stale proofs.** The pool pays about 0.007 NEAR of storage per transaction, and keeps
  the last 30 Merkle roots. See [near/README.md](near/README.md).
