//! anoDB engine: one device's database in SQLite on top of [`anodb_protocol`].
//!
//! - [`Engine`] keeps the message log, merges cells (last writer wins), evaluates membership and
//!   rebuilds the projection tables (one SQLite table per schema table, read with plain SQL).
//! - Writes go through [`Engine::insert`] / [`Engine::update`] / [`Engine::delete`]; they are
//!   checked against the row rule, signed, encrypted and queued in the outbox.
//! - [`relay::sync_once`] publishes the outbox to a relay and ingests what the relay has.
//!
//! Interoperates with the TypeScript implementation (same wire protocol, same rules).

mod engine;
pub mod relay;
pub mod schema;

pub use engine::{
    Engine, Ingest, Invitation, KeyStore, MAX_BODY_BYTES, Options, PlainKeyStore, SNAPSHOT_EVERY,
    SpaceInfo,
};
pub use schema::{ColumnType, Schema, TableDef};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("anoDB: {0}")]
    Invalid(String),
    #[error("anoDB: {0}")]
    Unauthorized(String),
    #[error("anoDB: relay: {0}")]
    Relay(String),
    #[error(transparent)]
    Protocol(#[from] anodb_protocol::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
}
