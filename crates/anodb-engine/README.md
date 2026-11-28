# anodb-engine

One device's anoDB database in Rust, on top of [`anodb-protocol`](../anodb-protocol). It stores
data the same way as the TypeScript implementation and speaks the same wire protocol, so Rust and
TypeScript devices share spaces.

- **Storage (SQLite).** Every accepted message is kept in `anodb_messages`, and `anodb_cells` holds
  one last-writer-wins register per (space, table, row, column). Each schema table is a plain SQLite
  table rebuilt from the cells, with `space`, `id`, your columns, `createdAt`, `updatedAt`,
  `createdBy` and `updatedBy`. When membership changes, the space is rebuilt from its message log.
- **Writes.** `insert` / `update` / `delete` are checked against the row rule (plain, owned and
  confirmed tables), then signed, encrypted and queued in the outbox.
- **Spaces.**
  - Create spaces, add members (with an invitation), rotate keys and post snapshots. `post_op` sends
    any other membership op.
  - On the receiving side: accept or decline invitations, and catch up from a snapshot.
- **Relay.** `relay::sync_once(&mut engine, "ws://…", timeout)` publishes the outbox, subscribes to
  the engine's routing tags and ingests until the relay has nothing new. `wss://` relays need the
  `tls` feature.
- **Secrets at rest.** Device keys, identity keys and epoch keys go through a `KeyStore`
  (`PlainKeyStore` by default). Native SDKs plug in the platform key store.

```rust
use anodb_engine::{ColumnType, Engine, Options, Schema, TableDef};

let schema = Schema::new().table("todo", TableDef::new(&[("title", ColumnType::Text)]))?;
let mut db = Engine::open(Options::new("app.sqlite", schema))?;
let space = db.create_space("Family")?;
db.insert(Some(&space), "todo", &serde_json::json!({ "title": "milk" }).as_object().unwrap().clone())?;
anodb_engine::relay::sync_once(&mut db, "ws://127.0.0.1:7777", std::time::Duration::from_secs(10))?;
```

`test/rust-interop.test.ts` checks interoperability end to end. A TypeScript device and
`examples/peer.rs` share spaces through a relay: each invites the other, and each one's writes
reach the other.

Not ported yet: device pairing and revocation, removal and leave helpers (the ops themselves work
through `post_op`), key rotation for stale keys and leaving members, NIP-77 and relay
auto-selection, blobs, ephemeral events and P2P delivery, and SQL writes captured from the tables
themselves (writes go through the methods above for now).
