//! NIP-01 events: the exact JSON shape, id computation and Schnorr signatures.

use secp256k1::{Secp256k1, schnorr::Signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::keys::{Secret, is_lower_hex, xonly};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

/// What is signed: everything but `id`, `pubkey` and `sig`.
#[derive(Debug, Clone)]
pub struct Template {
    pub kind: u32,
    pub created_at: u64,
    pub tags: Vec<Vec<String>>,
    pub content: String,
}

/// `sha256(JSON.stringify([0, pubkey, created_at, kind, tags, content]))`. serde_json escapes
/// strings exactly like `JSON.stringify` (`\"`, `\\`, `\b\f\n\r\t`, other controls as `\u00XX`).
pub fn event_hash(
    pubkey: &str,
    created_at: u64,
    kind: u32,
    tags: &[Vec<String>],
    content: &str,
) -> [u8; 32] {
    let json =
        serde_json::to_string(&(0, pubkey, created_at, kind, tags, content)).expect("serializable");
    Sha256::digest(json.as_bytes()).into()
}

impl Event {
    /// Parse a JSON value with the shape checks of the TypeScript `isEvent` (field types only).
    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        let s = |k: &str| o.get(k)?.as_str().map(str::to_owned);
        // JSON numbers; signed events always use integers, anything else fails verification anyway.
        let n = |k: &str| o.get(k)?.as_u64();
        let tags = o
            .get("tags")?
            .as_array()?
            .iter()
            .map(|t| {
                t.as_array()?
                    .iter()
                    .map(|x| x.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            id: s("id")?,
            pubkey: s("pubkey")?,
            created_at: n("created_at")?,
            kind: u32::try_from(n("kind")?).ok()?,
            tags,
            content: s("content")?,
            sig: s("sig")?,
        })
    }

    pub fn from_json(json: &str) -> Option<Self> {
        Self::from_value(&serde_json::from_str(json).ok()?)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("serializable")
    }

    /// The id matches the content and the signature is valid (`verifyEvent`).
    pub fn verify(&self) -> bool {
        if !is_lower_hex(&self.id, 64) || !is_lower_hex(&self.sig, 128) {
            return false;
        }
        let Some(pk) = xonly(&self.pubkey) else {
            return false;
        };
        let hash = event_hash(
            &self.pubkey,
            self.created_at,
            self.kind,
            &self.tags,
            &self.content,
        );
        if hex::encode(hash) != self.id {
            return false;
        }
        let Ok(sig) = Signature::from_slice(&hex::decode(&self.sig).expect("checked hex")) else {
            return false;
        };
        Secp256k1::verification_only()
            .verify_schnorr(&sig, &hash, &pk)
            .is_ok()
    }

    /// Sign a template (BIP-340 with random auxiliary data, as nostr-tools does).
    pub fn sign(secret: &Secret, t: Template) -> Self {
        let pubkey = secret.public_hex();
        let hash = event_hash(&pubkey, t.created_at, t.kind, &t.tags, &t.content);
        let mut aux = [0u8; 32];
        getrandom::fill(&mut aux).expect("OS randomness");
        let sig =
            Secp256k1::signing_only().sign_schnorr_with_aux_rand(&hash, &secret.keypair(), &aux);
        Self {
            id: hex::encode(hash),
            pubkey,
            created_at: t.created_at,
            kind: t.kind,
            tags: t.tags,
            content: t.content,
            sig: hex::encode(sig.to_byte_array()),
        }
    }

    /// First value of the first tag named `name`.
    pub fn tag(&self, name: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|t| t.first().map(String::as_str) == Some(name))?
            .get(1)
            .map(String::as_str)
    }
}
