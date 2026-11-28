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

The vectors follow the TypeScript implementation (that is what deployed apps do). To be settled
before the protocol leaves draft:

1. **Tables the schema does not know.** PROTOCOL.md §4.1: "Tables unknown to an implementation
   follow the owned rule". The implementation treats them as **plain** (`changeAllowed` →
   `isOwned(undefined)` is false). See `policy.json`, table `unknown`.

## Where Rust is stricter (not covered by the vectors)

The vectors only contain inputs on which both implementations agree. On these, Rust refuses what
TypeScript lets through:

1. **Snapshot cells.** TypeScript keeps any 5-element array (`[1, 2, 3, 4, 5]` reaches the cell
   table); Rust requires a valid change (`Change::parse_cell`), as in `ch` messages.
2. **Key grants.** TypeScript does not check `num` or `name`; Rust exposes them as `None` unless they
   are a safe integer / a string, and leaves the decision to the caller.

Fixing the TypeScript side (1) is a small change to `assembleSnapshots` and would let the vectors
cover it.
