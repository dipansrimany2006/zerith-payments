//! Incremental Poseidon Merkle tree (depth 20) with a ring buffer of recent roots.
//! Same algorithm and empty-leaf convention as contracts/ShieldedPool.sol, so roots match
//! the circuit and the frontend's poseidon-lite tree.

use ark_bn254::Fr;
use ark_ff::{BigInteger, Field as _, PrimeField, Zero};
use near_sdk::{env, near};

use crate::field::Field;
use crate::poseidon_constants::{C, FULL_ROUNDS, M, PARTIAL_ROUNDS, T};

pub const LEVELS: usize = 20;
pub const ROOT_HISTORY_SIZE: usize = 30;

#[inline(always)]
fn pow5(x: Fr) -> Fr {
    let x2 = x.square();
    x2.square() * x
}

/// circomlib Poseidon over BN254 for two inputs (t = 3, x^5, 8 full + 57 partial rounds).
/// Only the width the circuit uses is compiled in, which keeps the contract small.
pub fn poseidon2(a: Fr, b: Fr) -> Fr {
    let mut s = [Fr::zero(), a, b];
    let half = FULL_ROUNDS / 2;
    for r in 0..FULL_ROUNDS + PARTIAL_ROUNDS {
        for (i, si) in s.iter_mut().enumerate() {
            *si += C[r * T + i];
        }
        if r < half || r >= half + PARTIAL_ROUNDS {
            for si in s.iter_mut() {
                *si = pow5(*si);
            }
        } else {
            s[0] = pow5(s[0]);
        }
        s = [
            M[0][0] * s[0] + M[0][1] * s[1] + M[0][2] * s[2],
            M[1][0] * s[0] + M[1][1] * s[1] + M[1][2] * s[2],
            M[2][0] * s[0] + M[2][1] * s[1] + M[2][2] * s[2],
        ];
    }
    s[0]
}

pub struct Hasher;

impl Hasher {
    pub fn new() -> Self {
        Hasher
    }

    pub fn hash2(&mut self, a: &Field, b: &Field) -> Field {
        let fa = Fr::from_le_bytes_mod_order(a);
        let fb = Fr::from_le_bytes_mod_order(b);
        poseidon2(fa, fb)
            .into_bigint()
            .to_bytes_le()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_POSEIDON"))
    }
}

/// zeros[0] = 0, zeros[i+1] = H(zeros[i], zeros[i]); zeros[LEVELS] is the empty root.
pub fn compute_zeros(h: &mut Hasher) -> Vec<Field> {
    let mut zeros = vec![[0u8; 32]];
    for i in 0..LEVELS {
        let z = h.hash2(&zeros[i], &zeros[i]);
        zeros.push(z);
    }
    zeros
}

#[near(serializers = [borsh])]
pub struct MerkleTree {
    pub filled_subtrees: [Field; LEVELS],
    pub roots: [Field; ROOT_HISTORY_SIZE],
    pub next_index: u32,
    pub current_root_index: u32,
}

impl MerkleTree {
    pub fn new(zeros: &[Field]) -> Self {
        let mut filled_subtrees = [[0u8; 32]; LEVELS];
        filled_subtrees.copy_from_slice(&zeros[..LEVELS]);
        let mut roots = [[0u8; 32]; ROOT_HISTORY_SIZE];
        roots[0] = zeros[LEVELS];
        MerkleTree { filled_subtrees, roots, next_index: 0, current_root_index: 0 }
    }

    /// Inserts two sibling leaves at once (every transaction creates exactly two outputs).
    /// Hashing the pair first saves one full path: 20 hashes instead of 40.
    /// Returns the index of the left leaf.
    pub fn insert_pair(&mut self, h: &mut Hasher, zeros: &[Field], left: Field, right: Field) -> u32 {
        let leaf_index = self.next_index;
        if leaf_index as u64 + 2 > 1u64 << LEVELS {
            env::panic_str("ERR_TREE_FULL");
        }
        let mut idx = leaf_index / 2;
        let mut cur = h.hash2(&left, &right);
        for level in 1..LEVELS {
            if idx.is_multiple_of(2) {
                self.filled_subtrees[level] = cur;
                cur = h.hash2(&cur, &zeros[level]);
            } else {
                cur = h.hash2(&self.filled_subtrees[level], &cur);
            }
            idx /= 2;
        }
        self.current_root_index = (self.current_root_index + 1) % ROOT_HISTORY_SIZE as u32;
        self.roots[self.current_root_index as usize] = cur;
        self.next_index = leaf_index + 2;
        leaf_index
    }

    pub fn last_root(&self) -> Field {
        self.roots[self.current_root_index as usize]
    }

    pub fn is_known_root(&self, root: &Field) -> bool {
        if *root == [0u8; 32] {
            return false;
        }
        self.roots.iter().any(|r| r == root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{parse_u256, to_decimal};

    #[test]
    fn matches_circomlib_poseidon() {
        // poseidon-lite / circomlib: poseidon2([1, 2])
        let mut h = Hasher::new();
        let out = h.hash2(&parse_u256("1"), &parse_u256("2"));
        assert_eq!(
            to_decimal(&out),
            "7853200120776062878684798364095072458815029376092732009249414926327459813530"
        );
    }
}
