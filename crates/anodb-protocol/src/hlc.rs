//! Hybrid logical clock. Fixed-width string so that string order equals causal-then-node order:
//! `<millis base36, 10><counter base36, 5>-<node id hex, 16>` (PROTOCOL.md §4).

use crate::Error;

const MILLIS_W: usize = 10;
const COUNTER_W: usize = 5;
pub const MAX_COUNTER: u64 = 36u64.pow(COUNTER_W as u32) - 1;
const MAX_MILLIS: u64 = 36u64.pow(MILLIS_W as u32) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Timestamp {
    pub millis: u64,
    pub counter: u64,
    pub node: String,
}

fn base36(mut n: u64, width: usize) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = vec![b'0'; width];
    for slot in out.iter_mut().rev() {
        *slot = digits[(n % 36) as usize];
        n /= 36;
    }
    String::from_utf8(out).expect("ascii")
}

pub fn is_node_id(s: &str) -> bool {
    crate::keys::is_lower_hex(s, 16)
}

/// `^[0-9a-z]{15}-[0-9a-f]{16}$`
pub fn is_hlc(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 32
        && b[..15]
            .iter()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        && b[15] == b'-'
        && is_node_id(&s[16..])
}

pub fn encode(t: &Timestamp) -> String {
    format!(
        "{}{}-{}",
        base36(t.millis.min(MAX_MILLIS), MILLIS_W),
        base36(t.counter.min(MAX_COUNTER), COUNTER_W),
        t.node
    )
}

pub fn decode(s: &str) -> Result<Timestamp, Error> {
    if !is_hlc(s) {
        return Err(Error::Invalid(format!("invalid HLC \"{s}\"")));
    }
    Ok(Timestamp {
        millis: u64::from_str_radix(&s[..MILLIS_W], 36).expect("checked"),
        counter: u64::from_str_radix(&s[MILLIS_W..MILLIS_W + COUNTER_W], 36).expect("checked"),
        node: s[MILLIS_W + COUNTER_W + 1..].to_owned(),
    })
}

/// The clock of one node. `now` returns wall-clock milliseconds.
pub struct Clock<F: Fn() -> u64> {
    millis: u64,
    counter: u64,
    node: String,
    now: F,
}

impl<F: Fn() -> u64> Clock<F> {
    pub fn new(node: &str, last: Option<&str>, now: F) -> Result<Self, Error> {
        if !is_node_id(node) {
            return Err(Error::Invalid(
                "nodeId must be 16 lowercase hex chars".into(),
            ));
        }
        let mut c = Self {
            millis: 0,
            counter: 0,
            node: node.to_owned(),
            now,
        };
        if let Some(l) = last {
            c.receive(l)?;
        }
        Ok(c)
    }

    /// Timestamp for a local event.
    pub fn tick(&mut self) -> String {
        let wall = (self.now)();
        if wall > self.millis {
            self.millis = wall;
            self.counter = 0;
        } else if self.counter >= MAX_COUNTER {
            self.millis += 1;
            self.counter = 0;
        } else {
            self.counter += 1;
        }
        self.current()
    }

    /// Merge a remote timestamp so later local writes sort after it.
    pub fn receive(&mut self, remote: &str) -> Result<(), Error> {
        let r = decode(remote)?;
        let wall = (self.now)();
        if wall > self.millis && wall > r.millis {
            self.millis = wall;
            self.counter = 0;
        } else if r.millis > self.millis {
            self.millis = r.millis;
            self.counter = r.counter;
        } else if r.millis == self.millis {
            self.counter = self.counter.max(r.counter);
        }
        Ok(())
    }

    pub fn current(&self) -> String {
        encode(&Timestamp {
            millis: self.millis,
            counter: self.counter,
            node: self.node.clone(),
        })
    }
}
