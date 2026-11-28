//! The engine: one device's anoDB database in SQLite.
//!
//! Same storage model as the TypeScript implementation: every accepted message is kept in
//! `anodb_messages`, `anodb_cells` holds one last-writer-wins register per (space, table, row,
//! column), and each schema table is a projection rebuilt from the cells. A space is re-evaluated
//! from its message log whenever its membership changes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anodb_protocol::derive::{inbox_tag, space_id};
use anodb_protocol::direct::{
    KeyGrant, grant_role, open_inbox, parse_key_grant, portable_op, seal_to_device,
};
use anodb_protocol::envelope::{MAX_INNER_BYTES, seal};
use anodb_protocol::hlc::{self, Clock};
use anodb_protocol::identity::{create_delegation, verify_delegation};
use anodb_protocol::membership::{Membership, OpRecord, evaluate, parse_op};
use anodb_protocol::payload::{Body, Change, StreamPayload, TAG, WRAP_KIND};
use anodb_protocol::policy::{SYS_CREATED, SYS_DELETED, owner_of_row};
use anodb_protocol::snapshot::{
    SnapshotMessage, assemble_snapshots, snapshot_cells, snapshot_changes, snapshot_trusted,
};
use anodb_protocol::{EpochKey, Event, Role, Secret, change_allowed, open_space, sign_inner};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value, json};

use crate::EngineError;
use crate::schema::{Schema, check_value, create_table_sql, fingerprint, quote_ident, to_sql};

/// Largest JSON of the changes in one `ch` message (and of one snapshot part's items).
pub const MAX_BODY_BYTES: usize = 44 * 1024;
/// An owner / admin posts a snapshot after this many change messages since the last one.
pub const SNAPSHOT_EVERY: u64 = 1000;

const INTERNAL_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS anodb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, personal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anodb_keys (
  space TEXT NOT NULL, key_id TEXT NOT NULL, num INTEGER NOT NULL, sealed BLOB NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (space, key_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_messages (
  space TEXT NOT NULL, device TEXT NOT NULL, seq INTEGER NOT NULL, identity TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, msg_id TEXT NOT NULL, inner TEXT NOT NULL DEFAULT '', received_at INTEGER NOT NULL,
  PRIMARY KEY (space, device, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS anodb_messages_type ON anodb_messages (space, type);
CREATE TABLE IF NOT EXISTS anodb_devices (
  device TEXT PRIMARY KEY, identity TEXT NOT NULL, delegation TEXT NOT NULL, name TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS anodb_invites_in (space TEXT PRIMARY KEY, sender TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, received_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_cells (
  space TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT NOT NULL, hlc TEXT NOT NULL, by TEXT,
  PRIMARY KEY (space, tbl, row_id, col)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_raw (id TEXT PRIMARY KEY, tag TEXT NOT NULL, created_at INTEGER NOT NULL, event TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS anodb_raw_tag ON anodb_raw (tag, created_at);
CREATE TABLE IF NOT EXISTS anodb_outbox (id TEXT PRIMARY KEY, event TEXT NOT NULL, queued_at INTEGER NOT NULL);
";

/// Seals secrets at rest (device / identity keys, epoch keys). Native SDKs plug in the platform
/// key store (Keychain, Android Keystore, …).
pub trait KeyStore: Send + Sync {
    fn seal(&self, plain: &[u8]) -> Vec<u8>;
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, EngineError>;
}

/// Stores secrets unencrypted. For tests and for hosts that encrypt the database file themselves.
pub struct PlainKeyStore;

impl KeyStore for PlainKeyStore {
    fn seal(&self, plain: &[u8]) -> Vec<u8> {
        plain.to_vec()
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, EngineError> {
        Ok(sealed.to_vec())
    }
}

pub struct Options {
    /// SQLite file, or `:memory:`.
    pub path: String,
    pub schema: Schema,
    pub key_store: Box<dyn KeyStore>,
    /// The identity key, when this device holds it. Without it (and without one stored from an
    /// earlier open) a new identity is created.
    pub identity: Option<Secret>,
    /// Name of this device in its delegation.
    pub device_name: String,
    /// Wall clock in milliseconds (tests replace it).
    pub now: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
}

impl Options {
    pub fn new(path: &str, schema: Schema) -> Self {
        Self {
            path: path.into(),
            schema,
            key_store: Box::new(PlainKeyStore),
            identity: None,
            device_name: "device".into(),
            now: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ingest {
    New,
    Seen,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceInfo {
    pub id: String,
    pub name: String,
    pub personal: bool,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    pub space: String,
    pub name: String,
    pub role: Role,
    pub from: String,
}

struct Key {
    ek: EpochKey,
    num: u64,
}

pub struct Engine {
    db: Connection,
    schema: Schema,
    key_store: Box<dyn KeyStore>,
    pubkey: String,
    device: Secret,
    device_pubkey: String,
    delegation: Event,
    clock: Clock<Box<dyn Fn() -> u64 + Send + Sync>>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// Per space, newest first (highest num, then lowest key id).
    keys: HashMap<String, Vec<Key>>,
    membership: HashMap<String, Membership>,
    personal: String,
    depth: u32,
}

fn system_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).expect("system randomness");
    hex::encode(b)
}

fn sql_text(v: &SqlValue) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => json!(i),
        SqlValue::Real(f) => json!(f),
        SqlValue::Text(s) => Value::String(s.clone()),
        SqlValue::Blob(b) => Value::String(hex::encode(b)),
    }
}

impl Engine {
    pub fn open(opts: Options) -> Result<Self, EngineError> {
        let db = Connection::open(&opts.path)?;
        db.execute_batch(INTERNAL_SCHEMA)?;
        let now = opts.now.unwrap_or_else(|| Arc::new(system_now));
        let meta = |k: &str| -> Result<Option<String>, EngineError> {
            Ok(db
                .query_row("SELECT value FROM anodb_meta WHERE key = ?", [k], |r| {
                    r.get(0)
                })
                .optional()?)
        };
        let set_meta = |k: &str, v: &str| -> Result<(), EngineError> {
            db.execute(
                "INSERT INTO anodb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [k, v],
            )?;
            Ok(())
        };
        let ks = &opts.key_store;
        let load_secret = |k: &str| -> Result<Option<Secret>, EngineError> {
            match meta(k)? {
                None => Ok(None),
                Some(h) => {
                    let sealed = hex::decode(h).map_err(|e| EngineError::Invalid(e.to_string()))?;
                    Ok(Some(Secret::from_bytes(&ks.open(&sealed)?)?))
                }
            }
        };
        let store_secret = |k: &str, s: &Secret| set_meta(k, &hex::encode(ks.seal(&s.to_bytes())));

        let device = match load_secret("device_sk")? {
            Some(d) => d,
            None => {
                let d = Secret::generate();
                store_secret("device_sk", &d)?;
                d
            }
        };
        let device_pubkey = device.public_hex();
        let delegation = match meta("delegation")?.and_then(|j| Event::from_json(&j)) {
            Some(d) if verify_delegation(&d, &device_pubkey).is_some() => d,
            _ => {
                let identity = match (opts.identity.as_ref(), load_secret("identity_sk")?) {
                    (Some(i), _) => i.clone(),
                    (None, Some(i)) => i,
                    (None, None) => Secret::generate(),
                };
                store_secret("identity_sk", &identity)?;
                let d =
                    create_delegation(&identity, &device_pubkey, &opts.device_name, now() / 1000);
                set_meta("delegation", &d.to_json())?;
                d
            }
        };
        let pubkey = delegation.pubkey.clone();
        let node = match meta("node_id")? {
            Some(n) => n,
            None => {
                let n = random_hex(8);
                set_meta("node_id", &n)?;
                n
            }
        };
        let last = meta("hlc")?;
        let clock_now = now.clone();
        let clock_fn: Box<dyn Fn() -> u64 + Send + Sync> = Box::new(move || clock_now());
        let clock = Clock::new(&node, last.as_deref(), clock_fn)?;

        let mut e = Self {
            db,
            schema: opts.schema,
            key_store: opts.key_store,
            pubkey,
            device,
            device_pubkey,
            delegation,
            clock,
            now,
            keys: HashMap::new(),
            membership: HashMap::new(),
            personal: String::new(),
            depth: 0,
        };
        e.load_keys()?;
        let personal = e
            .spaces()?
            .into_iter()
            .find(|s| s.personal && s.status == "active");
        let personal = match personal {
            Some(s) => s.id,
            None => e.create_space_internal("personal", true)?,
        };
        e.personal = personal;
        e.apply_schema()?;
        let (d, i, dl) = (
            e.device_pubkey.clone(),
            e.pubkey.clone(),
            e.delegation.clone(),
        );
        e.put_device(&d, &i, &dl)?;
        Ok(e)
    }

    // ---- accessors ---------------------------------------------------------------------

    /// Identity public key (hex).
    pub fn pubkey(&self) -> &str {
        &self.pubkey
    }

    pub fn device_pubkey(&self) -> &str {
        &self.device_pubkey
    }

    /// This device's delegation (hand it to whoever adds this identity to a space).
    pub fn delegation(&self) -> &Event {
        &self.delegation
    }

    pub fn personal_space(&self) -> &str {
        &self.personal
    }

    /// The SQLite connection (read the projection tables with plain SQL).
    pub fn connection(&self) -> &Connection {
        &self.db
    }

    fn now_ms(&self) -> u64 {
        (self.now)()
    }

    fn now_s(&self) -> u64 {
        self.now_ms() / 1000
    }

    // ---- small storage helpers -------------------------------------------------------------

    fn meta(&self, k: &str) -> Result<Option<String>, EngineError> {
        Ok(self
            .db
            .query_row("SELECT value FROM anodb_meta WHERE key = ?", [k], |r| {
                r.get(0)
            })
            .optional()?)
    }

    fn set_meta(&self, k: &str, v: &str) -> Result<(), EngineError> {
        self.db.execute(
            "INSERT INTO anodb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [k, v],
        )?;
        Ok(())
    }

    /// Run `f` in one SQLite transaction (nested calls join the outer one).
    fn tx<T>(
        &mut self,
        f: impl FnOnce(&mut Self) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        if self.depth > 0 {
            return f(self);
        }
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        self.depth += 1;
        let r = f(self);
        self.depth -= 1;
        match r {
            Ok(v) => {
                self.db.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK");
                // Cached membership may describe rolled-back ops.
                self.membership.clear();
                Err(e)
            }
        }
    }

    fn next_seq(&self, space: &str) -> Result<u64, EngineError> {
        let k = format!("seq:{space}");
        let n = self
            .meta(&k)?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0)
            + 1;
        self.set_meta(&k, &n.to_string())?;
        Ok(n)
    }

    pub fn spaces(&self) -> Result<Vec<SpaceInfo>, EngineError> {
        let mut st = self.db.prepare(
            "SELECT id, name, personal, status FROM anodb_spaces ORDER BY created_at, id",
        )?;
        let rows = st.query_map([], |r| {
            Ok(SpaceInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                personal: r.get::<_, i64>(2)? == 1,
                status: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn space(&self, id: &str) -> Result<Option<SpaceInfo>, EngineError> {
        Ok(self.spaces()?.into_iter().find(|s| s.id == id))
    }

    fn upsert_space(
        &self,
        id: &str,
        name: &str,
        personal: bool,
        status: &str,
    ) -> Result<(), EngineError> {
        self.db.execute(
            "INSERT INTO anodb_spaces (id, name, personal, status, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status",
            params![id, name, personal as i64, status, self.now_ms() as i64],
        )?;
        Ok(())
    }

    fn set_space_status(&self, id: &str, status: &str) -> Result<(), EngineError> {
        self.db.execute(
            "UPDATE anodb_spaces SET status = ? WHERE id = ?",
            [status, id],
        )?;
        Ok(())
    }

    fn put_device(
        &self,
        device: &str,
        identity: &str,
        delegation: &Event,
    ) -> Result<(), EngineError> {
        let name = serde_json::from_str::<Value>(&delegation.content)
            .ok()
            .and_then(|v| {
                v.get("name")?
                    .as_str()
                    .map(|s| s.chars().take(64).collect::<String>())
            })
            .unwrap_or_default();
        self.db.execute(
            "INSERT OR IGNORE INTO anodb_devices (device, identity, delegation, name) VALUES (?, ?, ?, ?)",
            params![device, identity, delegation.to_json(), name],
        )?;
        Ok(())
    }

    /// Active (not revoked) devices of an identity.
    fn devices_of(&self, identity: &str) -> Result<Vec<String>, EngineError> {
        let mut st = self.db.prepare(
            "SELECT device FROM anodb_devices WHERE identity = ? AND revoked = 0 ORDER BY device",
        )?;
        let rows = st.query_map([identity], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn has_raw(&self, id: &str) -> Result<bool, EngineError> {
        Ok(self
            .db
            .query_row("SELECT 1 FROM anodb_raw WHERE id = ?", [id], |_| Ok(()))
            .optional()?
            .is_some())
    }

    fn put_raw(&self, e: &Event, tag: &str) -> Result<(), EngineError> {
        self.db.execute(
            "INSERT OR IGNORE INTO anodb_raw (id, tag, created_at, event) VALUES (?, ?, ?, ?)",
            params![e.id, tag, e.created_at as i64, e.to_json()],
        )?;
        Ok(())
    }

    fn has_message(&self, space: &str, device: &str, seq: u64) -> Result<bool, EngineError> {
        Ok(self
            .db
            .query_row(
                "SELECT 1 FROM anodb_messages WHERE space = ? AND device = ? AND seq = ?",
                params![space, device, seq as i64],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    #[allow(clippy::too_many_arguments)]
    fn put_message(
        &self,
        space: &str,
        device: &str,
        seq: u64,
        identity: &str,
        kind: &str,
        payload: &str,
        msg_id: &str,
        inner: &str,
    ) -> Result<(), EngineError> {
        self.db.execute(
            "INSERT OR IGNORE INTO anodb_messages (space, device, seq, identity, type, payload, msg_id, inner, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![space, device, seq as i64, identity, kind, payload, msg_id, inner, self.now_ms() as i64],
        )?;
        Ok(())
    }

    /// `(device, identity, seq, payload)` of the messages of one type, by device and seq.
    fn messages(
        &self,
        space: &str,
        kind: &str,
    ) -> Result<Vec<(String, String, u64, String)>, EngineError> {
        let mut st = self.db.prepare(
            "SELECT device, identity, seq, payload FROM anodb_messages WHERE space = ? AND type = ? ORDER BY device, seq",
        )?;
        let rows = st.query_map([space, kind], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u64, r.get(3)?))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Signed inner events of a message type (portable: verifiable by anyone).
    fn inners(&self, space: &str, kind: &str) -> Result<Vec<String>, EngineError> {
        let mut st = self.db.prepare(
            "SELECT inner FROM anodb_messages WHERE space = ? AND type = ? ORDER BY received_at, msg_id",
        )?;
        let rows = st.query_map([space, kind], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn device_max_seqs(
        &self,
        space: &str,
        identity: Option<&str>,
    ) -> Result<BTreeMap<String, u64>, EngineError> {
        let mut st = self.db.prepare(
            "SELECT device, MAX(seq) FROM anodb_messages WHERE space = ?1 AND (?2 IS NULL OR identity = ?2) GROUP BY device",
        )?;
        let rows = st.query_map(params![space, identity], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn enqueue(&self, e: &Event) -> Result<(), EngineError> {
        self.db.execute(
            "INSERT OR IGNORE INTO anodb_outbox (id, event, queued_at) VALUES (?, ?, ?)",
            params![e.id, e.to_json(), self.now_ms() as i64],
        )?;
        Ok(())
    }

    /// Envelopes waiting to be published, oldest first.
    pub fn outbox(&self) -> Result<Vec<Event>, EngineError> {
        let mut st = self
            .db
            .prepare("SELECT event FROM anodb_outbox ORDER BY queued_at, id")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows
            .filter_map(|j| j.ok().and_then(|j| Event::from_json(&j)))
            .collect())
    }

    /// A relay accepted this envelope.
    pub fn delivered(&self, id: &str) -> Result<(), EngineError> {
        self.db
            .execute("DELETE FROM anodb_outbox WHERE id = ?", [id])?;
        Ok(())
    }

    // ---- keys ---------------------------------------------------------------------------

    fn load_keys(&mut self) -> Result<(), EngineError> {
        let mut rows: Vec<(String, u64, Vec<u8>)> = vec![];
        {
            let mut st = self
                .db
                .prepare("SELECT space, num, sealed FROM anodb_keys")?;
            for r in st.query_map([], |r| {
                Ok((r.get(0)?, r.get::<_, i64>(1)? as u64, r.get(2)?))
            })? {
                rows.push(r?);
            }
        }
        for (space, num, sealed) in rows {
            let key: [u8; 32] = self
                .key_store
                .open(&sealed)?
                .try_into()
                .map_err(|_| EngineError::Invalid("bad stored key".into()))?;
            self.add_key(&space, key, num);
        }
        Ok(())
    }

    fn add_key(&mut self, space: &str, key: [u8; 32], num: u64) -> bool {
        let ek = EpochKey::new(space, key);
        if self.key_for_tag(&ek.tag).is_some() {
            return false;
        }
        let list = self.keys.entry(space.into()).or_default();
        list.push(Key { ek, num });
        list.sort_by(|a, b| {
            b.num
                .cmp(&a.num)
                .then_with(|| a.ek.key_id.cmp(&b.ek.key_id))
        });
        true
    }

    fn store_key(&mut self, space: &str, key: [u8; 32], num: u64) -> Result<bool, EngineError> {
        if !self.add_key(space, key, num) {
            return Ok(false);
        }
        let ek = EpochKey::new(space, key);
        self.db.execute(
            "INSERT OR IGNORE INTO anodb_keys (space, key_id, num, sealed, created_at) VALUES (?, ?, ?, ?, ?)",
            params![space, ek.key_id, num as i64, self.key_store.seal(&key), self.now_ms() as i64],
        )?;
        Ok(true)
    }

    fn key_for_tag(&self, tag: &str) -> Option<&EpochKey> {
        self.keys
            .values()
            .flatten()
            .map(|k| &k.ek)
            .find(|k| k.tag == tag)
    }

    fn current_key(&self, space: &str) -> Result<(EpochKey, u64), EngineError> {
        let k = self
            .keys
            .get(space)
            .and_then(|l| l.first())
            .ok_or_else(|| EngineError::Invalid(format!("no key for space {space}")))?;
        Ok((k.ek.clone(), k.num))
    }

    /// Routing tags to subscribe to: every key of every active space, and this device's inbox.
    pub fn subscription_tags(&self) -> Result<Vec<String>, EngineError> {
        let active: HashSet<String> = self
            .spaces()?
            .into_iter()
            .filter(|s| s.status == "active")
            .map(|s| s.id)
            .collect();
        let mut tags: Vec<String> = self
            .keys
            .iter()
            .filter(|(s, _)| active.contains(*s))
            .flat_map(|(_, l)| l.iter().map(|k| k.ek.tag.clone()))
            .collect();
        tags.sort();
        tags.push(inbox_tag(&self.device_pubkey));
        Ok(tags)
    }

    // ---- projections ---------------------------------------------------------------------

    fn apply_schema(&mut self) -> Result<(), EngineError> {
        let tables: Vec<String> = self.schema.tables.keys().cloned().collect();
        self.tx(|e| {
            for table in &tables {
                let def = e.schema.get(table).expect("listed").clone();
                let fp = format!("{}|{}|{}", fingerprint(&def), e.personal, e.pubkey);
                let k = format!("schema:{table}");
                if e.meta(&k)?.as_deref() == Some(fp.as_str()) {
                    continue;
                }
                e.db.execute_batch(&format!("DROP TABLE IF EXISTS {}", quote_ident(table)))?;
                e.db.execute_batch(&create_table_sql(table, &def, &e.personal, &e.pubkey))?;
                let rows: Vec<(String, String)> = {
                    let mut st = e
                        .db
                        .prepare("SELECT DISTINCT space, row_id FROM anodb_cells WHERE tbl = ?")?;
                    let r = st.query_map([table], |r| Ok((r.get(0)?, r.get(1)?)))?;
                    r.collect::<Result<_, _>>()?
                };
                for (space, row) in rows {
                    e.project(&space, table, &row)?;
                }
                e.set_meta(&k, &fp)?;
            }
            Ok(())
        })
    }

    /// LWW merge. `by` is the identity that signed the changes (a snapshot cell may carry its own).
    /// Returns the tables whose visible state may have changed.
    fn apply_changes(
        &mut self,
        space: &str,
        changes: &[Change],
        by: Option<&str>,
    ) -> Result<HashSet<String>, EngineError> {
        let mut dirty: BTreeMap<String, HashSet<String>> = BTreeMap::new();
        for c in changes {
            let writer = c.by.as_deref().or(by);
            let current: Option<String> = self
                .db
                .query_row(
                    "SELECT hlc FROM anodb_cells WHERE space = ? AND tbl = ? AND row_id = ? AND col = ?",
                    [space, &c.table, &c.row_id, &c.column],
                    |r| r.get(0),
                )
                .optional()?;
            if current.is_some_and(|h| h.as_str() >= c.hlc.as_str()) {
                continue;
            }
            self.db.execute(
                "INSERT INTO anodb_cells (space, tbl, row_id, col, value, hlc, by) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(space, tbl, row_id, col) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, by = excluded.by",
                params![space, c.table, c.row_id, c.column, c.value.to_string(), c.hlc, writer],
            )?;
            dirty
                .entry(c.table.clone())
                .or_default()
                .insert(c.row_id.clone());
        }
        for (table, rows) in &dirty {
            for row in rows {
                self.project(space, table, row)?;
            }
        }
        Ok(dirty.into_keys().collect())
    }

    /// All current cells of a space, with the signing identity when known.
    fn cells(&self, space: &str) -> Result<Vec<Change>, EngineError> {
        let mut st = self.db.prepare(
            "SELECT tbl, row_id, col, value, hlc, by FROM anodb_cells WHERE space = ? ORDER BY tbl, row_id, col",
        )?;
        let rows = st.query_map([space], |r| {
            Ok(Change {
                table: r.get(0)?,
                row_id: r.get(1)?,
                column: r.get(2)?,
                value: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Null),
                hlc: r.get(4)?,
                by: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn clear_space(&mut self, space: &str) -> Result<HashSet<String>, EngineError> {
        let tables: HashSet<String> = {
            let mut st = self
                .db
                .prepare("SELECT DISTINCT tbl FROM anodb_cells WHERE space = ?")?;
            let r = st.query_map([space], |r| r.get(0))?;
            r.collect::<Result<_, _>>()?
        };
        self.db
            .execute("DELETE FROM anodb_cells WHERE space = ?", [space])?;
        for t in &tables {
            if self.schema.get(t).is_some() {
                self.db.execute(
                    &format!("DELETE FROM {} WHERE space = ?", quote_ident(t)),
                    [space],
                )?;
            }
        }
        Ok(tables)
    }

    fn project(&mut self, space: &str, table: &str, row: &str) -> Result<(), EngineError> {
        let Some(def) = self.schema.get(table).cloned() else {
            return Ok(()); // kept in cells; projected once the schema knows the table
        };
        let cells: Vec<(String, String, String, Option<String>)> = {
            let mut st = self.db.prepare(
                "SELECT col, value, hlc, by FROM anodb_cells WHERE space = ? AND tbl = ? AND row_id = ?",
            )?;
            let r = st.query_map([space, table, row], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
            r.collect::<Result<_, _>>()?
        };
        let mut values: HashMap<String, Value> = HashMap::new();
        let mut max_hlc = String::new();
        let mut updated_by: Option<String> = None;
        for (col, value, h, by) in &cells {
            values.insert(
                col.clone(),
                serde_json::from_str(value).unwrap_or(Value::Null),
            );
            if *h > max_hlc {
                max_hlc = h.clone();
                updated_by = by.clone();
            }
        }
        // A row whose id names its creator exists only once that creator created it.
        let unborn = owner_of_row(row).is_some() && !values.contains_key(SYS_CREATED);
        if values.get(SYS_DELETED) == Some(&Value::Bool(true)) || cells.is_empty() || unborn {
            self.db.execute(
                &format!(
                    "DELETE FROM {} WHERE space = ? AND id = ?",
                    quote_ident(table)
                ),
                [space, row],
            )?;
            return Ok(());
        }
        let mut names = vec!["space".to_owned(), "id".to_owned()];
        let mut vals: Vec<SqlValue> =
            vec![SqlValue::Text(space.into()), SqlValue::Text(row.into())];
        for (c, t) in &def.columns {
            names.push(c.clone());
            vals.push(to_sql(*t, values.get(c).unwrap_or(&Value::Null)));
        }
        names.extend(["createdAt", "updatedAt", "createdBy", "updatedBy"].map(String::from));
        vals.push(
            values
                .get(SYS_CREATED)
                .and_then(anodb_protocol::payload::safe_integer)
                .map_or(SqlValue::Null, SqlValue::Integer),
        );
        vals.push(SqlValue::Integer(
            hlc::decode(&max_hlc).map(|t| t.millis as i64).unwrap_or(0),
        ));
        vals.push(owner_of_row(row).map_or(SqlValue::Null, |o| SqlValue::Text(o.into())));
        vals.push(updated_by.map_or(SqlValue::Null, SqlValue::Text));
        let sql = format!(
            "INSERT OR REPLACE INTO {} ({}) VALUES ({})",
            quote_ident(table),
            names
                .iter()
                .map(|n| quote_ident(n))
                .collect::<Vec<_>>()
                .join(", "),
            vec!["?"; names.len()].join(", ")
        );
        self.db.execute(&sql, params_from_iter(vals))?;
        Ok(())
    }

    /// Run a read query on the projection tables; rows as JSON objects.
    pub fn query(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<Vec<Map<String, Value>>, EngineError> {
        let mut st = self.db.prepare(sql)?;
        let names: Vec<String> = st.column_names().map(String::from).collect();
        let rows = st.query_map(params_from_iter(params.iter()), |r| {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() {
                m.insert(n.clone(), sql_text(&r.get::<_, SqlValue>(i)?));
            }
            Ok(m)
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    // ---- membership -------------------------------------------------------------------------

    fn membership(&mut self, space: &str) -> Result<&Membership, EngineError> {
        if !self.membership.contains_key(space) {
            let mut records = vec![];
            {
                let mut st = self.db.prepare(
                    "SELECT msg_id, identity, payload FROM anodb_messages WHERE space = ? AND type = 'op'",
                )?;
                let rows = st.query_map([space], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?;
                for row in rows {
                    let (id, identity, payload) = row?;
                    let Ok(p) = serde_json::from_str::<Value>(&payload) else {
                        continue;
                    };
                    let Some(op) = p.get("op").and_then(parse_op) else {
                        continue;
                    };
                    let par = p
                        .get("par")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    records.push(OpRecord {
                        id,
                        identity,
                        op,
                        par,
                    });
                }
            }
            let devices: HashMap<String, String> = {
                let mut st = self
                    .db
                    .prepare("SELECT device, identity FROM anodb_devices")?;
                let r = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                r.collect::<Result<_, _>>()?
            };
            let m = evaluate(space, &records, |d| devices.get(d).cloned());
            self.membership.insert(space.into(), m);
        }
        Ok(&self.membership[space])
    }

    fn invalidate(&mut self, space: &str) {
        self.membership.remove(space);
    }

    /// Members of a space and their roles.
    pub fn members(&mut self, space: &str) -> Result<Vec<(String, Role)>, EngineError> {
        Ok(self
            .membership(space)?
            .roles
            .iter()
            .map(|(i, r)| (i.clone(), *r))
            .collect())
    }

    pub fn role_in(&mut self, space: &str) -> Result<Option<Role>, EngineError> {
        let me = self.pubkey.clone();
        Ok(self.membership(space)?.role_of(&me))
    }

    /// Recompute a space's cells from its message log under the current membership.
    fn rebuild_space(&mut self, space: &str) -> Result<HashSet<String>, EngineError> {
        let mut touched = self.clear_space(space)?;
        let m = self.membership(space)?.clone();
        for (device, identity, seq, payload) in self.messages(space, "ch")? {
            if !m.may_write(&identity, &device, seq) {
                continue;
            }
            let changes = ch_changes(&payload);
            let allowed = self.allowed_changes(&m, &identity, &changes);
            touched.extend(self.apply_changes(space, &allowed, Some(&identity))?);
        }
        let me = self.pubkey.clone();
        for snap in self.complete_snapshots(space, &m)? {
            if !snapshot_trusted(&m, &me, &snap) {
                continue;
            }
            let cells = snapshot_changes(&snap, |t| self.schema.rule_of(t), &m);
            touched.extend(self.apply_changes(space, &cells, None)?);
        }
        Ok(touched)
    }

    fn complete_snapshots(
        &self,
        space: &str,
        _m: &Membership,
    ) -> Result<Vec<anodb_protocol::snapshot::Snapshot>, EngineError> {
        let msgs: Vec<SnapshotMessage> = self
            .messages(space, "snap")?
            .into_iter()
            .filter_map(|(device, identity, _, payload)| {
                let p = StreamPayload::parse(&payload)?;
                SnapshotMessage::from_payload(&device, &identity, &p)
            })
            .collect();
        Ok(assemble_snapshots(&msgs))
    }

    fn allowed_changes(&self, m: &Membership, identity: &str, changes: &[Change]) -> Vec<Change> {
        let role = m.role_of(identity);
        changes
            .iter()
            .filter(|c| change_allowed(self.schema.rule_of(&c.table), c, identity, role))
            .cloned()
            .collect()
    }

    // ---- outgoing ---------------------------------------------------------------------------

    /// Sign, store, seal and enqueue a stream message. Returns `(seq, msg_id)`.
    fn send_to_space(
        &mut self,
        space: &str,
        kind: &str,
        body: Map<String, Value>,
        key: Option<&EpochKey>,
    ) -> Result<(u64, String), EngineError> {
        let key = match key {
            Some(k) => k.clone(),
            None => self.current_key(space)?.0,
        };
        let seq = self.next_seq(space)?;
        let mut payload = Map::new();
        payload.insert("v".into(), json!(2));
        payload.insert("t".into(), json!(kind));
        payload.insert("sp".into(), json!(space));
        payload.insert("ep".into(), json!(key.key_id));
        payload.insert("seq".into(), json!(seq));
        payload.insert(
            "dlg".into(),
            serde_json::to_value(&self.delegation).expect("event"),
        );
        payload.extend(body);
        let content = Value::Object(payload).to_string();
        let inner = sign_inner(&self.device, content.clone(), self.now_s());
        let inner_json = inner.to_json();
        let (d, i) = (self.device_pubkey.clone(), self.pubkey.clone());
        self.put_message(space, &d, seq, &i, kind, &content, &inner.id, &inner_json)?;
        let outer = seal(
            &inner_json,
            &key.tag,
            &key.key,
            &Secret::generate(),
            self.now_s(),
        )?;
        self.put_raw(&outer, &key.tag)?;
        self.enqueue(&outer)?;
        Ok((seq, inner.id))
    }

    fn send_inbox(&mut self, device: &str, body: Map<String, Value>) -> Result<(), EngineError> {
        let mut payload = Map::new();
        payload.insert("v".into(), json!(2));
        payload.insert(
            "dlg".into(),
            serde_json::to_value(&self.delegation).expect("event"),
        );
        payload.extend(body);
        let inner = sign_inner(
            &self.device,
            Value::Object(payload).to_string(),
            self.now_s(),
        );
        let outer = seal_to_device(&inner, device, self.now_s())?;
        self.enqueue(&outer)
    }

    fn create_space_internal(&mut self, name: &str, personal: bool) -> Result<String, EngineError> {
        let nonce = random_hex(16);
        let id = space_id(&self.pubkey, &nonce);
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).expect("system randomness");
        let owner = self.pubkey.clone();
        self.tx(|e| {
            e.store_key(&id, key, 1)?;
            e.upsert_space(&id, name, personal, "active")?;
            let mut body = Map::new();
            body.insert(
                "op".into(),
                json!({ "type": "create", "owner": owner, "nonce": nonce, "name": name, "personal": personal }),
            );
            body.insert("par".into(), json!([]));
            e.send_to_space(&id, "op", body, None)?;
            e.invalidate(&id);
            Ok(())
        })?;
        Ok(id)
    }

    /// Create a shared space owned by this identity.
    pub fn create_space(&mut self, name: &str) -> Result<String, EngineError> {
        self.create_space_internal(name, false)
    }

    fn assert_can_write(&mut self, space: &str) -> Result<(), EngineError> {
        match self.space(space)? {
            Some(s) if s.status == "active" => {}
            _ => {
                return Err(EngineError::Invalid(format!(
                    "unknown or inactive space \"{space}\""
                )));
            }
        }
        let (me, dev) = (self.pubkey.clone(), self.device_pubkey.clone());
        if !self.membership(space)?.may_write(&me, &dev, u64::MAX >> 11) {
            return Err(EngineError::Unauthorized(format!(
                "no write permission in space {space}"
            )));
        }
        Ok(())
    }

    /// Write cells of one row. `values` maps column → value; `None` space = the personal space.
    fn write_row(
        &mut self,
        space: Option<&str>,
        table: &str,
        row: &str,
        values: &Map<String, Value>,
        created: bool,
        deleted: bool,
    ) -> Result<(), EngineError> {
        let space = space.unwrap_or(&self.personal).to_owned();
        let def = self
            .schema
            .get(table)
            .cloned()
            .ok_or_else(|| EngineError::Invalid(format!("unknown table \"{table}\"")))?;
        if row.is_empty()
            || row.len() > 128
            || !row
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(EngineError::Invalid(format!(
                "invalid row id \"{row}\" (1–128 chars of A-Z a-z 0-9 _ -)"
            )));
        }
        self.assert_can_write(&space)?;
        let me = self.pubkey.clone();
        let role = self.membership(&space)?.role_of(&me);
        let mut changes = vec![];
        let mut push = |col: &str, v: Value, clock: &mut Clock<_>| {
            changes.push(Change {
                table: table.into(),
                row_id: row.into(),
                column: col.into(),
                value: v,
                hlc: clock.tick(),
                by: None,
            });
        };
        for (col, v) in values {
            let t = def
                .column(col)
                .ok_or_else(|| EngineError::Invalid(format!("unknown column {table}.{col}")))?;
            check_value(table, col, t, v)?;
            push(col, v.clone(), &mut self.clock);
        }
        if created {
            push(SYS_CREATED, json!(self.now_ms()), &mut self.clock);
        }
        if deleted {
            push(SYS_DELETED, json!(true), &mut self.clock);
        }
        for c in &changes {
            if !change_allowed(Some(&def.rule), c, &me, role) {
                return Err(EngineError::Unauthorized(format!(
                    "not allowed to write {}.{} of row {}",
                    c.table, c.column, c.row_id
                )));
            }
        }
        self.tx(|e| {
            e.apply_changes(&space, &changes, Some(&me))?;
            for batch in split_changes(&changes)? {
                let mut body = Map::new();
                body.insert(
                    "c".into(),
                    Value::Array(batch.iter().map(Change::to_value).collect()),
                );
                e.send_to_space(&space, "ch", body, None)?;
            }
            let h = e.clock.current();
            e.set_meta("hlc", &h)
        })?;
        self.maybe_snapshot(&space)
    }

    /// Insert a row; returns its id (`<identity>-<16 hex>`).
    pub fn insert(
        &mut self,
        space: Option<&str>,
        table: &str,
        values: &Map<String, Value>,
    ) -> Result<String, EngineError> {
        let id = format!("{}-{}", self.pubkey, random_hex(8));
        self.write_row(space, table, &id, values, true, false)?;
        Ok(id)
    }

    pub fn update(
        &mut self,
        space: Option<&str>,
        table: &str,
        row: &str,
        values: &Map<String, Value>,
    ) -> Result<(), EngineError> {
        self.write_row(space, table, row, values, false, false)
    }

    pub fn delete(
        &mut self,
        space: Option<&str>,
        table: &str,
        row: &str,
    ) -> Result<(), EngineError> {
        self.write_row(space, table, row, &Map::new(), false, true)
    }

    // ---- membership changes (owners / admins) -----------------------------------------------

    /// Post a membership op (`{ type, … }`, §5.1) on top of the current heads.
    pub fn post_op(&mut self, space: &str, op: Value) -> Result<(), EngineError> {
        let before = self.membership(space)?.clone();
        let (ids, referenced): (Vec<String>, HashSet<String>) = {
            let mut st = self.db.prepare(
                "SELECT msg_id, payload FROM anodb_messages WHERE space = ? AND type = 'op'",
            )?;
            let rows: Vec<(String, String)> = st
                .query_map([space], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            let referenced = rows
                .iter()
                .filter_map(|(_, p)| serde_json::from_str::<Value>(p).ok())
                .flat_map(|p| {
                    p.get("par")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                })
                .collect();
            (rows.into_iter().map(|(id, _)| id).collect(), referenced)
        };
        let par: Vec<String> = ids
            .into_iter()
            .filter(|id| !referenced.contains(id) && before.valid.contains(id))
            .collect();
        let kind = op
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_owned();
        self.tx(|e| {
            let mut body = Map::new();
            body.insert("op".into(), op);
            body.insert("par".into(), json!(par));
            let (_, msg_id) = e.send_to_space(space, "op", body, None)?;
            e.invalidate(space);
            if !e.membership(space)?.valid.contains(&msg_id) {
                return Err(EngineError::Unauthorized(format!(
                    "not allowed: {kind} in space {space}"
                )));
            }
            e.rebuild_space(space)?;
            Ok(())
        })
    }

    /// Add a member by identity and deliver the space key to the devices its delegations name.
    /// The new member sees an invitation and must accept it.
    pub fn add_member(
        &mut self,
        space: &str,
        identity: &str,
        role: Role,
        delegations: &[Event],
    ) -> Result<(), EngineError> {
        if role == Role::Owner {
            return Err(EngineError::Invalid(
                "use a transfer to change the owner".into(),
            ));
        }
        let mut any = false;
        for d in delegations {
            if let Some(dev) = d.tag("device")
                && verify_delegation(d, dev).as_deref() == Some(identity)
            {
                self.put_device(dev, identity, d)?;
                any = true;
            }
        }
        if !any {
            return Err(EngineError::Invalid(format!(
                "none of the given devices is delegated by {identity}"
            )));
        }
        if self.membership(space)?.role_of(identity).is_none() {
            self.post_op(
                space,
                json!({ "type": "add", "identity": identity, "role": role.as_str() }),
            )?;
        }
        self.rotate_key(space, &[identity.to_owned()])
    }

    /// New epoch key for every active device of every member (invitees get an invitation), then a
    /// snapshot of the current state in the new epoch.
    pub fn rotate_key(&mut self, space: &str, invitees: &[String]) -> Result<(), EngineError> {
        let me = self.pubkey.clone();
        let m = self.membership(space)?.clone();
        if !m.may_manage(&me) {
            return Err(EngineError::Unauthorized(
                "only owners and admins can rotate keys".into(),
            ));
        }
        let s = self
            .space(space)?
            .ok_or_else(|| EngineError::Invalid(format!("unknown space {space}")))?;
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).expect("system randomness");
        let num = self.current_key(space)?.1 + 1;
        self.tx(|e| {
            e.store_key(space, key, num)?;
            let grant = json!({
                "sp": space, "name": s.name, "personal": s.personal, "num": num,
                "key": hex::encode(key), "ops": e.inners(space, "op")?,
            });
            for (identity, role) in &m.roles {
                for d in e.devices_of(identity)? {
                    if d == e.device_pubkey || m.revoked_devices.contains(&d) {
                        continue;
                    }
                    let mut body = grant.as_object().expect("object").clone();
                    if invitees.contains(identity) {
                        body.insert("t".into(), json!("invite"));
                        body.insert("role".into(), json!(role.as_str()));
                    } else {
                        body.insert("t".into(), json!("key"));
                    }
                    e.send_inbox(&d, body)?;
                }
            }
            let ek = EpochKey::new(space, key);
            e.snapshot_with(space, &ek)
        })
    }

    /// Post the current state of a space as a (multi-part) snapshot.
    pub fn snapshot(&mut self, space: &str) -> Result<(), EngineError> {
        let ek = self.current_key(space)?.0;
        self.tx(|e| e.snapshot_with(space, &ek))
    }

    fn snapshot_with(&mut self, space: &str, ek: &EpochKey) -> Result<(), EngineError> {
        enum Item {
            Op(String),
            Cell(Change),
        }
        let items: Vec<Item> = self
            .inners(space, "op")?
            .into_iter()
            .map(Item::Op)
            .chain(
                snapshot_cells(&self.cells(space)?)
                    .into_iter()
                    .map(Item::Cell),
            )
            .collect();
        let mut parts: Vec<(Vec<Value>, Vec<Value>)> = vec![(vec![], vec![])];
        let mut size = 0;
        for it in items {
            let v = match &it {
                Item::Op(o) => Value::String(o.clone()),
                Item::Cell(c) => c.to_value(),
            };
            let n = v.to_string().len() + 1;
            if size + n > MAX_BODY_BYTES && size > 0 {
                parts.push((vec![], vec![]));
                size = 0;
            }
            let p = parts.last_mut().expect("non-empty");
            match it {
                Item::Op(_) => p.0.push(v),
                Item::Cell(_) => p.1.push(v),
            }
            size += n;
        }
        let sid = random_hex(8);
        let heads = self.device_max_seqs(space, None)?;
        let n = parts.len();
        for (i, (ops, cells)) in parts.into_iter().enumerate() {
            let mut b = json!({ "ops": ops, "cells": cells });
            if i == 0 {
                b["heads"] = json!(heads);
            }
            let mut body = Map::new();
            body.insert("sid".into(), json!(sid));
            body.insert("i".into(), json!(i));
            body.insert("n".into(), json!(n));
            body.insert("body".into(), b);
            self.send_to_space(space, "snap", body, Some(ek))?;
        }
        let now = self.now_ms().to_string();
        self.set_meta(&format!("snap:{space}"), &now)
    }

    fn maybe_snapshot(&mut self, space: &str) -> Result<(), EngineError> {
        let since: i64 = self
            .meta(&format!("snap:{space}"))?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let count: i64 = self.db.query_row(
            "SELECT COUNT(*) FROM anodb_messages WHERE space = ? AND type = 'ch' AND received_at > ?",
            params![space, since],
            |r| r.get(0),
        )?;
        if (count as u64) < SNAPSHOT_EVERY {
            return Ok(());
        }
        if matches!(self.role_in(space)?, Some(Role::Owner | Role::Admin)) {
            self.snapshot(space)?;
        }
        Ok(())
    }

    // ---- incoming -----------------------------------------------------------------------------

    /// Verify and apply one envelope from a relay. Returns the tables that changed.
    pub fn ingest(&mut self, outer: &Event) -> Result<(Ingest, HashSet<String>), EngineError> {
        if outer.kind != WRAP_KIND {
            return Ok((Ingest::Invalid, HashSet::new()));
        }
        let Some(tag) = outer.tag(TAG).map(String::from) else {
            return Ok((Ingest::Invalid, HashSet::new()));
        };
        if self.has_raw(&outer.id)? {
            return Ok((Ingest::Seen, HashSet::new()));
        }
        if self.key_for_tag(&tag).is_some() {
            let opened = {
                let keys: Vec<EpochKey> =
                    self.keys.values().flatten().map(|k| k.ek.clone()).collect();
                open_space(outer, |t| keys.iter().find(|k| k.tag == t))
            };
            let Ok(o) = opened else {
                return Ok((Ingest::Invalid, HashSet::new()));
            };
            let space = o.space.clone();
            let (result, changed) = self.tx(|e| {
                e.put_raw(outer, &tag)?;
                if e.has_message(&space, &o.device, o.payload.seq)? {
                    return Ok((Ingest::Seen, HashSet::new()));
                }
                e.put_message(
                    &space,
                    &o.device,
                    o.payload.seq,
                    &o.identity,
                    o.payload.type_name(),
                    &o.inner.content,
                    &o.msg_id,
                    &o.inner.to_json(),
                )?;
                let changed = e.on_message(&space, &o.identity, &o.device, &o.payload)?;
                Ok((Ingest::New, changed))
            })?;
            if result == Ingest::New {
                self.after_remote_message(&space, &o.identity, &o.device, &o.payload)?;
            }
            return Ok((result, changed));
        }
        if tag == inbox_tag(&self.device_pubkey) {
            let Some(d) = open_inbox(outer, &self.device) else {
                return Ok((Ingest::Invalid, HashSet::new()));
            };
            self.put_raw(outer, &tag)?;
            let changed = self.on_inbox(
                &d.sender,
                &d.inner.pubkey,
                &d.payload.t,
                &d.payload.raw,
                &d.payload.delegation,
            )?;
            return Ok((Ingest::New, changed));
        }
        Ok((Ingest::Invalid, HashSet::new()))
    }

    fn on_message(
        &mut self,
        space: &str,
        identity: &str,
        device: &str,
        p: &StreamPayload,
    ) -> Result<HashSet<String>, EngineError> {
        match &p.body {
            Body::Op { .. } => {
                self.invalidate(space);
                self.rebuild_space(space)
            }
            Body::Snap { body, .. } => {
                // Import the portable ops it carries, then re-evaluate everything.
                if let Some(ops) = body.get("ops").and_then(Value::as_array) {
                    for o in ops.iter().filter_map(Value::as_str) {
                        self.import_inner(space, o)?;
                    }
                }
                self.invalidate(space);
                self.rebuild_space(space)
            }
            Body::Changes(changes) => {
                let m = self.membership(space)?.clone();
                if !m.may_write(identity, device, p.seq) {
                    return Ok(HashSet::new()); // kept; re-evaluated on membership change
                }
                if let Some(max) = changes.iter().map(|c| c.hlc.as_str()).max() {
                    let max = max.to_owned();
                    self.clock.receive(&max)?;
                    let h = self.clock.current();
                    self.set_meta("hlc", &h)?;
                }
                let allowed = self.allowed_changes(&m, identity, changes);
                self.apply_changes(space, &allowed, Some(identity))
            }
        }
    }

    fn after_remote_message(
        &mut self,
        space: &str,
        identity: &str,
        device: &str,
        p: &StreamPayload,
    ) -> Result<(), EngineError> {
        self.put_device(device, identity, &p.delegation)?;
        if !matches!(p.body, Body::Op { .. }) {
            return Ok(());
        }
        let me = self.pubkey.clone();
        let m = self.membership(space)?;
        let removed = m.owner.is_some() && m.role_of(&me).is_none();
        if removed && self.space(space)?.is_some_and(|s| s.status == "active") {
            self.set_space_status(space, "removed")?;
        }
        Ok(())
    }

    /// Store a portable signed op (from an invitation or snapshot) after verifying it.
    fn import_inner(&mut self, space: &str, inner_json: &str) -> Result<bool, EngineError> {
        let Some(op) = portable_op(space, inner_json) else {
            return Ok(false);
        };
        if self.has_message(space, &op.device, op.seq)? {
            return Ok(true);
        }
        self.put_message(
            space,
            &op.device,
            op.seq,
            &op.identity,
            "op",
            &op.inner.content,
            &op.id,
            inner_json,
        )?;
        self.put_device(&op.device, &op.identity, &op.payload.delegation)?;
        Ok(true)
    }

    fn on_inbox(
        &mut self,
        sender: &str,
        sender_device: &str,
        t: &str,
        raw: &Map<String, Value>,
        dlg: &Event,
    ) -> Result<HashSet<String>, EngineError> {
        if t != "key" && t != "invite" {
            return Ok(HashSet::new());
        }
        let Some(g) = parse_key_grant(&Value::Object(raw.clone())) else {
            return Ok(HashSet::new());
        };
        self.tx(|e| {
            for o in &g.ops {
                e.import_inner(&g.space, o)?;
            }
            Ok(())
        })?;
        self.invalidate(&g.space);
        let me = self.pubkey.clone();
        let Some(role) = grant_role(self.membership(&g.space)?, sender, &me) else {
            return Ok(HashSet::new());
        };
        self.put_device(sender_device, sender, dlg)?;
        let active = self.space(&g.space)?.is_some_and(|s| s.status == "active");
        if t == "invite" && !active {
            self.db.execute(
                "INSERT INTO anodb_invites_in (space, sender, role, name, payload, status, received_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)
                 ON CONFLICT(space) DO UPDATE SET sender = excluded.sender, role = excluded.role, name = excluded.name, payload = excluded.payload,
                   status = CASE WHEN anodb_invites_in.status = 'accepted' THEN 'accepted' ELSE 'pending' END",
                params![g.space, sender, role.as_str(), g.name.clone().unwrap_or_default(), Value::Object(raw.clone()).to_string(), self.now_ms() as i64],
            )?;
            return Ok(HashSet::new());
        }
        if !active {
            return Ok(HashSet::new());
        }
        self.accept_key(&g, sender != me)?;
        self.rebuild_space(&g.space)
    }

    fn accept_key(&mut self, g: &KeyGrant, forward: bool) -> Result<(), EngineError> {
        if !self.store_key(&g.space, g.key, g.num)? || !forward {
            return Ok(());
        }
        // Share with this identity's other devices (the sender may not know them).
        let me = self.pubkey.clone();
        let grant = json!({
            "t": "key", "sp": g.space, "name": g.name, "personal": g.personal, "num": g.num,
            "key": hex::encode(g.key), "ops": g.ops,
        });
        for d in self.devices_of(&me)? {
            if d != self.device_pubkey {
                self.send_inbox(&d, grant.as_object().expect("object").clone())?;
            }
        }
        Ok(())
    }

    /// Pending invitations.
    pub fn invitations(&self) -> Result<Vec<Invitation>, EngineError> {
        let mut st = self.db.prepare(
            "SELECT space, name, role, sender FROM anodb_invites_in WHERE status = 'pending' ORDER BY received_at",
        )?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        Ok(rows
            .filter_map(Result::ok)
            .filter_map(|(space, name, role, from)| {
                Some(Invitation {
                    space,
                    name,
                    role: Role::parse(&role)?,
                    from,
                })
            })
            .collect())
    }

    /// Join a space you were invited to. Nothing is synced for a space until you accept.
    pub fn accept_invitation(&mut self, space: &str) -> Result<(), EngineError> {
        let payload: Option<String> = self
            .db
            .query_row(
                "SELECT payload FROM anodb_invites_in WHERE space = ?",
                [space],
                |r| r.get(0),
            )
            .optional()?;
        let g = payload
            .and_then(|p| serde_json::from_str::<Value>(&p).ok())
            .and_then(|v| parse_key_grant(&v))
            .ok_or_else(|| EngineError::Invalid("no such invitation".into()))?;
        self.tx(|e| {
            e.store_key(&g.space, g.key, g.num)?;
            e.upsert_space(&g.space, g.name.as_deref().unwrap_or(""), false, "active")?;
            e.db.execute(
                "UPDATE anodb_invites_in SET status = 'accepted' WHERE space = ?",
                [space],
            )?;
            e.invalidate(space);
            e.rebuild_space(space)?;
            Ok(())
        })
    }

    pub fn decline_invitation(&self, space: &str) -> Result<(), EngineError> {
        self.db.execute(
            "UPDATE anodb_invites_in SET status = 'declined' WHERE space = ?",
            [space],
        )?;
        Ok(())
    }
}

/// The changes of a stored `ch` payload.
fn ch_changes(payload: &str) -> Vec<Change> {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|p| p.get("c")?.as_array().cloned())
        .map(|a| a.iter().filter_map(Change::parse).collect())
        .unwrap_or_default()
}

/// Split changes into groups whose JSON stays under `MAX_BODY_BYTES`.
fn split_changes(changes: &[Change]) -> Result<Vec<Vec<Change>>, EngineError> {
    if changes.is_empty() {
        return Ok(vec![]);
    }
    let size = Value::Array(changes.iter().map(Change::to_value).collect())
        .to_string()
        .len();
    if size <= MAX_BODY_BYTES {
        return Ok(vec![changes.to_vec()]);
    }
    if changes.len() == 1 {
        let c = &changes[0];
        return Err(EngineError::Invalid(format!(
            "value of {}.{} (row {}) exceeds {MAX_BODY_BYTES} bytes; store large data as a blob",
            c.table, c.column, c.row_id
        )));
    }
    let mid = changes.len().div_ceil(2);
    let mut out = split_changes(&changes[..mid])?;
    out.extend(split_changes(&changes[mid..])?);
    Ok(out)
}

const _: () = assert!(MAX_BODY_BYTES < MAX_INNER_BYTES);
