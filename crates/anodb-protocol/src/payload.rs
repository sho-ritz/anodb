//! Inner message payloads (PROTOCOL.md §3) and their structural validation. The checks mirror the
//! TypeScript implementation, including JavaScript number semantics (`1.0` is an integer).

use serde_json::{Map, Value};

use crate::event::Event;
use crate::hlc::is_hlc;
use crate::keys::is_lower_hex;

pub const PROTOCOL_VERSION: u64 = 2;
/// Outer envelope kind.
pub const WRAP_KIND: u32 = 7303;
/// Delegation / revocation kind.
pub const DELEGATION_KIND: u32 = 7304;
/// Inner message kind (never published unencrypted).
pub const MESSAGE_KIND: u32 = 7305;
/// Key package kind (public, replaceable).
pub const KEY_PACKAGE_KIND: u32 = 10304;
/// Routing tag name.
pub const TAG: &str = "n";

/// `[table, rowId, column, value, hlc]`, with the signing identity as an optional 6th element in
/// snapshots.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub table: String,
    pub row_id: String,
    pub column: String,
    pub value: Value,
    pub hlc: String,
    pub by: Option<String>,
}

impl Change {
    /// A change as sent in a `ch` message (exactly 5 elements), like `isChange`.
    pub fn parse(v: &Value) -> Option<Self> {
        let a = v.as_array()?;
        if a.len() != 5 {
            return None;
        }
        let (table, row_id, column, hlc) = (
            a[0].as_str()?,
            a[1].as_str()?,
            a[2].as_str()?,
            a[4].as_str()?,
        );
        let rows = row_id.encode_utf16().count(); // JavaScript string length
        if !is_name(table)
            || table.starts_with('$')
            || rows == 0
            || rows > 128
            || !is_name(column)
            || !is_hlc(hlc)
        {
            return None;
        }
        Some(Self {
            table: table.into(),
            row_id: row_id.into(),
            column: column.into(),
            value: a[3].clone(),
            hlc: hlc.into(),
            by: None,
        })
    }

    /// A snapshot cell: a change, optionally followed by the identity that signed it (§5.4).
    ///
    /// Stricter than the TypeScript implementation, which keeps any 5-element array here.
    pub fn parse_cell(v: &Value) -> Option<Self> {
        let a = v.as_array()?;
        match a.len() {
            5 => Self::parse(v),
            6 => {
                let by = a[5].as_str().filter(|s| is_lower_hex(s, 64))?;
                let mut c = Self::parse(&Value::Array(a[..5].to_vec()))?;
                c.by = Some(by.to_owned());
                Some(c)
            }
            _ => None,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut a = vec![
            self.table.clone().into(),
            self.row_id.clone().into(),
            self.column.clone().into(),
            self.value.clone(),
            self.hlc.clone().into(),
        ];
        if let Some(by) = &self.by {
            a.push(by.clone().into());
        }
        Value::Array(a)
    }
}

/// `^\$?[A-Za-z][A-Za-z0-9_]*$`
fn is_name(s: &str) -> bool {
    let b = s.strip_prefix('$').unwrap_or(s).as_bytes();
    !b.is_empty()
        && b[0].is_ascii_alphabetic()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// `Number.isSafeInteger` for a JSON number.
pub fn safe_integer(v: &Value) -> Option<i64> {
    const MAX: f64 = 9_007_199_254_740_991.0;
    if let Some(i) = v.as_i64() {
        return (i.unsigned_abs() <= MAX as u64).then_some(i);
    }
    if v.as_u64().is_some() {
        return None; // above i64, so above 2^53
    }
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX).then_some(f as i64)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    Changes(Vec<Change>),
    Op {
        op: Value,
        par: Vec<String>,
    },
    Snap {
        sid: String,
        i: u32,
        n: u32,
        body: Value,
    },
}

/// A decrypted, structurally valid stream message (signatures are checked by the caller).
#[derive(Debug, Clone, PartialEq)]
pub struct StreamPayload {
    pub space: String,
    pub key_id: String,
    pub seq: u64,
    pub delegation: Event,
    /// `rp: 1` — the sender reads this space on its automatically picked relays.
    pub reads_picked_relays: bool,
    pub body: Body,
    /// The whole payload object (unknown fields are kept).
    pub raw: Map<String, Value>,
}

impl StreamPayload {
    pub fn type_name(&self) -> &'static str {
        match self.body {
            Body::Changes(_) => "ch",
            Body::Op { .. } => "op",
            Body::Snap { .. } => "snap",
        }
    }

    /// `parseStreamPayload`.
    pub fn parse(json: &str) -> Option<Self> {
        let v: Value = serde_json::from_str(json).ok()?;
        let p = v.as_object()?;
        if p.get("v").and_then(safe_integer) != Some(PROTOCOL_VERSION as i64) {
            return None;
        }
        let space = p.get("sp")?.as_str().filter(|s| is_lower_hex(s, 32))?;
        let key_id = p.get("ep")?.as_str().filter(|s| is_lower_hex(s, 16))?;
        let seq = p.get("seq").and_then(safe_integer).filter(|s| *s >= 1)?;
        let delegation = Event::from_value(p.get("dlg")?)?;
        let body = match p.get("t")?.as_str()? {
            "ch" => Body::Changes(
                p.get("c")?
                    .as_array()?
                    .iter()
                    .map(Change::parse)
                    .collect::<Option<_>>()?,
            ),
            "op" => {
                let op = p.get("op")?;
                // `typeof x === 'object' && x !== null`: arrays pass too.
                if !(op.is_object() || op.is_array()) {
                    return None;
                }
                let par = p
                    .get("par")?
                    .as_array()?
                    .iter()
                    .map(|x| x.as_str().map(str::to_owned))
                    .collect::<Option<_>>()?;
                Body::Op {
                    op: op.clone(),
                    par,
                }
            }
            "snap" => {
                let sid = p.get("sid")?.as_str()?.to_owned();
                let i = p.get("i").and_then(safe_integer)?;
                let n = p.get("n").and_then(safe_integer)?;
                if i < 0 || i >= n || n > 10_000 {
                    return None;
                }
                Body::Snap {
                    sid,
                    i: i as u32,
                    n: n as u32,
                    body: p.get("body").cloned().unwrap_or(Value::Null),
                }
            }
            _ => return None,
        };
        Some(Self {
            space: space.into(),
            key_id: key_id.into(),
            seq: seq as u64,
            delegation,
            reads_picked_relays: p.get("rp").and_then(safe_integer) == Some(1),
            body,
            raw: p.clone(),
        })
    }
}
