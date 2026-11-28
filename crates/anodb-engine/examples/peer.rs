//! A Rust anoDB device driven by JSON lines on stdin (one reply line per command on stdout).
//! Used by the TypeScript interop test (test/rust-interop.test.ts).
//!
//!   {"cmd":"hello"}                                  → {"pubkey","device","delegation","personal"}
//!   {"cmd":"sync","relay":"ws://…"}                  → {"received","new","published","rejected"}
//!   {"cmd":"invitations"}                            → [{"space","name","role","from"}]
//!   {"cmd":"accept","space":"…"}
//!   {"cmd":"create_space","name":"…"}               → "<space id>"
//!   {"cmd":"add_member","space","identity","role","delegations":[…]}
//!   {"cmd":"insert","space":"…","table":"todo","values":{…}} → "<row id>"
//!   {"cmd":"titles","space":"…"}                     → ["…"] (todo titles, sorted)

use std::io::{BufRead, Write};
use std::time::Duration;

use anodb_engine::relay::sync_once;
use anodb_engine::{ColumnType, Engine, Options, Schema, TableDef};
use anodb_protocol::{Event, Role};
use serde_json::{Value, json};

fn run(e: &mut Engine, c: &Value) -> Result<Value, String> {
    let s = |k: &str| {
        c.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let err = |x: anodb_engine::EngineError| x.to_string();
    Ok(match s("cmd").as_str() {
        "hello" => json!({
            "pubkey": e.pubkey(), "device": e.device_pubkey(),
            "delegation": e.delegation(), "personal": e.personal_space(),
        }),
        "sync" => {
            let r = sync_once(e, &s("relay"), Duration::from_secs(10)).map_err(err)?;
            json!({ "received": r.received, "new": r.new, "published": r.published, "rejected": r.rejected })
        }
        "invitations" => Value::Array(
            e.invitations()
                .map_err(err)?
                .into_iter()
                .map(|i| json!({ "space": i.space, "name": i.name, "role": i.role.as_str(), "from": i.from }))
                .collect(),
        ),
        "accept" => {
            e.accept_invitation(&s("space")).map_err(err)?;
            Value::Null
        }
        "create_space" => json!(e.create_space(&s("name")).map_err(err)?),
        "add_member" => {
            let role = Role::parse(&s("role")).ok_or("bad role")?;
            let dl: Vec<Event> = c
                .get("delegations")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Event::from_value).collect())
                .unwrap_or_default();
            e.add_member(&s("space"), &s("identity"), role, &dl).map_err(err)?;
            Value::Null
        }
        "insert" => {
            let values = c.get("values").and_then(Value::as_object).cloned().unwrap_or_default();
            json!(e.insert(Some(&s("space")), &s("table"), &values).map_err(err)?)
        }
        "titles" => {
            let rows = e
                .query(
                    "SELECT title FROM todo WHERE space = ? ORDER BY title",
                    &[s("space").into()],
                )
                .map_err(err)?;
            Value::Array(rows.into_iter().map(|r| r["title"].clone()).collect())
        }
        other => return Err(format!("unknown command {other}")),
    })
}

fn main() {
    let schema = Schema::new()
        .table(
            "todo",
            TableDef::new(&[("title", ColumnType::Text), ("done", ColumnType::Boolean)]),
        )
        .expect("schema");
    let path = std::env::args().nth(1).unwrap_or_else(|| ":memory:".into());
    let mut e = Engine::open(Options::new(&path, schema)).expect("open");
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(c) => match run(&mut e, &c) {
                Ok(v) => json!({ "ok": v }),
                Err(m) => json!({ "error": m }),
            },
            Err(x) => json!({ "error": x.to_string() }),
        };
        writeln!(out, "{reply}").expect("stdout");
        out.flush().expect("stdout");
    }
}
