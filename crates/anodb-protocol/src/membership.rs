//! Space membership (PROTOCOL.md §5.1): a DAG of signed ops, evaluated deterministically so every
//! device derives the same roles and cut-offs from the same log.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde_json::Value;

use crate::derive::space_id;
use crate::event::Event;
use crate::identity::verify_revocation;
use crate::keys::is_lower_hex;
use crate::payload::safe_integer;
use crate::policy::Role;

/// device pubkey → highest accepted seq
pub type Cutoffs = BTreeMap<String, u64>;

#[derive(Debug, Clone, PartialEq)]
pub enum MemberOp {
    Create {
        owner: String,
        nonce: String,
        name: String,
    },
    /// `role` is never `Owner`.
    Add {
        identity: String,
        role: Role,
    },
    Role {
        identity: String,
        role: Role,
        cut: Option<Cutoffs>,
    },
    Remove {
        identity: String,
        cut: Cutoffs,
    },
    Leave {
        cut: Cutoffs,
    },
    Transfer {
        identity: String,
    },
    Revoke {
        /// The relayed kind 7304 revocation (already verified by [`parse_op`]).
        revocation: Event,
        /// The device the revocation names.
        device: String,
        cut: Cutoffs,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpRecord {
    /// Inner message id.
    pub id: String,
    /// Signing identity (from the delegation).
    pub identity: String,
    pub op: MemberOp,
    pub par: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Membership {
    pub owner: Option<String>,
    pub roles: BTreeMap<String, Role>,
    /// device → cut-off; writes with a higher seq from that device are rejected.
    pub cut: BTreeMap<String, u64>,
    /// Identities that held a write role at some point (so their writes up to a cut-off count).
    pub ever_writer: BTreeSet<String>,
    pub revoked_devices: BTreeSet<String>,
    /// Ops that were valid, in evaluation order.
    pub valid: Vec<String>,
    /// identity → ids of the removals of it applied so far.
    removals: HashMap<String, Vec<String>>,
}

fn non_owner_role(v: &Value) -> Option<Role> {
    match v.as_str()? {
        "admin" => Some(Role::Admin),
        "writer" => Some(Role::Writer),
        "reader" => Some(Role::Reader),
        _ => None,
    }
}

/// `isCut`: any JS object (an array included) whose entries are `<64 hex>: <safe integer ≥ 0>`.
fn cutoffs(v: &Value) -> Option<Cutoffs> {
    match v {
        Value::Object(m) => m
            .iter()
            .map(|(k, v)| {
                let seq = safe_integer(v).filter(|s| *s >= 0)?;
                is_lower_hex(k, 64).then(|| (k.clone(), seq as u64))
            })
            .collect(),
        // Object.entries of an array has keys "0", "1", … which are never 64 hex chars.
        Value::Array(a) if a.is_empty() => Some(Cutoffs::new()),
        _ => None,
    }
}

fn hex64(v: Option<&Value>) -> Option<String> {
    v?.as_str()
        .filter(|s| is_lower_hex(s, 64))
        .map(str::to_owned)
}

/// `parseOp`: the op carried by an `op` message, or `None` if it is malformed.
pub fn parse_op(v: &Value) -> Option<MemberOp> {
    let x = v.as_object()?;
    let identity = || hex64(x.get("identity"));
    let cut = || x.get("cut").and_then(cutoffs);
    Some(match x.get("type")?.as_str()? {
        "create" => MemberOp::Create {
            owner: hex64(x.get("owner"))?,
            nonce: x.get("nonce")?.as_str()?.to_owned(),
            name: x.get("name")?.as_str()?.to_owned(),
        },
        "add" => MemberOp::Add {
            identity: identity()?,
            role: non_owner_role(x.get("role")?)?,
        },
        "role" => MemberOp::Role {
            identity: identity()?,
            role: non_owner_role(x.get("role")?)?,
            cut: match x.get("cut") {
                None => None,
                Some(c) => Some(cutoffs(c)?),
            },
        },
        "remove" => MemberOp::Remove {
            identity: identity()?,
            cut: cut()?,
        },
        "leave" => MemberOp::Leave { cut: cut()? },
        "transfer" => MemberOp::Transfer {
            identity: identity()?,
        },
        "revoke" => {
            let cut = cut()?;
            let revocation = Event::from_value(x.get("revocation")?)?;
            let (_, device) = verify_revocation(&revocation)?;
            MemberOp::Revoke {
                revocation,
                device,
                cut,
            }
        }
        _ => return None,
    })
}

/// Deterministically evaluate a membership log.
///
/// - Ops form a DAG through `par`. An op with an unknown ancestor (or on a cycle) is not evaluated.
/// - An op is valid iff its author was allowed to perform it in the state formed by its valid
///   ancestors.
/// - A removal wins over every add / role change for the same identity that is not its descendant.
/// - Cut-offs combine to the smaller value.
///
/// `device_identity` maps a device to its identity (to lift that identity's cut-offs on a re-add).
/// Record ids must be unique; with duplicates the last record wins.
pub fn evaluate<F>(space: &str, records: &[OpRecord], device_identity: F) -> Membership
where
    F: Fn(&str) -> Option<String>,
{
    let by_id: HashMap<&str, &OpRecord> = records.iter().map(|r| (r.id.as_str(), r)).collect();

    // Ancestor sets; `None` when an ancestor is missing or the op is on a cycle.
    let mut anc: HashMap<&str, Option<HashSet<&str>>> = HashMap::new();
    fn ancestors<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a OpRecord>,
        anc: &mut HashMap<&'a str, Option<HashSet<&'a str>>>,
        stack: &mut HashSet<&'a str>,
    ) -> bool {
        if let Some(m) = anc.get(id) {
            return m.is_some();
        }
        let Some(r) = by_id.get(id) else { return false };
        if !stack.insert(id) {
            return false;
        }
        let mut out = HashSet::new();
        let mut ok = true;
        for p in &r.par {
            if !ancestors(p, by_id, anc, stack) {
                ok = false;
                break;
            }
            out.insert(p.as_str());
            out.extend(anc[p.as_str()].as_ref().expect("resolved").iter().copied());
        }
        stack.remove(id);
        anc.insert(id, ok.then_some(out));
        ok
    }
    for id in by_id.keys() {
        ancestors(id, &by_id, &mut anc, &mut HashSet::new());
    }

    // Ancestor count then id is a topological order (a parent always has fewer ancestors).
    let mut order: Vec<(&OpRecord, &HashSet<&str>)> = by_id
        .iter()
        .filter_map(|(id, r)| anc[id].as_ref().map(|a| (*r, a)))
        .collect();
    order.sort_by(|(a, aa), (b, ba)| aa.len().cmp(&ba.len()).then_with(|| a.id.cmp(&b.id)));

    let mut valid: HashSet<&str> = HashSet::new();
    let fold = |ids: &dyn Fn(&str) -> bool, valid: &HashSet<&str>| {
        let mut st = Membership::default();
        for (r, a) in &order {
            if ids(&r.id) && valid.contains(r.id.as_str()) {
                apply(&mut st, r, a, &device_identity);
            }
        }
        st
    };
    for (r, a) in &order {
        let before = fold(&|id| a.contains(id), &valid);
        if allowed(space, &before, r) {
            valid.insert(&r.id);
        }
    }
    let mut out = fold(&|_| true, &valid);
    out.valid = order
        .iter()
        .filter(|(r, _)| valid.contains(r.id.as_str()))
        .map(|(r, _)| r.id.clone())
        .collect();
    out.removals.clear();
    out
}

fn allowed(space: &str, st: &Membership, r: &OpRecord) -> bool {
    let me = st.roles.get(&r.identity).copied();
    let owner = me == Some(Role::Owner);
    let admin = me == Some(Role::Admin);
    match &r.op {
        MemberOp::Create {
            owner: o, nonce, ..
        } => r.par.is_empty() && *o == r.identity && space_id(o, nonce) == space,
        MemberOp::Add { identity, role } => {
            if st.owner.is_none() || st.roles.contains_key(identity) {
                return false;
            }
            owner || (admin && *role != Role::Admin)
        }
        MemberOp::Role { identity, role, .. } => match st.roles.get(identity) {
            None | Some(Role::Owner) => false,
            Some(&target) => owner || (admin && target != Role::Admin && *role != Role::Admin),
        },
        MemberOp::Remove { identity, .. } => match st.roles.get(identity) {
            None | Some(Role::Owner) => false,
            Some(&target) => owner || (admin && target != Role::Admin),
        },
        MemberOp::Leave { .. } => me.is_some() && !owner,
        MemberOp::Transfer { identity } => {
            owner && st.roles.contains_key(identity) && *identity != r.identity
        }
        MemberOp::Revoke { .. } => me.is_some(),
    }
}

fn merge_cut(st: &mut Membership, cut: &Cutoffs) {
    for (device, &seq) in cut {
        st.cut
            .entry(device.clone())
            .and_modify(|c| *c = (*c).min(seq)) // stricter cut-off wins
            .or_insert(seq);
    }
}

fn lift_cut<F: Fn(&str) -> Option<String>>(
    st: &mut Membership,
    identity: &str,
    device_identity: &F,
) {
    st.cut
        .retain(|d, _| device_identity(d).as_deref() != Some(identity));
}

fn apply<F: Fn(&str) -> Option<String>>(
    st: &mut Membership,
    r: &OpRecord,
    ancestors: &HashSet<&str>,
    device_identity: &F,
) {
    let removed_concurrently = |st: &Membership, identity: &str| {
        st.removals
            .get(identity)
            .is_some_and(|rs| rs.iter().any(|rem| !ancestors.contains(rem.as_str())))
    };
    match &r.op {
        MemberOp::Create { owner, .. } => {
            st.owner = Some(owner.clone());
            st.roles.insert(owner.clone(), Role::Owner);
            st.ever_writer.insert(owner.clone());
        }
        MemberOp::Add { identity, role } => {
            if removed_concurrently(st, identity) {
                return;
            }
            st.roles.insert(identity.clone(), *role);
            if Role::can_write(Some(*role)) {
                st.ever_writer.insert(identity.clone());
            }
            // A (re-)add after a removal lifts that identity's old cut-offs.
            lift_cut(st, identity, device_identity);
        }
        MemberOp::Role {
            identity,
            role,
            cut,
        } => {
            if removed_concurrently(st, identity) || !st.roles.contains_key(identity) {
                return;
            }
            st.roles.insert(identity.clone(), *role);
            if Role::can_write(Some(*role)) {
                st.ever_writer.insert(identity.clone());
                lift_cut(st, identity, device_identity);
            } else if let Some(c) = cut {
                merge_cut(st, c);
            }
        }
        MemberOp::Remove { identity, cut } => {
            st.roles.remove(identity);
            merge_cut(st, cut);
            st.removals
                .entry(identity.clone())
                .or_default()
                .push(r.id.clone());
        }
        MemberOp::Leave { cut } => {
            st.roles.remove(&r.identity);
            merge_cut(st, cut);
        }
        MemberOp::Transfer { identity } => {
            if let Some(old) = st.owner.take() {
                st.roles.insert(old, Role::Admin);
            }
            st.owner = Some(identity.clone());
            st.roles.insert(identity.clone(), Role::Owner);
            st.ever_writer.insert(identity.clone());
        }
        MemberOp::Revoke { device, cut, .. } => {
            st.revoked_devices.insert(device.clone());
            merge_cut(st, cut);
        }
    }
}

impl Membership {
    /// May `identity` (via `device`) have written message number `seq`?
    pub fn may_write(&self, identity: &str, device: &str, seq: u64) -> bool {
        let cut = self.cut.get(device).copied();
        if cut.is_some_and(|c| seq > c) {
            return false;
        }
        if self.revoked_devices.contains(device) && cut.is_none() {
            return false;
        }
        if Role::can_write(self.roles.get(identity).copied()) {
            return true;
        }
        // No longer a writer: only messages up to the cut-off recorded when the role was lost.
        cut.is_some() && self.ever_writer.contains(identity)
    }

    /// May `identity` distribute keys / snapshots for the space?
    pub fn may_manage(&self, identity: &str) -> bool {
        Role::is_admin(self.roles.get(identity).copied())
    }

    pub fn role_of(&self, identity: &str) -> Option<Role> {
        self.roles.get(identity).copied()
    }
}
