//! anoDB wire protocol, version 2 — the shared core of every anoDB SDK.
//!
//! This crate is pure protocol: keys and delegations, NIP-44 envelopes, inner message validation,
//! hybrid logical clocks, last-writer-wins merge, the row rule and membership evaluation. It does
//! no I/O. Behaviour is pinned by the conformance vectors in `conformance/v2` (generated from the
//! TypeScript implementation), so all implementations interoperate.

pub mod derive;
pub mod direct;
pub mod envelope;
pub mod event;
pub mod hlc;
pub mod identity;
pub mod keys;
pub mod membership;
pub mod merge;
pub mod nip44;
pub mod payload;
pub mod policy;
pub mod snapshot;

pub use envelope::{EpochKey, OpenError, Opened, open_space, seal, seal_space, sign_inner};
pub use event::{Event, Template};
pub use keys::{Secret, npub, parse_pubkey};
pub use membership::{MemberOp, Membership, OpRecord, evaluate, parse_op};
pub use payload::{Body, Change, StreamPayload};
pub use policy::{Role, TableRule, change_allowed};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("anoDB: {0}")]
    Key(&'static str),
    #[error("anoDB: {0}")]
    Crypto(&'static str),
    #[error("anoDB: {0}")]
    Invalid(String),
}
