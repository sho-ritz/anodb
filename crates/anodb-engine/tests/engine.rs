//! Engine behaviour between devices, exchanging envelopes directly (no relay).

use anodb_engine::{ColumnType, Engine, EngineError, Ingest, Options, Schema, TableDef};
use anodb_protocol::Role;
use serde_json::{Map, Value, json};

fn schema() -> Schema {
    Schema::new()
        .table(
            "todo",
            TableDef::new(&[("title", ColumnType::Text), ("done", ColumnType::Boolean)]),
        )
        .unwrap()
        .table("note", TableDef::new(&[("text", ColumnType::Text)]).owned())
        .unwrap()
}

fn open() -> Engine {
    Engine::open(Options::new(":memory:", schema())).unwrap()
}

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

/// A stand-in relay: keeps every envelope and offers all of them to every engine, until nothing
/// new is accepted.
fn exchange(stored: &mut Vec<anodb_protocol::Event>, engines: &mut [&mut Engine]) {
    for _ in 0..10 {
        for e in engines.iter_mut() {
            for ev in e.outbox().unwrap() {
                e.delivered(&ev.id).unwrap();
                stored.push(ev);
            }
        }
        let mut moved = false;
        for e in engines.iter_mut() {
            for ev in stored.iter() {
                if e.ingest(ev).unwrap().0 == Ingest::New {
                    moved = true;
                }
            }
        }
        if !moved && engines.iter().all(|e| e.outbox().unwrap().is_empty()) {
            return;
        }
    }
}

fn titles(e: &Engine, space: &str) -> Vec<String> {
    e.query(
        "SELECT title FROM todo WHERE space = ? ORDER BY title",
        &[space.to_owned().into()],
    )
    .unwrap()
    .into_iter()
    .map(|r| r["title"].as_str().unwrap_or_default().to_owned())
    .collect()
}

#[test]
fn personal_space_and_projection() {
    let mut a = open();
    let id = a
        .insert(
            None,
            "todo",
            &obj(json!({ "title": "milk", "done": false })),
        )
        .unwrap();
    assert!(id.starts_with(a.pubkey()));
    a.update(None, "todo", &id, &obj(json!({ "done": true })))
        .unwrap();
    let rows = a.query("SELECT * FROM todo", &[]).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["title"], "milk");
    assert_eq!(rows[0]["done"], 1);
    assert_eq!(rows[0]["createdBy"], a.pubkey());
    assert_eq!(rows[0]["space"], a.personal_space());
    a.delete(None, "todo", &id).unwrap();
    assert!(a.query("SELECT * FROM todo", &[]).unwrap().is_empty());
    // Type checks.
    assert!(matches!(
        a.insert(None, "todo", &obj(json!({ "title": 5 }))),
        Err(EngineError::Invalid(_))
    ));
}

#[test]
fn invite_accept_and_write_both_ways() {
    let mut a = open();
    let mut b = open();
    let mut bus = vec![];
    let space = a.create_space("Family").unwrap();
    a.insert(Some(&space), "todo", &obj(json!({ "title": "milk" })))
        .unwrap();
    let (bk, bd) = (b.pubkey().to_owned(), b.delegation().clone());
    a.add_member(&space, &bk, Role::Writer, &[bd]).unwrap();
    exchange(&mut bus, &mut [&mut a, &mut b]);
    let inv = b.invitations().unwrap();
    assert_eq!(inv.len(), 1);
    assert_eq!(inv[0].space, space);
    assert_eq!(inv[0].role, Role::Writer);
    assert_eq!(inv[0].from, a.pubkey());
    // Not synced before accepting.
    assert!(titles(&b, &space).is_empty());
    b.accept_invitation(&space).unwrap();
    exchange(&mut bus, &mut [&mut a, &mut b]);
    // b catches up from the snapshot posted in the new epoch.
    assert_eq!(titles(&b, &space), ["milk"]);
    assert_eq!(b.role_in(&space).unwrap(), Some(Role::Writer));
    b.insert(Some(&space), "todo", &obj(json!({ "title": "eggs" })))
        .unwrap();
    exchange(&mut bus, &mut [&mut a, &mut b]);
    assert_eq!(titles(&a, &space), ["eggs", "milk"]);
}

#[test]
fn row_rule_and_removal() {
    let mut a = open();
    let mut b = open();
    let mut bus = vec![];
    let space = a.create_space("Team").unwrap();
    let (bk, bd) = (b.pubkey().to_owned(), b.delegation().clone());
    a.add_member(&space, &bk, Role::Writer, &[bd]).unwrap();
    exchange(&mut bus, &mut [&mut a, &mut b]);
    b.accept_invitation(&space).unwrap();
    let note = a
        .insert(Some(&space), "note", &obj(json!({ "text": "mine" })))
        .unwrap();
    exchange(&mut bus, &mut [&mut a, &mut b]);
    // Owned table: b may not edit a's row.
    assert!(matches!(
        b.update(
            Some(&space),
            "note",
            &note,
            &obj(json!({ "text": "hijacked" }))
        ),
        Err(EngineError::Unauthorized(_))
    ));
    // A removed member's writes after the cut-off are ignored, even if they arrive later.
    b.insert(Some(&space), "todo", &obj(json!({ "title": "before" })))
        .unwrap();
    exchange(&mut bus, &mut [&mut a, &mut b]);
    b.insert(Some(&space), "todo", &obj(json!({ "title": "late" })))
        .unwrap(); // seq 2, not seen yet
    let cut: Map<String, Value> = [(b.device_pubkey().to_owned(), json!(1))]
        .into_iter()
        .collect();
    a.post_op(
        &space,
        json!({ "type": "remove", "identity": bk, "cut": cut }),
    )
    .unwrap();
    exchange(&mut bus, &mut [&mut a, &mut b]);
    assert_eq!(a.members(&space).unwrap().len(), 1);
    assert_eq!(titles(&a, &space), ["before"]);
    // b learned it was removed and refuses to write.
    assert_eq!(
        b.spaces()
            .unwrap()
            .iter()
            .find(|s| s.id == space)
            .unwrap()
            .status,
        "removed"
    );
    assert!(
        b.insert(Some(&space), "todo", &obj(json!({ "title": "x" })))
            .is_err()
    );
    // An admin-only action by a writer is refused.
    let mut c = open();
    let (ck, cd) = (c.pubkey().to_owned(), c.delegation().clone());
    assert!(matches!(
        b.add_member(&space, &ck, Role::Reader, &[cd]),
        Err(EngineError::Unauthorized(_))
    ));
    let _ = &mut c;
}

#[test]
fn persists_across_reopen() {
    let dir = std::env::temp_dir().join(format!("anodb-engine-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("db.sqlite");
    let _ = std::fs::remove_file(&path);
    let p = path.to_str().unwrap();
    let (pk, personal) = {
        let mut a = Engine::open(Options::new(p, schema())).unwrap();
        a.insert(None, "todo", &obj(json!({ "title": "kept" })))
            .unwrap();
        (a.pubkey().to_owned(), a.personal_space().to_owned())
    };
    let a = Engine::open(Options::new(p, schema())).unwrap();
    assert_eq!(a.pubkey(), pk);
    assert_eq!(a.personal_space(), personal);
    assert_eq!(titles(&a, &personal), ["kept"]);
    let _ = std::fs::remove_dir_all(&dir);
}
