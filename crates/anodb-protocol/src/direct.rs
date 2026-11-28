//! Messages to one device (inbox, PROTOCOL.md §5.3) or to a pairing secret (§5.5), the key grants
//! they carry, portable signed ops, pairing codes and key packages (§5.6).

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::Error;
use crate::derive::{inbox_tag, secret_key_for, secret_tag};
use crate::envelope::seal;
use crate::event::{Event, Template};
use crate::identity::verify_delegation;
use crate::keys::{Secret, is_lower_hex};
use crate::membership::{Membership, OpRecord, parse_op};
use crate::nip44;
use crate::payload::{
    Body, KEY_PACKAGE_KIND, MESSAGE_KIND, PROTOCOL_VERSION, StreamPayload, TAG, WRAP_KIND,
    safe_integer,
};
use crate::policy::Role;

/// Direct envelopes with longer content are not decrypted.
pub const MAX_DIRECT_CONTENT: usize = 200_000;

/// `{ v: 2, t, dlg, … }` (`parseInboxPayload`).
#[derive(Debug, Clone, PartialEq)]
pub struct InboxPayload {
    pub t: String,
    pub delegation: Event,
    /// The whole payload object.
    pub raw: Map<String, Value>,
}

pub fn parse_inbox_payload(json: &str) -> Option<InboxPayload> {
    let v: Value = serde_json::from_str(json).ok()?;
    let p = v.as_object()?;
    if p.get("v").and_then(safe_integer) != Some(PROTOCOL_VERSION as i64) {
        return None;
    }
    Some(InboxPayload {
        t: p.get("t")?.as_str()?.to_owned(),
        delegation: Event::from_value(p.get("dlg")?)?,
        raw: p.clone(),
    })
}

/// A verified direct message.
#[derive(Debug, Clone)]
pub struct Direct {
    pub inner: Event,
    pub payload: InboxPayload,
    /// Identity that delegated to the device that signed `inner`.
    pub sender: String,
}

/// `openDirect`: verify and decrypt a direct envelope with its conversation key.
pub fn open_direct(outer: &Event, conversation_key: &[u8; 32]) -> Option<Direct> {
    if outer.content.encode_utf16().count() > MAX_DIRECT_CONTENT || !outer.verify() {
        return None;
    }
    let inner_json = nip44::decrypt(&outer.content, conversation_key).ok()?;
    let inner = Event::from_value(&serde_json::from_str(&inner_json).ok()?)?;
    if inner.kind != MESSAGE_KIND || !inner.verify() {
        return None;
    }
    let payload = parse_inbox_payload(&inner.content)?;
    let sender = verify_delegation(&payload.delegation, &inner.pubkey)?;
    Some(Direct {
        inner,
        payload,
        sender,
    })
}

fn routed_to(outer: &Event, tag: &str) -> bool {
    outer.kind == WRAP_KIND && outer.tag(TAG) == Some(tag)
}

/// Open an envelope in this device's inbox.
pub fn open_inbox(outer: &Event, device: &Secret) -> Option<Direct> {
    if !routed_to(outer, &inbox_tag(&device.public_hex())) {
        return None;
    }
    open_direct(outer, &nip44::conversation_key(device, &outer.pubkey).ok()?)
}

/// Open an envelope sent to a pairing secret.
pub fn open_pairing(outer: &Event, secret: &str) -> Option<Direct> {
    if !routed_to(outer, &secret_tag(secret)) {
        return None;
    }
    open_direct(outer, &secret_key_for(secret))
}

/// Seal an inner message to one device's inbox, from a throwaway key (so relays cannot link the
/// sender).
pub fn seal_to_device(inner: &Event, device_pubkey: &str, created_at: u64) -> Result<Event, Error> {
    let eph = Secret::generate();
    let ck = nip44::conversation_key(&eph, device_pubkey)?;
    seal(
        &inner.to_json(),
        &inbox_tag(device_pubkey),
        &ck,
        &eph,
        created_at,
    )
}

/// Seal an inner message to a pairing secret.
pub fn seal_to_secret(inner: &Event, secret: &str, created_at: u64) -> Result<Event, Error> {
    seal(
        &inner.to_json(),
        &secret_tag(secret),
        &secret_key_for(secret),
        &Secret::generate(),
        created_at,
    )
}

/// The space key (and op log) carried by a `key` / `invite` message or a pairing grant.
#[derive(Debug, Clone, PartialEq)]
pub struct KeyGrant {
    pub space: String,
    /// `None` when absent.
    pub name: Option<String>,
    pub personal: bool,
    /// Epoch number (§5.2).
    pub num: u64,
    pub key: [u8; 32],
    /// The string entries of `ops` (signed inner op events, see [`portable_op`]).
    pub ops: Vec<String>,
}

/// `parseKeyGrant`.
pub fn parse_key_grant(v: &Value) -> Option<KeyGrant> {
    let x = v.as_object()?;
    let key = x.get("key")?.as_str().filter(|k| is_lower_hex(k, 64))?;
    Some(KeyGrant {
        space: x.get("sp")?.as_str()?.to_owned(),
        name: match x.get("name") {
            None => None,
            Some(n) => Some(n.as_str()?.to_owned()),
        },
        personal: x.get("personal").and_then(Value::as_bool).unwrap_or(false),
        num: x.get("num").and_then(safe_integer).filter(|n| *n >= 0)? as u64,
        key: hex::decode(key).ok()?.try_into().ok()?,
        ops: x
            .get("ops")?
            .as_array()?
            .iter()
            .filter_map(|o| o.as_str().map(str::to_owned))
            .collect(),
    })
}

/// The receiver's role if a `key` / `invite` grant from `sender` is acceptable under `m`: the
/// sender manages the space (or is the receiver's own identity) and the receiver is a member.
pub fn grant_role(m: &Membership, sender: &str, me: &str) -> Option<Role> {
    if m.may_manage(sender) || sender == me {
        m.role_of(me)
    } else {
        None
    }
}

/// A complete signed inner op event, verified without the epoch keys.
#[derive(Debug, Clone)]
pub struct PortableOp {
    pub id: String,
    pub device: String,
    pub identity: String,
    pub seq: u64,
    pub inner: Event,
    pub payload: StreamPayload,
}

impl PortableOp {
    /// The membership record, if its op parses.
    pub fn record(&self) -> Option<OpRecord> {
        let Body::Op { op, par } = &self.payload.body else {
            return None;
        };
        Some(OpRecord {
            id: self.id.clone(),
            identity: self.identity.clone(),
            op: parse_op(op)?,
            par: par.clone(),
        })
    }
}

/// `portableOp`.
pub fn portable_op(space: &str, inner_json: &str) -> Option<PortableOp> {
    let inner = Event::from_value(&serde_json::from_str(inner_json).ok()?)?;
    if inner.kind != MESSAGE_KIND || !inner.verify() {
        return None;
    }
    let payload = StreamPayload::parse(&inner.content)?;
    if payload.space != space || !matches!(payload.body, Body::Op { .. }) {
        return None;
    }
    let identity = verify_delegation(&payload.delegation, &inner.pubkey)?;
    Some(PortableOp {
        id: inner.id.clone(),
        device: inner.pubkey.clone(),
        identity,
        seq: payload.seq,
        inner,
        payload,
    })
}

/// The 6-digit code both devices show while pairing.
pub fn pairing_code(device_pubkey: &str, secret: &str) -> String {
    let h = Sha256::digest(format!("anodb/v2/pair-code/{device_pubkey}/{secret}"));
    let n = u32::from_be_bytes([h[0], h[1], h[2], h[3]]);
    format!("{:06}", n % 1_000_000)
}

/// `createKeyPackage`: the identity's current device delegations, signed by the identity.
pub fn create_key_package(identity: &Secret, delegations: &[Event], created_at: u64) -> Event {
    Event::sign(
        identity,
        Template {
            kind: KEY_PACKAGE_KIND,
            created_at,
            tags: delegations
                .iter()
                .filter_map(|d| d.tag("device"))
                .map(|d| vec!["device".into(), d.into()])
                .collect(),
            content: json!({ "v": 2, "delegations": delegations }).to_string(),
        },
    )
}

/// `parseKeyPackage`: verified `(device, delegation)` pairs.
pub fn parse_key_package(ev: &Event) -> Vec<(String, Event)> {
    if ev.kind != KEY_PACKAGE_KIND || !ev.verify() {
        return vec![];
    }
    let Ok(content) = serde_json::from_str::<Value>(&ev.content) else {
        return vec![];
    };
    let Some(list) = content.get("delegations").and_then(Value::as_array) else {
        return vec![];
    };
    list.iter()
        .filter_map(Event::from_value)
        .filter_map(|d| {
            let device = d.tag("device").filter(|s| !s.is_empty())?.to_owned();
            (verify_delegation(&d, &device).as_deref() == Some(ev.pubkey.as_str()))
                .then_some((device, d))
        })
        .collect()
}
