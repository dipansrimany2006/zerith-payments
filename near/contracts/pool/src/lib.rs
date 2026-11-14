//! Zerith shielded pool for NEAR: private USDC with arbitrary amounts.
//!
//! A join-split (UTXO) pool. Every transaction spends two notes and creates two, proven
//! by a Groth16 proof of circuits/transaction.circom and verified with NEAR's native alt_bn128
//! host functions. Notes are recipient-bound to Zerith shielded addresses and delivered
//! encrypted on-chain.
//!
//! - Deposit:  `usdc.ft_transfer_call(pool, amount, msg)`, where `msg` is a JSON `TransactMsg`
//!             with `ext_amount == amount`.
//! - Transfer: `transact` with `ext_amount == 0`. Only notes move; USDC stays in the pool.
//! - Withdraw: `transact` with `ext_amount < 0`. `-ext_amount` goes to `recipient`.
//!
//! An optional relayer fee is carved out of the transaction and credited to the relayer's
//! claimable balance. `ext_data` (recipient, amounts, relayer, encrypted outputs) is hashed
//! into the proof, so nobody can change it after proving.

mod field;
mod merkle;
mod poseidon_constants;
mod verifier;
mod vk;

use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::json_types::{Base64VecU8, I128, U128, U64};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};

use field::{from_i128, hash_to_field, parse_field, to_decimal, Field};
use merkle::{compute_zeros, Hasher, MerkleTree, LEVELS};
pub use verifier::Groth16Proof;

/// Each `ext_amount` and `fee` must be below 2^120 base units, far under the circuit's 2^248
/// note bound, so balances can never wrap around the field.
pub const MAX_AMOUNT: u128 = 1 << 120;
pub const MAX_CIPHERTEXT: usize = 512;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Spent,
    Notes,
    Claimable,
}

// ------------------------------------------------------------------- types

/// Encrypted output note as stored on-chain, at index == leaf index.
#[near(serializers = [borsh])]
pub struct NoteRecord {
    pub commitment: Field,
    pub timestamp_ms: u64,
    pub ephemeral_pub: [u8; 32],
    pub ciphertext: Vec<u8>,
}

#[near(serializers = [json])]
pub struct NoteView {
    pub leaf_index: u32,
    pub commitment: String,
    pub timestamp_ms: U64,
    pub ephemeral_pub: Base64VecU8,
    pub ciphertext: Base64VecU8,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct EncryptedOutput {
    /// 32-byte x25519 ephemeral public key.
    pub ephemeral_pub: Base64VecU8,
    pub ciphertext: Base64VecU8,
}

/// Everything the proof binds through `extDataHash` instead of as separate public inputs.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct ExtData {
    /// Payout account for withdrawals (`ext_amount < 0`); must be null otherwise.
    pub recipient: Option<AccountId>,
    /// > 0 deposit, 0 private transfer, < 0 withdrawal. USDC base units.
    pub ext_amount: I128,
    pub relayer: Option<AccountId>,
    pub fee: U128,
    pub encrypted_outputs: [EncryptedOutput; 2],
}

/// The borsh layout hashed into `extDataHash`. Mirrored by src/lib/zerith.ts `extDataHash`.
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct ExtDataEncoding<'a> {
    recipient: &'a str,
    ext_amount: i128,
    relayer: &'a str,
    fee: u128,
    outputs: [([u8; 32], &'a [u8]); 2],
}

impl ExtData {
    fn validate(&self) -> [[u8; 32]; 2] {
        let ext = self.ext_amount.0;
        require!(ext > -(MAX_AMOUNT as i128) && ext < MAX_AMOUNT as i128, "ERR_EXT_AMOUNT_RANGE");
        require!(self.fee.0 < MAX_AMOUNT, "ERR_FEE_RANGE");
        require!(self.fee.0 == 0 || self.relayer.is_some(), "ERR_FEE_WITHOUT_RELAYER");
        if ext < 0 {
            require!(self.recipient.is_some(), "ERR_NO_RECIPIENT");
        } else {
            require!(self.recipient.is_none(), "ERR_UNEXPECTED_RECIPIENT");
        }
        let mut ephs = [[0u8; 32]; 2];
        for (i, o) in self.encrypted_outputs.iter().enumerate() {
            ephs[i] = o
                .ephemeral_pub
                .0
                .as_slice()
                .try_into()
                .unwrap_or_else(|_| env::panic_str("ERR_BAD_EPHEMERAL_PUB"));
            require!(o.ciphertext.0.len() <= MAX_CIPHERTEXT, "ERR_CIPHERTEXT_TOO_LARGE");
        }
        ephs
    }

    fn hash(&self, ephs: &[[u8; 32]; 2]) -> Field {
        let enc = ExtDataEncoding {
            recipient: self.recipient.as_ref().map(|a| a.as_str()).unwrap_or(""),
            ext_amount: self.ext_amount.0,
            relayer: self.relayer.as_ref().map(|a| a.as_str()).unwrap_or(""),
            fee: self.fee.0,
            outputs: [
                (ephs[0], self.encrypted_outputs[0].ciphertext.0.as_slice()),
                (ephs[1], self.encrypted_outputs[1].ciphertext.0.as_slice()),
            ],
        };
        hash_to_field(&borsh::to_vec(&enc).unwrap())
    }

    /// publicAmount = ext_amount - fee (mod r). Both are range-checked, so no overflow.
    fn public_amount(&self) -> Field {
        from_i128(self.ext_amount.0 - self.fee.0 as i128)
    }
}

/// The proof and the public inputs the caller supplies. `publicAmount` and `extDataHash`
/// are always computed by the contract from `ext_data`.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct ProofArgs {
    pub proof: Groth16Proof,
    pub root: String,
    pub input_nullifiers: [String; 2],
    pub output_commitments: [String; 2],
}

/// The `msg` of `ft_transfer_call` for deposits.
#[near(serializers = [json])]
pub struct TransactMsg {
    pub proof_args: ProofArgs,
    pub ext_data: ExtData,
}

#[near(serializers = [json])]
pub struct PoolConfig {
    pub owner: AccountId,
    pub usdc: AccountId,
    pub paused: bool,
    pub levels: u32,
    pub max_amount: U128,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

// ---------------------------------------------------------------- contract

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ShieldedPool {
    owner: AccountId,
    pending_owner: Option<AccountId>,
    paused: bool,
    usdc: AccountId,
    zeros: Vec<Field>,
    tree: MerkleTree,
    spent: LookupSet<Field>,
    notes: Vector<NoteRecord>,
    /// Relayer fees, and payouts whose transfer failed (e.g. recipient not registered with USDC).
    claimable: LookupMap<AccountId, u128>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "zerith",
            "version": "2.0.0",
            "event": event,
            "data": [data],
        })
    ));
}

fn last_promise_succeeded() -> bool {
    // ft_transfer returns nothing; a small bound keeps a hostile token from burning our gas.
    env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok()
}

#[near]
impl ShieldedPool {
    #[init]
    pub fn new(owner: AccountId, usdc: AccountId) -> Self {
        let mut h = Hasher::new();
        let zeros = compute_zeros(&mut h);
        let tree = MerkleTree::new(&zeros);
        Self {
            owner,
            pending_owner: None,
            paused: false,
            usdc,
            zeros,
            tree,
            spent: LookupSet::new(StorageKey::Spent),
            notes: Vector::new(StorageKey::Notes),
            claimable: LookupMap::new(StorageKey::Claimable),
        }
    }

    // ---------------------------------------------------------- transactions

    /// NEP-141 receiver: deposits. Panicking refunds the full amount via `ft_resolve_transfer`.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "ERR_WRONG_TOKEN");
        require!(!self.paused, "ERR_PAUSED");
        let msg: TransactMsg =
            near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("ERR_BAD_MSG"));
        require!(msg.ext_data.ext_amount.0 > 0, "ERR_NOT_A_DEPOSIT");
        require!(msg.ext_data.ext_amount.0 as u128 == amount.0, "ERR_AMOUNT_MISMATCH");
        let _ = sender_id; // The depositor is intentionally not recorded.
        self.process(&msg.proof_args, &msg.ext_data);
        PromiseOrValue::Value(U128(0))
    }

    /// Private transfers (`ext_amount == 0`) and withdrawals (`ext_amount < 0`). Usually
    /// submitted by a relayer so the user's own account never appears. Works while paused.
    ///
    /// If the payout transfer fails (e.g. the recipient is not registered with USDC), the
    /// amount is credited to the recipient's claimable balance; the notes stay spent.
    pub fn transact(&mut self, proof_args: ProofArgs, ext_data: ExtData) -> PromiseOrValue<bool> {
        require!(ext_data.ext_amount.0 <= 0, "ERR_DEPOSIT_VIA_FT_TRANSFER_CALL");
        self.process(&proof_args, &ext_data);

        if ext_data.ext_amount.0 == 0 {
            return PromiseOrValue::Value(true);
        }
        let recipient = ext_data.recipient.clone().unwrap();
        let amount = ext_data.ext_amount.0.unsigned_abs();
        PromiseOrValue::Promise(self.pay(recipient, amount, false))
    }

    fn process(&mut self, args: &ProofArgs, ext_data: &ExtData) {
        let ephs = ext_data.validate();

        let root = parse_field(&args.root, "ERR_ROOT_NOT_IN_FIELD");
        require!(self.tree.is_known_root(&root), "ERR_UNKNOWN_ROOT");
        let n0 = parse_field(&args.input_nullifiers[0], "ERR_NULLIFIER_NOT_IN_FIELD");
        let n1 = parse_field(&args.input_nullifiers[1], "ERR_NULLIFIER_NOT_IN_FIELD");
        require!(n0 != n1, "ERR_DUPLICATE_NULLIFIER");
        require!(!self.spent.contains(&n0) && !self.spent.contains(&n1), "ERR_NULLIFIER_SPENT");
        let c0 = parse_field(&args.output_commitments[0], "ERR_COMMITMENT_NOT_IN_FIELD");
        let c1 = parse_field(&args.output_commitments[1], "ERR_COMMITMENT_NOT_IN_FIELD");

        let public = [root, ext_data.public_amount(), ext_data.hash(&ephs), n0, n1, c0, c1];
        require!(verifier::verify(&args.proof, &public), "ERR_INVALID_PROOF");

        self.spent.insert(n0);
        self.spent.insert(n1);
        let mut h = Hasher::new();
        let leaf_index = self.tree.insert_pair(&mut h, &self.zeros, c0, c1);
        let now = env::block_timestamp_ms();
        for (i, c) in [c0, c1].into_iter().enumerate() {
            self.notes.push(NoteRecord {
                commitment: c,
                timestamp_ms: now,
                ephemeral_pub: ephs[i],
                ciphertext: ext_data.encrypted_outputs[i].ciphertext.0.clone(),
            });
        }

        if let (Some(relayer), true) = (ext_data.relayer.as_ref(), ext_data.fee.0 > 0) {
            self.credit(relayer, ext_data.fee.0);
        }

        emit(
            "transact",
            near_sdk::serde_json::json!({
                "input_nullifiers": [to_decimal(&n0), to_decimal(&n1)],
                "output_commitments": [to_decimal(&c0), to_decimal(&c1)],
                "leaf_index": leaf_index,
                "ext_amount": ext_data.ext_amount,
                "fee": ext_data.fee,
            }),
        );
    }

    // --------------------------------------------------------------- payouts

    /// Withdraws the caller's claimable balance (relayer fees or a failed payout).
    pub fn claim(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.claimable.get(&account).copied().unwrap_or(0);
        require!(amount > 0, "ERR_NOTHING_TO_CLAIM");
        self.claimable.remove(&account);
        self.pay(account, amount, true)
    }

    fn pay(&mut self, to: AccountId, amount: u128, is_claim: bool) -> Promise {
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_payout(to, U128(amount), is_claim),
            )
    }

    #[private]
    pub fn on_payout(&mut self, to: AccountId, amount: U128, is_claim: bool) -> bool {
        if last_promise_succeeded() {
            return true;
        }
        self.credit(&to, amount.0);
        emit(
            "payout_deferred",
            near_sdk::serde_json::json!({ "account_id": to, "amount": amount, "is_claim": is_claim }),
        );
        false
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        let bal = self.claimable.get(account).copied().unwrap_or(0);
        self.claimable.insert(account.clone(), bal + amount);
    }

    // ------------------------------------------------------------------ owner

    /// Pauses deposits only; transfers and withdrawals stay available.
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
    }

    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.pending_owner = Some(new_owner);
    }

    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.pending_owner.as_ref() == Some(&caller), "ERR_NOT_PENDING_OWNER");
        self.owner = caller;
        self.pending_owner = None;
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> PoolConfig {
        PoolConfig {
            owner: self.owner.clone(),
            usdc: self.usdc.clone(),
            paused: self.paused,
            levels: LEVELS as u32,
            max_amount: U128(MAX_AMOUNT),
        }
    }

    pub fn get_last_root(&self) -> String {
        to_decimal(&self.tree.last_root())
    }

    pub fn is_known_root(&self, root: String) -> bool {
        self.tree.is_known_root(&parse_field(&root, "ERR_ROOT_NOT_IN_FIELD"))
    }

    pub fn next_leaf_index(&self) -> u32 {
        self.tree.next_index
    }

    pub fn get_zeros(&self) -> Vec<String> {
        self.zeros.iter().map(to_decimal).collect()
    }

    pub fn is_spent(&self, nullifier: String) -> bool {
        self.spent.contains(&parse_field(&nullifier, "ERR_NULLIFIER_NOT_IN_FIELD"))
    }

    pub fn notes_count(&self) -> u32 {
        self.notes.len()
    }

    /// Pages through encrypted notes by leaf index, for wallet scanning.
    pub fn get_notes(&self, from_index: u32, limit: u32) -> Vec<NoteView> {
        let end = from_index.saturating_add(limit.min(100)).min(self.notes.len());
        (from_index..end)
            .map(|i| {
                let n = &self.notes[i];
                NoteView {
                    leaf_index: i,
                    commitment: to_decimal(&n.commitment),
                    timestamp_ms: U64(n.timestamp_ms),
                    ephemeral_pub: Base64VecU8(n.ephemeral_pub.to_vec()),
                    ciphertext: Base64VecU8(n.ciphertext.clone()),
                }
            })
            .collect()
    }

    pub fn claimable_balance(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    /// The `extDataHash` public input for `ext_data`, so clients can check their encoding.
    pub fn ext_data_hash(&self, ext_data: ExtData) -> String {
        let ephs = ext_data.validate();
        to_decimal(&ext_data.hash(&ephs))
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
    }
}
