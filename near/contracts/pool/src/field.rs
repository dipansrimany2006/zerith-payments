//! BN254 scalar-field helpers shared by the Merkle tree, the verifier and the public API.
//!
//! Field elements are kept as 32-byte little-endian arrays, the layout NEAR's alt_bn128 host
//! functions expect. The JSON API uses decimal strings, the format snarkjs and poseidon-lite
//! produce, so clients can pass values through unchanged.

use near_sdk::env;

pub type Field = [u8; 32];

/// BN254 scalar field modulus r, little-endian 64-bit limbs.
const R_LIMBS: [u64; 4] = [
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
];

/// Parses a decimal string into a 256-bit little-endian integer. Panics on bad input or overflow.
pub fn parse_u256(dec: &str) -> Field {
    if dec.is_empty() || dec.len() > 78 {
        env::panic_str("ERR_BAD_NUMBER");
    }
    let mut limbs = [0u64; 4];
    for ch in dec.bytes() {
        if !ch.is_ascii_digit() {
            env::panic_str("ERR_BAD_NUMBER");
        }
        let mut carry = (ch - b'0') as u128;
        for limb in limbs.iter_mut() {
            let v = (*limb as u128) * 10 + carry;
            *limb = v as u64;
            carry = v >> 64;
        }
        if carry != 0 {
            env::panic_str("ERR_NUMBER_OVERFLOW");
        }
    }
    let mut out = [0u8; 32];
    for (i, limb) in limbs.iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
    }
    out
}

fn limbs(x: &Field) -> [u64; 4] {
    let mut l = [0u64; 4];
    for (i, limb) in l.iter_mut().enumerate() {
        *limb = u64::from_le_bytes(x[i * 8..i * 8 + 8].try_into().unwrap());
    }
    l
}

/// True if `x < r`, i.e. `x` is a canonical scalar-field element.
pub fn in_field(x: &Field) -> bool {
    let l = limbs(x);
    for i in (0..4).rev() {
        if l[i] != R_LIMBS[i] {
            return l[i] < R_LIMBS[i];
        }
    }
    false
}

/// Parses a decimal string and requires it to be a canonical scalar-field element.
pub fn parse_field(dec: &str, err: &str) -> Field {
    let f = parse_u256(dec);
    if !in_field(&f) {
        env::panic_str(err);
    }
    f
}

/// Formats a 256-bit little-endian integer as a decimal string.
pub fn to_decimal(x: &Field) -> String {
    let mut l = limbs(x);
    if l == [0; 4] {
        return "0".to_string();
    }
    let mut digits = Vec::with_capacity(78);
    while l != [0; 4] {
        let mut rem: u128 = 0;
        for i in (0..4).rev() {
            let cur = (rem << 64) | l[i] as u128;
            l[i] = (cur / 10) as u64;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    digits.reverse();
    String::from_utf8(digits).unwrap()
}

pub fn from_u128(v: u128) -> Field {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&v.to_le_bytes());
    out
}

/// Maps a signed amount into the field: v for v >= 0, r - |v| otherwise.
pub fn from_i128(v: i128) -> Field {
    let abs = from_u128(v.unsigned_abs());
    if v >= 0 || abs == [0u8; 32] {
        return abs;
    }
    let x = limbs(&abs);
    let mut out = [0u64; 4];
    let mut borrow = 0u128;
    for i in 0..4 {
        let d = (R_LIMBS[i] as u128).wrapping_sub(x[i] as u128).wrapping_sub(borrow);
        out[i] = d as u64;
        borrow = (d >> 127) & 1;
    }
    let mut bytes = [0u8; 32];
    for (i, limb) in out.iter().enumerate() {
        bytes[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
    }
    bytes
}

/// sha256(data) with the top three bits cleared, read big-endian: always < r.
pub fn hash_to_field(data: &[u8]) -> Field {
    let mut h = env::sha256_array(data);
    h[0] &= 0x1f;
    h.reverse();
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_round_trip() {
        let r_minus_1 =
            "21888242871839275222246405745257275088548364400416034343698204186575808495616";
        let f = parse_u256(r_minus_1);
        assert!(in_field(&f));
        assert_eq!(to_decimal(&f), r_minus_1);

        let r = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
        assert!(!in_field(&parse_u256(r)));
        assert_eq!(to_decimal(&parse_u256("0")), "0");
        assert_eq!(to_decimal(&from_u128(20_000)), "20000");
    }

    #[test]
    fn negative_amounts_wrap_mod_r() {
        assert_eq!(
            to_decimal(&from_i128(-20_000)),
            "21888242871839275222246405745257275088548364400416034343698204186575808475617"
        );
        assert_eq!(to_decimal(&from_i128(0)), "0");
        assert_eq!(to_decimal(&from_i128(7)), "7");
    }
}
