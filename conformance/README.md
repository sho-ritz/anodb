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
