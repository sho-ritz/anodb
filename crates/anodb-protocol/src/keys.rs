//! secp256k1 keys: parsing (hex / NIP-19) and x-only public keys.

use nostr::key::{PublicKey, SecretKey};
use nostr::nips::nip19::{FromBech32, ToBech32};
use secp256k1::{Keypair, Secp256k1, SecretKey as RawSecretKey, XOnlyPublicKey};

use crate::Error;

/// A 32-byte secp256k1 secret key.
#[derive(Clone)]
pub struct Secret(pub(crate) RawSecretKey);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<sensitive>)")
    }
}

impl Secret {
    /// 32 raw bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        RawSecretKey::from_slice(bytes)
            .map(Self)
            .map_err(|_| Error::Key("secret key must be 32 valid bytes"))
    }

    /// 64-char hex (any case) or `nsec1…`, like the TypeScript `parseSecretKey`.
    pub fn parse(input: &str) -> Result<Self, Error> {
        let s = input.trim();
        if s.starts_with("nsec1") {
            let k = SecretKey::from_bech32(s).map_err(|_| Error::Key("expected nsec"))?;
            return Self::from_bytes(k.as_secret_bytes());
        }
        if is_hex(s, 64) {
            return Self::from_bytes(&hex::decode(s.to_ascii_lowercase()).expect("checked hex"));
        }
        Err(Error::Key("unrecognised secret key format"))
    }

    /// A fresh random key (throwaway envelope keys, new devices).
    pub fn generate() -> Self {
        loop {
            let mut b = [0u8; 32];
            getrandom::fill(&mut b).expect("OS randomness");
            if let Ok(k) = RawSecretKey::from_slice(&b) {
                return Self(k);
            }
        }
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        self.0.secret_bytes()
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.to_bytes())
    }

    /// x-only public key, lowercase hex.
    pub fn public_hex(&self) -> String {
        hex::encode(self.keypair().x_only_public_key().0.serialize())
    }

    pub fn nsec(&self) -> String {
        SecretKey::from_slice(&self.to_bytes())
            .expect("valid")
            .to_bech32()
            .expect("bech32")
    }

    pub(crate) fn keypair(&self) -> Keypair {
        Keypair::from_secret_key(&Secp256k1::signing_only(), &self.0)
    }
}

/// Hex or `npub1…` → lowercase hex, like the TypeScript `parsePubkey`.
pub fn parse_pubkey(input: &str) -> Result<String, Error> {
    let s = input.trim();
    if s.starts_with("npub1") {
        let k = PublicKey::from_bech32(s).map_err(|_| Error::Key("expected npub"))?;
        return Ok(k.to_hex());
    }
    if is_hex(s, 64) {
        return Ok(s.to_ascii_lowercase());
    }
    Err(Error::Key("unrecognised public key format"))
}

/// NIP-19 `npub1…` of a hex public key.
pub fn npub(pubkey_hex: &str) -> Result<String, Error> {
    let k = PublicKey::from_hex(pubkey_hex).map_err(|_| Error::Key("invalid public key"))?;
    k.to_bech32().map_err(|_| Error::Key("invalid public key"))
}

pub(crate) fn xonly(pubkey_hex: &str) -> Option<XOnlyPublicKey> {
    if !is_hex(pubkey_hex, 64) {
        return None;
    }
    XOnlyPublicKey::from_slice(&hex::decode(pubkey_hex).ok()?).ok()
}

/// `^[0-9a-f]{n}$` (lowercase only).
pub fn is_lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit())
}
