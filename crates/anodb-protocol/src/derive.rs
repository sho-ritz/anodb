//! Routing tags and ids derived from secrets (PROTOCOL.md §2, §5).

use sha2::{Digest, Sha256};

fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

fn h32(s: &str) -> String {
    sha256_hex(s)[..32].to_owned()
}

/// Tag of a space stream for one key epoch. Only holders of the key can compute it.
pub fn space_tag(epoch_key: &[u8; 32]) -> String {
    h32(&format!("anodb/v2/space/{}", hex::encode(epoch_key)))
}

/// Tag of a device inbox (key delivery, invitations, pairing).
pub fn inbox_tag(device_pubkey: &str) -> String {
    h32(&format!("anodb/v2/inbox/{device_pubkey}"))
}

/// Tag of a pairing secret.
pub fn secret_tag(secret: &str) -> String {
    h32(&format!("anodb/v2/secret-tag/{secret}"))
}

/// Symmetric conversation key of a pairing secret.
pub fn secret_key_for(secret: &str) -> [u8; 32] {
    Sha256::digest(format!("anodb/v2/secret-key/{secret}").as_bytes()).into()
}

/// 16-hex id of an epoch key (`ep` in messages).
pub fn key_id(epoch_key: &[u8; 32]) -> String {
    h32(&format!("anodb/v2/key-id/{}", hex::encode(epoch_key)))[..16].to_owned()
}

/// Space id; only the owner can produce the matching `create` op.
pub fn space_id(owner: &str, nonce: &str) -> String {
    h32(&format!("anodb/v2/space-id/{owner}/{nonce}"))
}
