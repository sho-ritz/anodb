# anoDB protocol conformance vectors

`v2/*.json` pins the behaviour of the anoDB wire protocol v2 (`PROTOCOL.md`). Every
implementation — the TypeScript reference (`src/`), the Rust core (`crates/anodb-protocol`) and
anything built later — must reproduce them, so they all interoperate.

| file | covers |
|---|---|
| `keys.json` | secret → x-only pubkey, `nsec` / `npub` |
| `derivations.json` | space / inbox / pairing tags, key ids, space ids |
| `nip44.json` | NIP-44 v2 conversation keys, encryption with a fixed nonce |
| `events.json` | NIP-01 id + Schnorr verification (escaping, tampering) |
| `delegations.json` | identity → device delegations |
| `envelopes.json` | opening a space-stream envelope: every check, in order, with its error code |
| `payloads.json` | structural validation of inner payloads and changes |
| `hlc.json` | HLC encoding and `tick` / `receive` with a controlled clock |
| `merge.json` | last-writer-wins per cell |
| `policy.json` | the row rule for plain, owned and unknown tables |
| `membership.json` | op shapes, and membership evaluation (§5.1): DAG order, missing parents and cycles, who may add / change / remove / leave / transfer / revoke, removals overriding concurrent ops, cut-offs, `mayWrite` / `mayManage` |
| `direct.json` | envelopes to one device's inbox and to a pairing secret (§5.3, §5.5), key-grant shapes, who may grant keys, portable signed ops, pairing codes, key packages (§5.6) |
| `snapshots.json` | assembling multi-part snapshots, when a snapshot is trusted (role, own identity, cut-offs), which of its cells merge (row rule for named signers), tombstone pruning (§5.4) |

The TypeScript side of `direct.json` and `snapshots.json` comes from the pure functions in
`src/sharing.ts` (`openDirect`, `parseKeyGrant`, `grantRole`, `portableOp`, `assembleSnapshots`,
`snapshotTrusted`, `snapshotChanges`, `snapshotCells`, `pairingCode`), which the sharing class itself
uses.

```sh
npm run build && node conformance/generate.mjs        # regenerate from the TypeScript implementation
cargo test -p anodb-protocol                           # Rust reproduces them
cargo run -q -p anodb-protocol --example interop | node conformance/check-rust.mjs   # TS opens Rust output
```

The generator derives keys, Schnorr auxiliary data and NIP-44 nonces from fixed seeds, so its output
is byte-for-byte stable; CI regenerates it and fails if the checked-in files differ.

## Where the implementation and PROTOCOL.md disagree

The vectors follow the TypeScript implementation (that is what deployed apps do). Disagreements
with the text of PROTOCOL.md are listed here until they are settled.

None at the moment. Settled so far:

1. **Tables the schema does not know** are plain, as implemented; PROTOCOL.md §4.1 was changed to
   match (docs/DECISIONS.md row 35). See `policy.json`, table `unknown`.
2. **Snapshot cells and key grants** are validated the same way on both sides (a snapshot cell is a
   valid change plus an optional hex signer; a grant needs a safe-integer `num` ≥ 0 and a string or
   absent `name`).
