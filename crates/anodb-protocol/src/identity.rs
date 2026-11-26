//! Identity → device delegations and revocations (kind 7304, PROTOCOL.md §1.1).

use crate::event::{Event, Template};
use crate::keys::Secret;
use crate::payload::DELEGATION_KIND;

pub fn create_delegation(
    identity: &Secret,
    device_pubkey: &str,
    name: &str,
    created_at: u64,
) -> Event {
    Event::sign(
        identity,
        Template {
            kind: DELEGATION_KIND,
            created_at,
            tags: vec![vec!["device".into(), device_pubkey.into()]],
            content: serde_json::json!({ "name": name }).to_string(),
        },
    )
}

pub fn create_revocation(identity: &Secret, device_pubkey: &str, created_at: u64) -> Event {
    Event::sign(
        identity,
        Template {
            kind: DELEGATION_KIND,
            created_at,
            tags: vec![vec!["revoke".into(), device_pubkey.into()]],
            content: String::new(),
        },
    )
}

/// The identity public key if `ev` validly delegates to `device_pubkey`.
pub fn verify_delegation(ev: &Event, device_pubkey: &str) -> Option<String> {
    if ev.kind != DELEGATION_KIND {
        return None;
    }
    if !ev.tags.iter().any(|t| {
        t.first().map(String::as_str) == Some("device")
            && t.get(1).map(String::as_str) == Some(device_pubkey)
    }) {
        return None;
    }
    ev.verify().then(|| ev.pubkey.clone())
}

/// `(identity, device)` if `ev` is a valid revocation.
pub fn verify_revocation(ev: &Event) -> Option<(String, String)> {
    if ev.kind != DELEGATION_KIND {
        return None;
    }
    let device = ev
        .tags
        .iter()
        .find(|t| t.first().map(String::as_str) == Some("revoke") && t.len() >= 2)?
        .get(1)?
        .clone();
    ev.verify().then(|| (ev.pubkey.clone(), device))
}
