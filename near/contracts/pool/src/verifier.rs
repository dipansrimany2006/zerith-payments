//! Groth16 verification over BN254 using NEAR's native alt_bn128 host functions.
//!
//! Checks e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1, where
//! vk_x = IC[0] + Σ public[i] · IC[i+1].

use near_sdk::env;
use near_sdk::near;

use crate::field::{parse_u256, Field};
use crate::vk;

/// A Groth16 proof in snarkjs JSON layout, coordinates as decimal strings.
/// `b` is `[[x.c0, x.c1], [y.c0, y.c1]]`, exactly as in snarkjs `proof.json` (`pi_b`).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Groth16Proof {
    pub a: [String; 2],
    pub b: [[String; 2]; 2],
    pub c: [String; 2],
}

struct Encoded {
    a: [u8; 64],
    b: [u8; 128],
    c: [u8; 64],
}

fn encode(p: &Groth16Proof) -> Encoded {
    let g1 = |xy: &[String; 2]| {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&parse_u256(&xy[0]));
        out[32..].copy_from_slice(&parse_u256(&xy[1]));
        out
    };
    let mut b = [0u8; 128];
    b[..32].copy_from_slice(&parse_u256(&p.b[0][0]));
    b[32..64].copy_from_slice(&parse_u256(&p.b[0][1]));
    b[64..96].copy_from_slice(&parse_u256(&p.b[1][0]));
    b[96..].copy_from_slice(&parse_u256(&p.b[1][1]));
    Encoded { a: g1(&p.a), b, c: g1(&p.c) }
}

/// Verifies `proof` against the embedded verifying key. Public inputs must already be
/// canonical field elements. Malformed curve points make the host function abort the call.
pub fn verify(proof: &Groth16Proof, public: &[Field; vk::N_PUBLIC]) -> bool {
    let p = encode(proof);

    // vk_x = 1·IC[0] + Σ public[i]·IC[i+1]
    let mut msm = Vec::with_capacity((vk::N_PUBLIC + 1) * 96);
    let mut one = [0u8; 32];
    one[0] = 1;
    msm.extend_from_slice(&vk::IC[0]);
    msm.extend_from_slice(&one);
    for (i, input) in public.iter().enumerate() {
        msm.extend_from_slice(&vk::IC[i + 1]);
        msm.extend_from_slice(input);
    }
    let vk_x = env::alt_bn128_g1_multiexp(&msm);

    // -A, via g1_sum with the "subtract" sign flag.
    let mut neg = Vec::with_capacity(65);
    neg.push(1u8);
    neg.extend_from_slice(&p.a);
    let neg_a = env::alt_bn128_g1_sum(&neg);

    let mut pairs = Vec::with_capacity(4 * 192);
    pairs.extend_from_slice(&neg_a);
    pairs.extend_from_slice(&p.b);
    pairs.extend_from_slice(&vk::ALPHA_G1);
    pairs.extend_from_slice(&vk::BETA_G2);
    pairs.extend_from_slice(&vk_x);
    pairs.extend_from_slice(&vk::GAMMA_G2);
    pairs.extend_from_slice(&p.c);
    pairs.extend_from_slice(&vk::DELTA_G2);
    env::alt_bn128_pairing_check(&pairs)
}
