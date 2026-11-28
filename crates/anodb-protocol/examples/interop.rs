//! Prints envelopes sealed by the Rust core, for `conformance/check-rust.mjs` to open with the
//! TypeScript implementation:  cargo run -q --example interop | node conformance/check-rust.mjs
use anodb_protocol::derive::{inbox_tag, space_id};
use anodb_protocol::identity::create_delegation;
use anodb_protocol::{EpochKey, Secret, nip44, seal, seal_space, sign_inner};
use serde_json::json;

fn main() {
    let identity = Secret::generate();
    let device = Secret::generate();
    let dlg = create_delegation(&identity, &device.public_hex(), "rust", 1_790_000_000);
    let space = space_id(&identity.public_hex(), "rust-nonce");
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).unwrap();
    let ek = EpochKey::new(&space, key);
    let row = format!("{}-row1", identity.public_hex());
    let hlc = "0000000001aaaa0-0123456789abcdef";
    let payload = json!({ "v": 2, "t": "ch", "sp": space, "ep": ek.key_id, "seq": 1, "dlg": dlg,
        "c": [["todo", row, "title", "日本語 \"quoted\"\n", hlc], ["todo", row, "$createdAt", 1790000000000u64, hlc]] });
    let inner = sign_inner(&device, payload.to_string(), 1_790_000_000);
    let outer = seal_space(&inner, &ek, 1_790_000_000).unwrap();
    // An inbox envelope: pairwise NIP-44 between a throwaway key and the receiving device.
    let receiver = Secret::generate();
    let eph = Secret::generate();
    let ck = nip44::conversation_key(&eph, &receiver.public_hex()).unwrap();
    let inbox_inner = sign_inner(
        &device,
        json!({ "v": 2, "t": "hello", "dlg": dlg }).to_string(),
        1_790_000_000,
    );
    let inbox = seal(
        &inbox_inner.to_json(),
        &inbox_tag(&receiver.public_hex()),
        &ck,
        &eph,
        1_790_000_000,
    )
    .unwrap();
    println!(
        "{}",
        json!({
            "space": { "epochKey": hex::encode(key), "space": space, "outer": outer, "identity": identity.public_hex(), "device": device.public_hex() },
            "inbox": { "receiverSecret": receiver.to_hex(), "outer": inbox },
        })
    );
}
