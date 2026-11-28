//! Protocol v2 conformance, §5.3–5.6: direct messages, grants, portable ops, pairing, key
//! packages and snapshots.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use anodb_protocol::direct::{
    grant_role, open_direct, open_inbox, open_pairing, pairing_code, parse_key_grant,
    parse_key_package, portable_op, seal_to_device, seal_to_secret,
};
use anodb_protocol::identity::create_delegation;
use anodb_protocol::membership::{Membership, OpRecord, evaluate, parse_op};
use anodb_protocol::nip44::conversation_key;
use anodb_protocol::payload::{Change, StreamPayload};
use anodb_protocol::policy::{Role, TableRule};
use anodb_protocol::snapshot::{
    SnapshotMessage, assemble_snapshots, snapshot_cells, snapshot_changes, snapshot_trusted,
};
use anodb_protocol::{Event, Secret, sign_inner};
use serde_json::{Value, json};

fn load(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/v2")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().unwrap()
}

fn membership_of(records: &Value) -> Membership {
    let recs: Vec<OpRecord> = arr(records)
        .iter()
        .map(|r| OpRecord {
            id: s(&r["id"]).into(),
            identity: s(&r["identity"]).into(),
            op: parse_op(&r["op"]).unwrap(),
            par: arr(&r["par"]).iter().map(|p| s(p).into()).collect(),
        })
        .collect();
    let devices: HashMap<String, String> = load("membership")["devices"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(d, i)| (d.clone(), s(i).into()))
        .collect();
    evaluate(s(&load("direct")["space"]), &recs, |d| {
        devices.get(d).cloned()
    })
}

#[test]
fn direct_messages() {
    let v = load("direct");
    let recipient = Secret::parse(s(&v["recipientSecret"])).unwrap();
    for c in arr(&v["inbox"]) {
        let name = s(&c["name"]);
        let outer = Event::from_value(&c["outer"]).unwrap();
        let ck = conversation_key(&recipient, &outer.pubkey).unwrap();
        let got = open_direct(&outer, &ck);
        let want = &c["result"];
        assert_eq!(got.is_some(), !want.is_null(), "{name}");
        if let Some(d) = got {
            assert_eq!(d.sender, s(&want["sender"]), "{name}");
            assert_eq!(d.inner.pubkey, s(&want["device"]), "{name}");
            assert_eq!(d.payload.t, s(&want["t"]), "{name}");
            assert_eq!(d.inner.id, s(&want["msgId"]), "{name}");
            // The same, through the inbox routing check.
            assert!(open_inbox(&outer, &recipient).is_some(), "{name}");
        }
    }
    let p = &v["pairing"];
    let outer = Event::from_value(&p["outer"]).unwrap();
    let d = open_pairing(&outer, s(&p["secret"])).unwrap();
    assert_eq!(d.sender, s(&p["result"]["sender"]));
    assert_eq!(d.payload.t, s(&p["result"]["t"]));
    assert!(open_pairing(&outer, "ffffffffffffffffffffffffffffffff").is_none());
    for c in arr(&v["pairingCodes"]) {
        assert_eq!(
            pairing_code(s(&c["device"]), s(&c["secret"])),
            s(&c["code"])
        );
    }
}

#[test]
fn direct_round_trip() {
    // What Rust seals to a device or a secret, Rust opens (and only the right receiver).
    let identity = Secret::generate();
    let device = Secret::generate();
    let receiver = Secret::generate();
    let dlg = create_delegation(&identity, &device.public_hex(), "phone", 1);
    let inner = sign_inner(
        &device,
        json!({ "v": 2, "t": "key", "dlg": dlg }).to_string(),
        1,
    );
    let outer = seal_to_device(&inner, &receiver.public_hex(), 1).unwrap();
    assert_eq!(
        open_inbox(&outer, &receiver).unwrap().sender,
        identity.public_hex()
    );
    assert!(open_inbox(&outer, &Secret::generate()).is_none());
    let secret = "0123456789abcdef0123456789abcdef";
    let outer = seal_to_secret(&inner, secret, 1).unwrap();
    assert_eq!(open_pairing(&outer, secret).unwrap().inner.id, inner.id);
}

#[test]
fn grants() {
    let v = load("direct");
    for c in arr(&v["grants"]) {
        assert_eq!(
            parse_key_grant(&c["grant"]).is_some(),
            c["valid"].as_bool().unwrap(),
            "{}",
            c["grant"]
        );
    }
    let m = membership_of(&v["membership"]);
    for c in arr(&v["grantRoles"]) {
        assert_eq!(
            grant_role(&m, s(&c["sender"]), s(&c["me"])).map(Role::as_str),
            c["role"].as_str(),
            "{c}"
        );
    }
}

#[test]
fn portable_ops() {
    let v = load("direct");
    for c in arr(&v["portableOps"]) {
        let name = s(&c["name"]);
        let got = portable_op(s(&v["space"]), s(&c["json"]));
        let want = &c["result"];
        assert_eq!(got.is_some(), !want.is_null(), "{name}");
        if let Some(o) = got {
            assert_eq!(o.id, s(&want["id"]), "{name}");
            assert_eq!(o.device, s(&want["device"]), "{name}");
            assert_eq!(o.identity, s(&want["identity"]), "{name}");
            assert_eq!(o.seq, want["seq"].as_u64().unwrap(), "{name}");
            assert!(o.record().is_some(), "{name}");
        }
    }
}

#[test]
fn key_packages() {
    for c in arr(&load("direct")["keyPackages"]) {
        let ev = Event::from_value(&c["event"]).unwrap();
        let got: Vec<String> = parse_key_package(&ev).into_iter().map(|(d, _)| d).collect();
        let want: Vec<String> = arr(&c["devices"]).iter().map(|d| s(d).into()).collect();
        assert_eq!(got, want, "{}", s(&c["name"]));
    }
    // Round trip.
    let identity = Secret::generate();
    let dev = Secret::generate().public_hex();
    let kp = anodb_protocol::direct::create_key_package(
        &identity,
        &[create_delegation(&identity, &dev, "x", 1)],
        1,
    );
    assert_eq!(parse_key_package(&kp)[0].0, dev);
}

fn messages(v: &Value) -> Vec<SnapshotMessage> {
    arr(v)
        .iter()
        .map(|m| {
            let p = StreamPayload::parse(s(&m["payload"])).unwrap();
            SnapshotMessage::from_payload(s(&m["device"]), s(&m["identity"]), &p).unwrap()
        })
        .collect()
}

fn cells(v: &Value) -> Vec<Value> {
    arr(v).clone()
}

#[test]
fn snapshots() {
    let v = load("snapshots");
    let admin = s(&load("direct")["membership"][1]["op"]["identity"]).to_owned();
    let rules: HashMap<&str, TableRule> = [
        ("plain", TableRule::Plain),
        ("mine", TableRule::Owned),
        ("booked", TableRule::Confirmed { authority: admin }),
    ]
    .into();
    let memberships: HashMap<&str, Membership> = v["memberships"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, recs)| (k.as_str(), membership_of(recs)))
        .collect();
    let mut assembled = HashMap::new();
    for c in arr(&v["cases"]) {
        let name = s(&c["name"]);
        let got = assemble_snapshots(&messages(&c["messages"]));
        let want = arr(&c["assembled"]);
        assert_eq!(got.len(), want.len(), "{name}");
        for (g, w) in got.iter().zip(want) {
            assert_eq!(g.device, s(&w["device"]), "{name}");
            assert_eq!(g.author, s(&w["author"]), "{name}");
            assert_eq!(g.last, w["last"].as_u64().unwrap(), "{name}");
            let gc: Vec<Value> = g.cells.iter().map(Change::to_value).collect();
            assert_eq!(gc, cells(&w["cells"]), "{name}: cells");
            let wh: BTreeMap<String, i64> = w["heads"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_i64().unwrap()))
                .collect();
            assert_eq!(g.heads, wh, "{name}: heads");
        }
        assembled.insert(name, got);
    }
    for t in arr(&v["trust"]) {
        let m = &memberships[s(&t["membership"])];
        let snap = match t.get("message") {
            Some(msg) => assemble_snapshots(&messages(&json!([msg])))[0].clone(),
            None => assembled[s(&t["snapshot"])][t["index"].as_u64().unwrap() as usize].clone(),
        };
        let trusted = snapshot_trusted(m, s(&t["me"]), &snap);
        assert_eq!(trusted, t["trusted"].as_bool().unwrap(), "{t}");
        if trusted {
            let got: Vec<Value> = snapshot_changes(&snap, |tb| rules.get(tb), m)
                .iter()
                .map(Change::to_value)
                .collect();
            assert_eq!(got, cells(&t["changes"]), "{}", s(&t["snapshot"]));
        }
    }
    let tomb: Vec<Change> = arr(&v["tombstones"]["cells"])
        .iter()
        .map(|c| Change::parse(c).unwrap())
        .collect();
    let got: Vec<Value> = snapshot_cells(&tomb).iter().map(Change::to_value).collect();
    assert_eq!(got, cells(&v["tombstones"]["result"]));
}

#[test]
fn snapshot_confirmed_tables() {
    // Also covered by snapshots.json (table "booked"); this checks the rule in isolation.
    let server = "a".repeat(64);
    let rule = TableRule::Confirmed {
        authority: server.clone(),
    };
    let snap = |author: &str| anodb_protocol::snapshot::Snapshot {
        device: "d".into(),
        author: author.into(),
        last: 1,
        cells: vec![Change {
            table: "bookings".into(),
            row_id: "slot1".into(),
            column: "status".into(),
            value: json!("taken"),
            hlc: "000000000100000-aaaaaaaaaaaaaaaa".into(),
            by: None,
        }],
        heads: BTreeMap::new(),
    };
    let m = Membership::default();
    assert_eq!(
        snapshot_changes(&snap(&server), |_| Some(&rule), &m).len(),
        1
    );
    assert_eq!(
        snapshot_changes(&snap(&"b".repeat(64)), |_| Some(&rule), &m).len(),
        0
    );
}
