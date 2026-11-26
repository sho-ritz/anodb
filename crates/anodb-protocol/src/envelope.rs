//! Envelopes (kind 7303): sealing inner messages and opening space-stream envelopes with the exact
//! checks, in the exact order, of the TypeScript implementation (PROTOCOL.md §2–3).

use crate::Error;
use crate::derive::{key_id, space_tag};
use crate::event::{Event, Template};
use crate::identity::verify_delegation;
use crate::keys::Secret;
use crate::nip44;
use crate::payload::{MESSAGE_KIND, StreamPayload, TAG, WRAP_KIND};

/// Largest inner message JSON that is sealed (below the NIP-44 limit).
pub const MAX_INNER_BYTES: usize = 65_000;
/// Envelopes with longer content are not even decrypted.
pub const MAX_ENVELOPE_CONTENT: usize = 120_000;

/// An epoch key of a space and what is derived from it.
#[derive(Clone)]
pub struct EpochKey {
    pub space: String,
    pub key: [u8; 32],
    pub key_id: String,
    pub tag: String,
}

impl EpochKey {
    pub fn new(space: &str, key: [u8; 32]) -> Self {
        Self {
            space: space.into(),
            key_id: key_id(&key),
            tag: space_tag(&key),
            key,
        }
    }
}

/// Seal an inner message JSON into an envelope for `tag`, encrypted with `conversation_key` and
/// signed by `signer` (a throwaway key by default, see `seal_space`).
pub fn seal(
    inner_json: &str,
    tag: &str,
    conversation_key: &[u8; 32],
    signer: &Secret,
    created_at: u64,
) -> Result<Event, Error> {
    if inner_json.len() > MAX_INNER_BYTES {
        return Err(Error::Invalid("message too large".into()));
    }
    Ok(Event::sign(
        signer,
        Template {
            kind: WRAP_KIND,
            created_at,
            tags: vec![vec![TAG.into(), tag.into()]],
            content: nip44::encrypt(inner_json, conversation_key)?,
        },
    ))
}

/// Seal a message to a space stream with a fresh throwaway key.
pub fn seal_space(inner: &Event, key: &EpochKey, created_at: u64) -> Result<Event, Error> {
    seal(
        &inner.to_json(),
        &key.tag,
        &key.key,
        &Secret::generate(),
        created_at,
    )
}

/// Sign an inner message (kind 7305) with the device key.
pub fn sign_inner(device: &Secret, payload_json: String, created_at: u64) -> Event {
    Event::sign(
        device,
        Template {
            kind: MESSAGE_KIND,
            created_at,
            tags: vec![],
            content: payload_json,
        },
    )
}

/// Why an envelope was refused. Names match the conformance vectors and the TypeScript error codes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpenError {
    #[error("not an anoDB envelope")]
    Invalid,
    #[error("routing tag is not a known space key")]
    UnknownTag,
    #[error("could not decrypt envelope")]
    DecryptFailed,
    #[error("inner message is invalid: {0}")]
    InvalidEvent(&'static str),
    #[error("unknown message format or newer protocol version")]
    UnsupportedProtocol,
}

impl OpenError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::UnknownTag => "unknown-tag",
            Self::DecryptFailed => "decrypt-failed",
            Self::InvalidEvent(_) => "invalid-event",
            Self::UnsupportedProtocol => "unsupported-protocol",
        }
    }
}

/// A verified message from a space stream.
#[derive(Debug, Clone)]
pub struct Opened {
    pub space: String,
    pub tag: String,
    /// Device public key that signed the inner message.
    pub device: String,
    /// Identity that delegated to that device.
    pub identity: String,
    /// Inner event id (message id).
    pub msg_id: String,
    pub inner: Event,
    pub payload: StreamPayload,
}

/// Open a space-stream envelope. `key_for_tag` returns the epoch key of a routing tag, if known.
pub fn open_space<'k>(
    outer: &Event,
    key_for_tag: impl Fn(&str) -> Option<&'k EpochKey>,
) -> Result<Opened, OpenError> {
    if outer.kind != WRAP_KIND {
        return Err(OpenError::Invalid);
    }
    let tag = outer.tag(TAG).ok_or(OpenError::Invalid)?;
    let ek = key_for_tag(tag).ok_or(OpenError::UnknownTag)?;
    if outer.content.len() > MAX_ENVELOPE_CONTENT || !outer.verify() {
        return Err(OpenError::Invalid);
    }
    let inner_json =
        nip44::decrypt(&outer.content, &ek.key).map_err(|_| OpenError::DecryptFailed)?;
    let inner_value: serde_json::Value =
        serde_json::from_str(&inner_json).map_err(|_| OpenError::DecryptFailed)?;
    let inner = Event::from_value(&inner_value).ok_or(OpenError::InvalidEvent("malformed"))?;
    if inner.kind != MESSAGE_KIND || !inner.verify() {
        return Err(OpenError::InvalidEvent("badly signed"));
    }
    let payload = StreamPayload::parse(&inner.content).ok_or(OpenError::UnsupportedProtocol)?;
    if payload.space != ek.space || payload.key_id != ek.key_id {
        return Err(OpenError::InvalidEvent(
            "header does not match its envelope",
        ));
    }
    let identity = verify_delegation(&payload.delegation, &inner.pubkey)
        .ok_or(OpenError::InvalidEvent("no valid delegation"))?;
    Ok(Opened {
        space: ek.space.clone(),
        tag: tag.to_owned(),
        device: inner.pubkey.clone(),
        identity,
        msg_id: inner.id.clone(),
        inner,
        payload,
    })
}
