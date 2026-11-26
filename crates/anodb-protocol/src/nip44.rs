//! NIP-44 v2 (via rust-nostr), limited to what other implementations can decrypt.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use nostr::nips::nip44::v2::{self, ConversationKey};

use crate::Error;
use crate::keys::Secret;

/// NIP-44 v2 as implemented by nostr-tools: plaintext of 1–65535 bytes.
pub const MAX_PLAINTEXT: usize = 65_535;

/// ECDH conversation key between a secret key and someone's public key.
pub fn conversation_key(secret: &Secret, pubkey_hex: &str) -> Result<[u8; 32], Error> {
    let sk = nostr::key::SecretKey::from_slice(&secret.to_bytes())
        .map_err(|_| Error::Key("invalid secret key"))?;
    let pk = nostr::key::PublicKey::from_hex(pubkey_hex)
        .map_err(|_| Error::Key("invalid public key"))?;
    let ck = ConversationKey::derive(&sk, &pk).map_err(|_| Error::Crypto("ECDH failed"))?;
    Ok(ck.as_bytes().try_into().expect("32 bytes"))
}

pub fn encrypt(plaintext: &str, conversation_key: &[u8; 32]) -> Result<String, Error> {
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce).expect("OS randomness");
    encrypt_with_nonce(plaintext, conversation_key, nonce)
}

/// Deterministic encryption for test vectors. Never reuse a nonce.
pub fn encrypt_with_nonce(
    plaintext: &str,
    conversation_key: &[u8; 32],
    nonce: [u8; 32],
) -> Result<String, Error> {
    if plaintext.is_empty() || plaintext.len() > MAX_PLAINTEXT {
        return Err(Error::Crypto("NIP-44 plaintext must be 1–65535 bytes"));
    }
    let bytes = v2::encrypt_to_bytes_with_nonce(
        &ConversationKey::new(*conversation_key),
        plaintext.as_bytes(),
        nonce,
    )
    .map_err(|_| Error::Crypto("encryption failed"))?;
    Ok(STANDARD.encode(bytes))
}

pub fn decrypt(payload: &str, conversation_key: &[u8; 32]) -> Result<String, Error> {
    let bad = || Error::Crypto("could not decrypt");
    // Base64 of the largest payload nostr-tools produces (65535 bytes of plaintext, padded).
    if payload.len() > 87_472 || payload.starts_with('#') {
        return Err(bad());
    }
    let raw = STANDARD.decode(payload).map_err(|_| bad())?;
    if raw.first() != Some(&2) {
        return Err(bad());
    }
    let plain =
        v2::decrypt_to_bytes(&ConversationKey::new(*conversation_key), &raw).map_err(|_| bad())?;
    if plain.is_empty() || plain.len() > MAX_PLAINTEXT {
        return Err(bad());
    }
    String::from_utf8(plain).map_err(|_| bad())
}
