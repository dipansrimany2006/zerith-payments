# Zerith on NEAR: join-split shielded pool

This pool holds private USDC on NEAR and supports **any amount**. It handles deposits, private transfers
inside the pool, and withdrawals to any NEAR account. Each transaction spends two notes and creates two.
A Groth16 proof of [`circuits/transaction.circom`](../circuits/transaction.circom) is checked on-chain
with NEAR's native `alt_bn128` host functions. Notes are tied to the existing Zerith `shld1…` addresses,
so the spend key and viewing key work as before. Each note is delivered encrypted on-chain.

## Model

```
ownerPub   = Poseidon(ownerPriv)
commitment = Poseidon(amount, ownerPub, blinding)
nullifier  = Poseidon(ownerPriv, commitment, leafIndex)

sum(inputs) + publicAmount = sum(outputs)        publicAmount = extAmount - fee  (mod r)
```

| Action | How | `ext_amount` |
| --- | --- | --- |
| Deposit | `usdc.ft_transfer_call(pool, amount, msg = {proof_args, ext_data})` | `= amount > 0` |
| Private transfer | `pool.transact(proof_args, ext_data)`, usually sent by a relayer | `0` |
| Withdraw | `pool.transact(...)`, which pays `-ext_amount` to `ext_data.recipient` | `< 0` |

- **Hiding the sender.** The optional relayer fee is credited to `claimable[relayer]`. The user's own
  account never needs to sign a transfer or a withdrawal.
- **Binding the ext data.** `ext_data` holds the recipient, amounts, relayer, fee and both encrypted
  outputs. Its hash is a public input, so changing any field after proving makes verification fail.
  The contract computes `publicAmount` and `extDataHash` itself and never trusts the caller for them.
- **Recipients without USDC registration.** If the payout transfer fails, for example because the
  recipient isn't registered with USDC, the amount goes to `claimable[recipient]` and can be collected
  later with `claim()`.
- **Padding.** Inputs with zero amount are padding and don't need to be in the tree. Every transaction
  therefore looks the same on-chain: 2 nullifiers and 2 encrypted outputs.
- **Gas.** The two outputs are inserted as a sibling pair, which takes 20 Poseidon hashes instead of 40.

## Layout

| Path | What |
| --- | --- |
| `../circuits/transaction.circom` | 2-in/2-out join-split circuit: 25.8k constraints, 7 public inputs |
| `contracts/pool/src/lib.rs` | Pool: `ft_on_transfer` (deposit), `transact`, `claim`, owner pause, views |
| `contracts/pool/src/verifier.rs` | Groth16 verifier using `g1_multiexp`, `g1_sum` and `pairing_check` |
| `contracts/pool/src/merkle.rs` | Depth-20 Poseidon tree with pair insertion and a 30-root history |
| `contracts/pool/src/field.rs` | Field I/O, signed amounts mod r, `hash_to_field` |
| `contracts/pool/src/vk.rs` | Generated verifying key |
| `contracts/pool/src/poseidon_constants.rs` | Generated Poseidon constants |
| `../src/lib/zerith.ts` | Client library: keys, `Utxo`, note encryption, client tree, `extDataHash`, `prepareTransaction`, `prove` |
| `zk/setup.sh` | Compiles the circuit, runs a dev Groth16 setup, regenerates `vk.rs` |
| `zk/gen-fixture.ts` | Builds the 4-transaction proof fixture for the tests |
| `contracts/pool/tests/sandbox.rs` | End-to-end scenario and gas report |

## Encodings that must match between the contract and `zerith.ts`

- **`extDataHash`.** Take the borsh encoding of
  `(recipient: String, ext_amount: i128, relayer: String, fee: u128, [(ephemeral_pub [u8;32], ciphertext Vec<u8>); 2])`,
  where a missing account is the empty string. Hash it with `sha256`, clear the top 3 bits, and read it
  big-endian. The `ext_data_hash` view returns the contract's value so clients can check theirs.
- **Note plaintext.** `version(2) | amount(32) | blinding(32) | memo`, sealed with x25519 and
  XChaCha20-Poly1305. The key derivation is the same as in `src/lib/notes.ts`. Stored ciphertext is
  `nonce | sealed`. Wallets scan with `get_notes(from_index, limit)`, where the note index equals the
  leaf index.

## Verified scenario (sandbox, real proofs)

1. Alice deposits 1.50 USDC.
2. Alice privately pays Bob 0.40, with a 0.02 relayer fee and 1.08 change. No USDC leaves the pool, and
   Bob finds his note by trial decryption.
3. Bob withdraws 0.39 to `bob.test.near`, with a 0.01 relayer fee.
4. Alice withdraws 1.00 to `carol.test.near`, which isn't registered with USDC. The payout is held, and
   Carol registers and claims it. Alice keeps 0.08.

The test also checks the following:
- The tree roots match after every step.
- The `extDataHash` encoding matches between the contract and the client.
- A deposit with the wrong amount is refunded.
- A deposit sent through `transact` is rejected.
- A tampered relayer fee fails proof verification.
- A double spend is rejected.
- Relayer fees can be claimed.
- At the end, the pool holds exactly Alice's 0.08.

| Operation | Gas | Approx. cost |
| --- | --- | --- |
| Deposit (whole transaction including the FT) | 66.0 Tgas | 0.0066 NEAR |
| Private transfer | 61.7 Tgas | 0.0062 NEAR |
| Withdraw (whole transaction including payout) | 66.2 Tgas | 0.0066 NEAR |
| Contract wasm | 249 KB | about 2.5 NEAR storage stake |

Generating a proof takes about 0.6 s in Node.

## Reproduce

Run these commands from the repo root.

```bash
bun install
near/zk/setup.sh        # needs build/zk/powersOfTau28_hez_final_16.ptau (scripts/zk-setup-plonk.sh downloads it)
node near/zk/gen-fixture.ts build/circuits/transaction_js/transaction.wasm build/zk-groth16/transaction.zkey \
  build/zk-groth16/transaction_vk.json near/contracts/pool/tests/fixtures/transact.json
near/scripts/build.sh
cd near && cargo test -p zerith-pool -- --nocapture
```

`vk.rs` and the fixture are committed, so `build.sh` and `cargo test` alone are enough. Regenerating the
key invalidates the fixture, so always rerun `setup.sh` and `gen-fixture.ts` together. Run snarkjs with
Node, not Bun: its worker threads crash under Bun.

## Known follow-ups

- **Trusted setup.** `setup.sh` is a dev setup with a single contribution. Mainnet needs a public
  phase-2 ceremony.
- **Storage costs.** Each transaction stores about 0.7 KB (2 notes and 2 nullifiers), about 0.007 NEAR,
  paid from the pool's balance. Charge a storage fee, or have the relayer cover it from its fee.
- **Root history.** With 30 roots, a proof goes stale after 30 newer transactions. Raise the history
  size, or have clients re-prove, once traffic is real.
- **Frontend.** Done in step 3: the app in `src/` now uses `src/lib/zerith.ts`, NEAR wallet login and `get_notes` scanning.
