//! Snapshots (PROTOCOL.md §5.4): assembling multi-part `snap` messages, deciding whether to trust
//! them, and which of their cells to merge.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

use crate::membership::Membership;
use crate::payload::{Body, Change, StreamPayload, safe_integer};
use crate::policy::{Role, SYS_DELETED, TableRule, change_allowed};

/// One stored `snap` message.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotMessage {
    pub device: String,
    pub identity: String,
    pub seq: u64,
    pub sid: String,
    pub i: u32,
    pub n: u32,
    pub body: Value,
}

impl SnapshotMessage {
    pub fn from_payload(device: &str, identity: &str, p: &StreamPayload) -> Option<Self> {
        let Body::Snap { sid, i, n, body } = &p.body else {
            return None;
        };
        Some(Self {
            device: device.into(),
            identity: identity.into(),
            seq: p.seq,
            sid: sid.clone(),
            i: *i,
            n: *n,
            body: body.clone(),
        })
    }
}

/// A snapshot whose parts have all arrived.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub device: String,
    pub author: String,
    /// Highest seq among its parts.
    pub last: u64,
    pub cells: Vec<Change>,
    /// device → seq covered (from part 0).
    pub heads: BTreeMap<String, i64>,
}

/// `assembleSnapshots`: complete snapshots, grouped by device and `sid`, in message order.
pub fn assemble_snapshots(messages: &[SnapshotMessage]) -> Vec<Snapshot> {
    let mut index: HashMap<(&str, &str), usize> = HashMap::new();
    let mut groups: Vec<Vec<&SnapshotMessage>> = vec![];
    for m in messages {
        let k = (m.device.as_str(), m.sid.as_str());
        let g = *index.entry(k).or_insert_with(|| {
            groups.push(vec![]);
            groups.len() - 1
        });
        groups[g].push(m);
    }
    let mut out = vec![];
    for parts in groups {
        let n = parts[0].n;
        let distinct: HashSet<u32> = parts.iter().map(|p| p.i).collect();
        if parts.len() != n as usize
            || distinct.len() != n as usize
            || parts.iter().any(|p| p.n != n)
        {
            continue;
        }
        let cells = parts
            .iter()
            .filter_map(|p| p.body.get("cells")?.as_array())
            .flatten()
            .filter_map(Change::parse_cell)
            .collect();
        let mut heads = BTreeMap::new();
        if let Some(h) = parts
            .iter()
            .find(|p| p.i == 0)
            .and_then(|p| p.body.get("heads"))
        {
            // `Object.entries`: an array's entries are keyed by index.
            let entries: Vec<(String, &Value)> = match h {
                Value::Object(o) => o.iter().map(|(k, v)| (k.clone(), v)).collect(),
                Value::Array(a) => a
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (i.to_string(), v))
                    .collect(),
                _ => vec![],
            };
            for (d, v) in entries {
                if let Some(seq) = safe_integer(v) {
                    heads.insert(d, seq);
                }
            }
        }
        out.push(Snapshot {
            device: parts[0].device.clone(),
            author: parts[0].identity.clone(),
            last: parts.iter().map(|p| p.seq).max().expect("non-empty"),
            cells,
            heads,
        });
    }
    out
}

/// Whether a complete snapshot is merged: its author may write (cut-offs included) and is the
/// owner or an admin — or `me`, for this identity's own devices. A snapshot restates other members'
/// rows, so a plain writer's snapshot could otherwise rewrite or impersonate them.
pub fn snapshot_trusted(m: &Membership, me: &str, s: &Snapshot) -> bool {
    m.may_write(&s.author, &s.device, s.last)
        && (s.author == me || matches!(m.role_of(&s.author), Some(Role::Owner | Role::Admin)))
}

/// The cells of a trusted snapshot to merge. Cells that name their signer must pass the row rule
/// for that signer; cells of a server-confirmed table count only in a snapshot by its authority.
pub fn snapshot_changes<'r>(
    s: &Snapshot,
    rule_of: impl Fn(&str) -> Option<&'r TableRule>,
    m: &Membership,
) -> Vec<Change> {
    s.cells
        .iter()
        .filter(|c| {
            let rule = rule_of(&c.table);
            if let Some(TableRule::Confirmed { authority }) = rule {
                return s.author == *authority;
            }
            match &c.by {
                None => true,
                Some(by) => change_allowed(rule, c, by, m.role_of(by)),
            }
        })
        .cloned()
        .collect()
}

/// `snapshotCells`: the cells to restate. Deleted rows keep only their tombstone, so late writes
/// cannot resurrect them and their former values never reach new members or devices.
pub fn snapshot_cells(cells: &[Change]) -> Vec<Change> {
    let deleted: HashSet<(&str, &str)> = cells
        .iter()
        .filter(|c| c.column == SYS_DELETED && c.value == Value::Bool(true))
        .map(|c| (c.table.as_str(), c.row_id.as_str()))
        .collect();
    cells
        .iter()
        .filter(|c| {
            !deleted.contains(&(c.table.as_str(), c.row_id.as_str())) || c.column == SYS_DELETED
        })
        .cloned()
        .collect()
}
