# anodb-protocol

The anoDB wire protocol v2 in Rust: keys and delegations, NIP-44 envelopes, inner message
validation, hybrid logical clocks, last-writer-wins merge, the row rule, membership evaluation,
direct messages and key grants, and snapshot assembly and trust. Pure functions, no I/O.

This is the first layer of the Rust core that every anoDB SDK (Swift, Kotlin, Go, npm, …) will
share. It reproduces the conformance vectors in [`conformance/v2`](../../conformance), which are
generated from the TypeScript implementation, and the TypeScript implementation opens what it
seals (`examples/interop.rs`).

```sh
cargo test -p anodb-protocol
```
