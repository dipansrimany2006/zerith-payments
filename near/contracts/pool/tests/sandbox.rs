//! End-to-end join-split scenario and gas benchmark on a local NEAR sandbox.
//!
//! Requires prebuilt wasm (`near/scripts/build.sh`) and the proof fixture from
//! `near/zk/gen-fixture.ts`. Run: `cargo test -p zerith-pool --test sandbox -- --nocapture`.
//!
//! Scenario (all amounts USDC base units, 6 decimals):
//!   1. Alice deposits 1_500_000.
//!   2. Alice privately pays Bob 400_000 (relayer fee 20_000, change 1_080_000).
//!   3. Bob withdraws 390_000 to bob.test.near (relayer fee 10_000).
//!   4. Alice withdraws 1_000_000 to carol.test.near, which is not registered with USDC, so the
//!      payout is deferred; Carol registers and claims it. Alice keeps 80_000 in the pool.

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const POOL_WASM: &str = "../../target/near/zerith_pool/zerith_pool.wasm";
const FT_WASM: &str = "../../target/near/mock_ft/mock_ft.wasm";
const FIXTURE: &str = "tests/fixtures/transact.json";
const MAX_GAS: Gas = Gas::from_tgas(300);

fn path(rel: &str) -> String {
    format!("{}/{}", env!("CARGO_MANIFEST_DIR"), rel)
}

fn tgas(g: u64) -> f64 {
    g as f64 / 1e12
}

/// Gas burnt by receipts executed on `executor`.
fn gas_on(res: &ExecutionFinalResult, executor: &str) -> u64 {
    res.receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id.as_str() == executor)
        .map(|o| o.gas_burnt.as_gas())
        .sum()
}

fn assert_no_failures(res: &ExecutionFinalResult, what: &str) {
    let failures = res.receipt_failures();
    assert!(failures.is_empty(), "{what} had failing receipts: {failures:#?}");
}

fn error_text(res: ExecutionFinalResult) -> String {
    format!("{:?}", res.into_result().expect_err("expected failure"))
}

async fn ft_balance(ft: &Contract, account: &Account) -> anyhow::Result<u128> {
    let v: String = ft.view("ft_balance_of").args_json(json!({ "account_id": account.id() })).await?.json()?;
    Ok(v.parse()?)
}

async fn claimable(pool: &Contract, account: &Account) -> anyhow::Result<u128> {
    let v: String =
        pool.view("claimable_balance").args_json(json!({ "account_id": account.id() })).await?.json()?;
    Ok(v.parse()?)
}

async fn root(pool: &Contract) -> anyhow::Result<String> {
    Ok(pool.view("get_last_root").await?.json()?)
}

async fn deposit(from: &Account, ft: &Contract, pool: &Contract, amount: u128, step: &Value) -> anyhow::Result<ExecutionFinalResult> {
    let msg = json!({ "proof_args": step["proof_args"], "ext_data": step["ext_data"] }).to_string();
    Ok(from
        .call(ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": pool.id(), "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?)
}

async fn transact(from: &Account, pool: &Contract, proof_args: &Value, ext_data: &Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(pool.id(), "transact")
        .args_json(json!({ "proof_args": proof_args, "ext_data": ext_data }))
        .gas(MAX_GAS)
        .transact()
        .await?)
}

#[tokio::test]
async fn join_split_scenario_and_gas_report() -> anyhow::Result<()> {
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(path(FIXTURE))?)?;
    let worker = near_workspaces::sandbox().await?;
    let root_acc = worker.root_account()?;

    let mut accounts = Vec::new();
    for (name, near) in [("usdc", 10), ("pool", 40), ("alice", 5), ("bob", 5), ("relayer", 5), ("carol", 5)] {
        let acc = root_acc
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(near))
            .transact()
            .await?
            .into_result()?;
        accounts.push(acc);
    }
    let [ft_acc, pool_acc, alice, bob, relayer, carol]: [Account; 6] = accounts.try_into().unwrap();
    assert_eq!(relayer.id().as_str(), fx["relayer"].as_str().unwrap());

    let ft = ft_acc.deploy(&std::fs::read(path(FT_WASM))?).await?.into_result()?;
    let pool = pool_acc.deploy(&std::fs::read(path(POOL_WASM))?).await?.into_result()?;
    ft.call("new").transact().await?.into_result()?;
    let init = pool
        .call("new")
        .args_json(json!({ "owner": root_acc.id(), "usdc": ft.id() }))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_no_failures(&init, "init");

    // Register everyone except Carol with the token; fund Alice.
    for acc in [pool.as_account(), &bob, &relayer] {
        ft.call("mint").args_json(json!({ "account_id": acc.id(), "amount": "0" })).transact().await?.into_result()?;
    }
    ft.call("mint")
        .args_json(json!({ "account_id": alice.id(), "amount": "10000000" }))
        .transact()
        .await?
        .into_result()?;

    // --- Encoding parity with the TypeScript client.
    assert_eq!(root(&pool).await?, fx["empty_root"].as_str().unwrap(), "empty root mismatch");
    let h: String = pool
        .view("ext_data_hash")
        .args_json(json!({ "ext_data": fx["transfer"]["ext_data"] }))
        .await?
        .json()?;
    assert_eq!(h, fx["checks"]["transfer_ext_data_hash"].as_str().unwrap(), "extDataHash mismatch");

    // --- 1. Deposit.
    let dep = &fx["deposit"];
    let wrong = deposit(&alice, &ft, &pool, 1_400_000, dep).await?;
    assert!(!wrong.receipt_failures().is_empty(), "amount mismatch must fail");
    assert_eq!(ft_balance(&ft, pool.as_account()).await?, 0, "mismatched deposit must be refunded");

    let via_transact = transact(&relayer, &pool, &dep["proof_args"], &dep["ext_data"]).await?;
    assert!(error_text(via_transact).contains("ERR_DEPOSIT_VIA_FT_TRANSFER_CALL"));

    let res = deposit(&alice, &ft, &pool, 1_500_000, dep).await?;
    assert_no_failures(&res, "deposit");
    let gas_deposit = gas_on(&res, pool.id().as_str());
    let gas_deposit_total = res.total_gas_burnt.as_gas();
    assert_eq!(root(&pool).await?, dep["root_after"].as_str().unwrap(), "root after deposit");
    assert_eq!(ft_balance(&ft, pool.as_account()).await?, 1_500_000);

    // --- 2. Private transfer to Bob, submitted by the relayer.
    let tr = &fx["transfer"];
    let tampered = transact(&relayer, &pool, &tr["proof_args"], &fx["tampered_transfer_ext_data"]).await?;
    assert!(error_text(tampered).contains("ERR_INVALID_PROOF"), "changed fee must break the proof");

    let res = transact(&relayer, &pool, &tr["proof_args"], &tr["ext_data"]).await?;
    assert_no_failures(&res, "transfer");
    let gas_transfer = res.total_gas_burnt.as_gas();
    assert_eq!(root(&pool).await?, tr["root_after"].as_str().unwrap(), "root after transfer");
    assert_eq!(ft_balance(&ft, pool.as_account()).await?, 1_500_000, "no USDC moves on a private transfer");
    assert_eq!(claimable(&pool, &relayer).await?, 20_000);

    // --- 3. Bob withdraws to his own account.
    let wb = &fx["withdraw_bob"];
    let res = transact(&relayer, &pool, &wb["proof_args"], &wb["ext_data"]).await?;
    assert_no_failures(&res, "withdraw bob");
    let gas_withdraw_receipt = res.receipt_outcomes()[0].gas_burnt.as_gas();
    let gas_withdraw_total = res.total_gas_burnt.as_gas();
    assert_eq!(ft_balance(&ft, &bob).await?, 390_000);
    assert_eq!(claimable(&pool, &relayer).await?, 30_000);

    let replay = transact(&relayer, &pool, &wb["proof_args"], &wb["ext_data"]).await?;
    assert!(error_text(replay).contains("ERR_NULLIFIER_SPENT"), "double spend must fail");

    // --- 4. Withdrawal to an unregistered account is held for the recipient to claim.
    let wc = &fx["withdraw_carol"];
    let res = transact(&relayer, &pool, &wc["proof_args"], &wc["ext_data"]).await?;
    assert!(res.is_success(), "transact itself succeeds; only the payout transfer fails");
    assert_eq!(root(&pool).await?, wc["root_after"].as_str().unwrap(), "root after withdraw");
    assert_eq!(claimable(&pool, &carol).await?, 1_000_000);

    ft.call("mint").args_json(json!({ "account_id": carol.id(), "amount": "0" })).transact().await?.into_result()?;
    carol.call(pool.id(), "claim").gas(MAX_GAS).transact().await?.into_result()?;
    assert_eq!(ft_balance(&ft, &carol).await?, 1_000_000);
    assert_eq!(claimable(&pool, &carol).await?, 0);

    relayer.call(pool.id(), "claim").gas(MAX_GAS).transact().await?.into_result()?;
    assert_eq!(ft_balance(&ft, &relayer).await?, 30_000);

    // Alice's 80_000 change note is all that is left.
    assert_eq!(ft_balance(&ft, pool.as_account()).await?, 80_000);
    let count: u32 = pool.view("notes_count").await?.json()?;
    assert_eq!(count, 8);
    let notes: Value = pool.view("get_notes").args_json(json!({ "from_index": 2, "limit": 2 })).await?.json()?;
    assert_eq!(
        notes[0]["ciphertext"], tr["ext_data"]["encrypted_outputs"][0]["ciphertext"],
        "stored ciphertext must match what was sent"
    );

    println!("\n=== Zerith NEAR join-split pool: gas report (sandbox) ===");
    println!("contract wasm size              : {} bytes", std::fs::metadata(path(POOL_WASM))?.len());
    println!("init                            : {:>7.2} Tgas", tgas(init.total_gas_burnt.as_gas()));
    println!("deposit (pool receipt)          : {:>7.2} Tgas", tgas(gas_deposit));
    println!("deposit (whole tx incl. FT)     : {:>7.2} Tgas", tgas(gas_deposit_total));
    println!("private transfer (whole tx)     : {:>7.2} Tgas", tgas(gas_transfer));
    println!("withdraw (verify + tree)        : {:>7.2} Tgas", tgas(gas_withdraw_receipt));
    println!("withdraw (whole tx incl. payout): {:>7.2} Tgas", tgas(gas_withdraw_total));
    Ok(())
}
