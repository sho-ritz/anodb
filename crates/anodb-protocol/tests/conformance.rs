//! Protocol v2 conformance: reproduce every vector generated from the TypeScript implementation.

use std::cell::Cell;
use std::collections::HashMap;
use std::path::PathBuf;

use anodb_protocol::derive::{inbox_tag, key_id, secret_key_for, secret_tag, space_id, space_tag};
use anodb_protocol::hlc::{self, Clock, Timestamp};
use anodb_protocol::identity::verify_delegation;
use anodb_protocol::merge::Cells;
use anodb_protocol::nip44;
use anodb_protocol::policy::{Role, TableRule, change_allowed};
use anodb_protocol::{
    Change, EpochKey, Event, Membership, OpRecord, Secret, StreamPayload, evaluate, npub,
    open_space, parse_op, parse_pubkey,
};
use serde_json::Value;

fn load(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/v2")
        .join(format!("{name}.json"));
    serde_json::from_str(
        &std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
    )
    .unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn key32(v: &Value) -> [u8; 32] {
    hex::decode(s(v)).unwrap().try_into().unwrap()
}

fn cases(v: &Value) -> &Vec<Value> {
    v["cases"].as_array().unwrap()
}

#[test]
fn keys() {
    for c in cases(&load("keys")) {
        let sk = Secret::parse(s(&c["secret"])).unwrap();
        assert_eq!(sk.public_hex(), s(&c["pubkey"]));
        assert_eq!(sk.nsec(), s(&c["nsec"]));
        assert_eq!(npub(s(&c["pubkey"])).unwrap(), s(&c["npub"]));
        assert_eq!(
            Secret::parse(s(&c["nsec"])).unwrap().to_hex(),
            s(&c["secret"])
        );
        assert_eq!(
            Secret::parse(&s(&c["secret"]).to_uppercase())
                .unwrap()
                .to_hex(),
            s(&c["secret"])
        );
        assert_eq!(parse_pubkey(s(&c["npub"])).unwrap(), s(&c["pubkey"]));
    }
}

#[test]
fn derivations() {
    let v = load("derivations");
    for c in v["epoch"].as_array().unwrap() {
        let k = key32(&c["epochKey"]);
        assert_eq!(space_tag(&k), s(&c["spaceTag"]));
        assert_eq!(key_id(&k), s(&c["keyId"]));
    }
    for c in v["inbox"].as_array().unwrap() {
        assert_eq!(inbox_tag(s(&c["devicePubkey"])), s(&c["inboxTag"]));
    }
    for c in v["secret"].as_array().unwrap() {
        assert_eq!(secret_tag(s(&c["secret"])), s(&c["secretTag"]));
        assert_eq!(
            hex::encode(secret_key_for(s(&c["secret"]))),
            s(&c["secretKey"])
        );
    }
    for c in v["spaceId"].as_array().unwrap() {
        assert_eq!(space_id(s(&c["owner"]), s(&c["nonce"])), s(&c["spaceId"]));
    }
}

#[test]
fn nip44_vectors() {
    let v = load("nip44");
    for c in v["conversationKeys"].as_array().unwrap() {
        let sk = Secret::parse(s(&c["secret"])).unwrap();
        assert_eq!(
            hex::encode(nip44::conversation_key(&sk, s(&c["pubkey"])).unwrap()),
            s(&c["conversationKey"])
        );
    }
    for c in v["encrypt"].as_array().unwrap() {
        let ck = key32(&c["conversationKey"]);
        let payload =
            nip44::encrypt_with_nonce(s(&c["plaintext"]), &ck, key32(&c["nonce"])).unwrap();
        assert_eq!(payload, s(&c["payload"]));
        assert_eq!(
            nip44::decrypt(s(&c["payload"]), &ck).unwrap(),
            s(&c["plaintext"])
        );
        // And our own random-nonce output decrypts.
        assert_eq!(
            nip44::decrypt(&nip44::encrypt(s(&c["plaintext"]), &ck).unwrap(), &ck).unwrap(),
            s(&c["plaintext"])
        );
    }
}

#[test]
fn events() {
    for c in cases(&load("events")) {
        let e = Event::from_value(&c["event"]).unwrap();
        assert_eq!(
            e.verify(),
            c["valid"].as_bool().unwrap(),
            "{}",
            s(&c["name"])
        );
    }
    // Round trip: what we sign, they verify (and so do we).
    let sk = Secret::generate();
    let e = Event::sign(
        &sk,
        anodb_protocol::Template {
            kind: 1,
            created_at: 1,
            tags: vec![vec!["t".into(), "ü\n\u{1}".into()]],
            content: "\"x\"\t🎉".into(),
        },
    );
    assert!(e.verify());
}

#[test]
fn delegations() {
    for c in cases(&load("delegations")) {
        let e = Event::from_value(&c["event"]).unwrap();
        assert_eq!(
            verify_delegation(&e, s(&c["device"])).as_deref(),
            c["identity"].as_str(),
            "{}",
            s(&c["name"])
        );
    }
}

#[test]
fn envelopes() {
    let v = load("envelopes");
    let k = &v["key"];
    let ek = EpochKey::new(s(&k["space"]), key32(&k["epochKey"]));
    assert_eq!(ek.key_id, s(&k["keyId"]));
    assert_eq!(ek.tag, s(&k["tag"]));
    let keys: HashMap<String, EpochKey> = [(ek.tag.clone(), ek)].into();
    for c in cases(&v) {
        let name = s(&c["name"]);
        let outer = Event::from_value(&c["outer"]).unwrap();
        let r = open_space(&outer, |t| keys.get(t));
        match s(&c["result"]) {
            "ok" => {
                let o = r.unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(o.device, s(&c["device"]), "{name}");
                assert_eq!(o.identity, s(&c["identity"]), "{name}");
                assert_eq!(o.payload.seq, c["seq"].as_u64().unwrap(), "{name}");
                assert_eq!(o.payload.type_name(), s(&c["type"]), "{name}");
                assert_eq!(o.msg_id, s(&c["msgId"]), "{name}");
            }
            expected => assert_eq!(r.err().map(|e| e.code()), Some(expected), "{name}"),
        }
    }
}

#[test]
fn payloads() {
    let v = load("payloads");
    for c in cases(&v) {
        assert_eq!(
            StreamPayload::parse(s(&c["json"])).is_some(),
            c["valid"].as_bool().unwrap(),
            "{}",
            s(&c["name"])
        );
    }
    for c in v["changes"].as_array().unwrap() {
        assert_eq!(
            Change::parse(&c["change"]).is_some(),
            c["valid"].as_bool().unwrap(),
            "{}",
            c["change"]
        );
    }
}

#[test]
fn hlc_vectors() {
    let v = load("hlc");
    for c in v["encode"].as_array().unwrap() {
        let t = Timestamp {
            millis: c["millis"].as_u64().unwrap(),
            counter: c["counter"].as_u64().unwrap(),
            node: s(&c["node"]).into(),
        };
        assert_eq!(hlc::encode(&t), s(&c["hlc"]));
        assert_eq!(hlc::decode(s(&c["hlc"])).unwrap(), t);
    }
    for c in v["invalid"].as_array().unwrap() {
        assert_eq!(
            hlc::decode(s(&c["hlc"])).is_ok(),
            c["valid"].as_bool().unwrap(),
            "{}",
            c["hlc"]
        );
    }
    let wall = Cell::new(1000u64);
    let mut clock = Clock::new(s(&v["clock"]["node"]), None, || wall.get()).unwrap();
    for st in v["clock"]["steps"].as_array().unwrap() {
        wall.set(st["wall"].as_u64().unwrap());
        let got = match s(&st["op"]) {
            "tick" => clock.tick(),
            "receive" => {
                clock.receive(s(&st["remote"])).unwrap();
                clock.current()
            }
            op => panic!("unknown op {op}"),
        };
        assert_eq!(got, s(&st["result"]), "{st}");
    }
    let o = &v["counterOverflow"];
    let w = o["wall"].as_u64().unwrap();
    let mut maxed = Clock::new(s(&o["node"]), Some(s(&o["start"])), move || w).unwrap();
    assert_eq!(maxed.tick(), s(&o["tick"]));
}

#[test]
fn merge() {
    for c in cases(&load("merge")) {
        let changes: Vec<Change> = c["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| Change::parse(x).unwrap())
            .collect();
        let mut cells = Cells::default();
        cells.apply(&changes);
        let got: Vec<Value> = cells.0.values().map(Change::to_value).collect();
        assert_eq!(Value::Array(got), c["result"], "{}", s(&c["name"]));
        // Any order gives the same state (unless HLCs are equal, where the first one stays).
        let mut rev = Cells::default();
        rev.apply(changes.iter().rev());
        if s(&c["name"]) != "equal hlc keeps first" {
            assert_eq!(rev.0, cells.0, "{} (reversed)", s(&c["name"]));
        }
    }
}

#[test]
fn policy() {
    let v = load("policy");
    let rules: HashMap<&str, TableRule> = [
        ("plain", TableRule::Plain),
        ("mine", TableRule::Owned),
        (
            "booked",
            TableRule::Confirmed {
                authority: s(&v["other"]).into(),
            },
        ),
    ]
    .into();
    for c in cases(&v) {
        let change = Change {
            table: s(&c["table"]).into(),
            row_id: s(&c["rowId"]).into(),
            column: s(&c["column"]).into(),
            value: Value::Null,
            hlc: "000000000100000-aaaaaaaaaaaaaaaa".into(),
            by: None,
        };
        let role = c["role"].as_str().map(|r| Role::parse(r).unwrap());
        assert_eq!(
            change_allowed(rules.get(s(&c["table"])), &change, s(&c["writer"]), role),
            c["allowed"].as_bool().unwrap(),
            "{c}"
        );
    }
}

#[test]
fn membership_ops() {
    for c in load("membership")["ops"].as_array().unwrap() {
        assert_eq!(
            parse_op(&c["op"]).is_some(),
            c["valid"].as_bool().unwrap(),
            "{}",
            c["op"]
        );
    }
}

#[test]
fn membership() {
    let v = load("membership");
    let devices: HashMap<String, String> = v["devices"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(d, i)| (d.clone(), s(i).to_owned()))
        .collect();
    let ids = |v: &Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| s(x).to_owned())
            .collect()
    };
    for c in cases(&v) {
        let name = s(&c["name"]);
        let records: Vec<OpRecord> = c["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| {
                Some(OpRecord {
                    id: s(&r["id"]).into(),
                    identity: s(&r["identity"]).into(),
                    op: parse_op(&r["op"])?,
                    par: ids(&r["par"]),
                })
            })
            .collect();
        let check = |m: &Membership, how: &str| {
            let res = &c["result"];
            assert_eq!(
                m.owner.as_deref(),
                res["owner"].as_str(),
                "{name}{how}: owner"
            );
            let roles: HashMap<&str, &str> = m
                .roles
                .iter()
                .map(|(k, r)| (k.as_str(), r.as_str()))
                .collect();
            let want: HashMap<&str, &str> = res["roles"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, r)| (k.as_str(), s(r)))
                .collect();
            assert_eq!(roles, want, "{name}{how}: roles");
            let cut: Vec<(String, u64)> = m.cut.iter().map(|(k, v)| (k.clone(), *v)).collect();
            let want: Vec<(String, u64)> = res["cut"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_u64().unwrap()))
                .collect();
            assert_eq!(cut, want, "{name}{how}: cut");
            assert_eq!(
                m.ever_writer.iter().cloned().collect::<Vec<_>>(),
                ids(&res["everWriter"]),
                "{name}{how}: everWriter"
            );
            assert_eq!(
                m.revoked_devices.iter().cloned().collect::<Vec<_>>(),
                ids(&res["revokedDevices"]),
                "{name}{how}: revokedDevices"
            );
            assert_eq!(m.valid, ids(&res["valid"]), "{name}{how}: valid");
            for w in c["writes"].as_array().unwrap() {
                assert_eq!(
                    m.may_write(
                        s(&w["identity"]),
                        s(&w["device"]),
                        w["seq"].as_u64().unwrap()
                    ),
                    w["mayWrite"].as_bool().unwrap(),
                    "{name}{how}: {w}"
                );
            }
            for (who, ok) in c["manage"].as_object().unwrap() {
                assert_eq!(
                    m.may_manage(who),
                    ok.as_bool().unwrap(),
                    "{name}{how}: manage"
                );
            }
        };
        let lookup = |d: &str| devices.get(d).cloned();
        check(&evaluate(s(&c["space"]), &records, lookup), "");
        // The result does not depend on the order in which ops arrived.
        let mut rev = records.clone();
        rev.reverse();
        check(&evaluate(s(&c["space"]), &rev, lookup), " (reversed)");
    }
}

#[test]
fn confirmed_tables() {
    // Also covered by policy.json (table "booked"); this checks other rows and roles directly.
    let server = "a".repeat(64);
    let other = "b".repeat(64);
    let rule = TableRule::Confirmed {
        authority: server.clone(),
    };
    let c = |row: &str, col: &str| Change {
        table: "bookings".into(),
        row_id: row.into(),
        column: col.into(),
        value: Value::Null,
        hlc: "000000000100000-aaaaaaaaaaaaaaaa".into(),
        by: None,
    };
    assert!(change_allowed(
        Some(&rule),
        &c(&format!("{other}-x"), "status"),
        &server,
        Some(Role::Writer)
    ));
    assert!(!change_allowed(
        Some(&rule),
        &c(&format!("{other}-x"), "status"),
        &other,
        Some(Role::Owner)
    ));
    assert!(!change_allowed(
        Some(&rule),
        &c("slot1", "$deleted"),
        &other,
        Some(Role::Owner)
    ));
}
