//! A small blocking NIP-01 relay client: publish the outbox, subscribe to the engine's routing tags
//! and ingest what arrives. `sync_once` runs until the relay has nothing new (EOSE) and every
//! published envelope was answered, repeating while the round itself produced new work (a key
//! that adds a tag, a reply that adds an envelope).

use std::collections::HashSet;
use std::net::TcpStream;
use std::time::{Duration, Instant};

use anodb_protocol::Event;
use anodb_protocol::payload::WRAP_KIND;
use serde_json::{Value, json};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::EngineError;
use crate::engine::Engine;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Envelopes the relay sent.
    pub received: usize,
    /// Of those, envelopes that were new to this device.
    pub new: usize,
    /// Envelopes this device published and the relay accepted.
    pub published: usize,
    /// `(event id, reason)` for envelopes the relay refused.
    pub rejected: Vec<(String, String)>,
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

fn relay_err(e: impl std::fmt::Display) -> EngineError {
    EngineError::Relay(e.to_string())
}

fn set_timeout(ws: &mut Socket, d: Duration) {
    #[allow(unreachable_patterns)]
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(Some(d));
        }
        #[cfg(feature = "tls")]
        MaybeTlsStream::Rustls(s) => {
            let _ = s.sock.set_read_timeout(Some(d));
        }
        _ => {}
    }
}

fn send(ws: &mut Socket, v: Value) -> Result<(), EngineError> {
    ws.send(Message::text(v.to_string())).map_err(relay_err)
}

/// One synchronisation round trip with one relay.
pub fn sync_once(
    engine: &mut Engine,
    url: &str,
    timeout: Duration,
) -> Result<SyncReport, EngineError> {
    let (mut ws, _) = tungstenite::connect(url).map_err(relay_err)?;
    set_timeout(&mut ws, Duration::from_millis(100));
    let deadline = Instant::now() + timeout;
    let mut report = SyncReport::default();
    let mut sent: HashSet<String> = HashSet::new();
    let mut subscribed: Vec<String> = vec![];
    let mut sub = 0u32;
    for _round in 0..16 {
        // Publish what is waiting.
        let mut waiting: HashSet<String> = HashSet::new();
        for e in engine.outbox()? {
            if sent.insert(e.id.clone()) {
                waiting.insert(e.id.clone());
                send(&mut ws, json!(["EVENT", e]))?;
            }
        }
        // (Re)subscribe when the tags changed.
        let tags = engine.subscription_tags()?;
        let mut eose = true;
        let sub_id = format!("anodb-{sub}");
        if tags != subscribed {
            if sub > 0 {
                send(&mut ws, json!(["CLOSE", format!("anodb-{}", sub - 1)]))?;
            }
            send(
                &mut ws,
                json!(["REQ", sub_id, { "kinds": [WRAP_KIND], "#n": tags }]),
            )?;
            subscribed = tags;
            sub += 1;
            eose = false;
        }
        if waiting.is_empty() && eose {
            break;
        }
        while !(eose && waiting.is_empty()) {
            if Instant::now() > deadline {
                return Err(EngineError::Relay(format!("{url}: timed out")));
            }
            let msg = match ws.read() {
                Ok(m) => m,
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue;
                }
                Err(e) => return Err(relay_err(e)),
            };
            let Message::Text(text) = msg else { continue };
            let Ok(Value::Array(a)) = serde_json::from_str::<Value>(text.as_str()) else {
                continue;
            };
            match a.first().and_then(Value::as_str) {
                Some("EVENT") if a.get(1).and_then(Value::as_str) == Some(sub_id.as_str()) => {
                    let Some(e) = a.get(2).and_then(Event::from_value) else {
                        continue;
                    };
                    report.received += 1;
                    if engine.ingest(&e)?.0 == crate::Ingest::New {
                        report.new += 1;
                    }
                }
                Some("EOSE") if a.get(1).and_then(Value::as_str) == Some(sub_id.as_str()) => {
                    eose = true
                }
                Some("OK") => {
                    let id = a
                        .get(1)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if !waiting.remove(&id) {
                        continue;
                    }
                    let ok = a.get(2).and_then(Value::as_bool).unwrap_or(false);
                    let reason = a.get(3).and_then(Value::as_str).unwrap_or_default();
                    if ok || reason.starts_with("duplicate") {
                        engine.delivered(&id)?;
                        report.published += 1;
                    } else {
                        report.rejected.push((id, reason.to_owned()));
                    }
                }
                _ => {}
            }
        }
    }
    let _ = ws.close(None);
    Ok(report)
}
