# anoDB wire protocol — version 1 (draft)

Status: **draft / provisional**. Kind number and tag name are placeholders until checked against
the NIP registry. Implementations MUST ignore events they cannot validate.

## 1. Identities

- **Owner**: a secp256k1 key pair (Nostr key). All data of one owner is signed by the owner key.
- **Node**: one installation of the database. Has a random 8-byte `nodeId` (16 lowercase hex chars).
- **appId**: application namespace string chosen by the developer.

## 2. Change event

A regular (stored, non-replaceable) Nostr event:

```jsonc
{
  "kind": 7303,
  "pubkey": "<owner pubkey>",
  "created_at": <unix seconds>,
  "tags": [["n", "<namespace>"]],
  "content": "<NIP-44 v2 payload>",
  // id, sig per NIP-01
}
```

- `namespace = lowercase_hex(sha256(utf8("anodb/v1/" + appId + "/" + pubkey)))[0:32]`
- `content = nip44_v2_encrypt(plaintext, conversation_key(owner_secret, owner_pubkey))`
  (the owner encrypts to themself; every device holding the owner secret can decrypt).
- Plaintext MUST be ≤ 48 KiB (implementations split larger transactions into several events).

### 2.1 Plaintext

```jsonc
{ "v": 1, "changes": [[table, rowId, column, value, hlc], ...] }
```

| field | type | rule |
|---|---|---|
| `table` | string | `^[A-Za-z][A-Za-z0-9_]*$` |
| `rowId` | string | 1–128 chars |
| `column` | string | `^\$?[A-Za-z][A-Za-z0-9_]*$`; names starting with `$` are system columns |
| `value` | any JSON | |
| `hlc` | string | see §3 |

System columns:

| column | value | meaning |
|---|---|---|
| `$deleted` | `true` | row is deleted (tombstone) |
| `$createdAt` | number (ms) | creation time, written once on insert |

A payload with `v` other than `1` MUST NOT be applied and SHOULD NOT be marked as processed.

## 3. Hybrid logical clock

`hlc = base36(millis).padStart(10,"0") + base36(counter).padStart(5,"0") + "-" + nodeId`

Plain string comparison orders timestamps. Every change produced by a node MUST have a strictly
greater HLC than any change the node produced or applied before.

## 4. Merge rule

State is a map `(table, rowId, column) → (value, hlc)`. On receiving a change:

```
if no entry or change.hlc > entry.hlc: entry = (change.value, change.hlc)
```

Equal HLCs are duplicates. The rule is commutative, associative and idempotent, so events may be
received in any order, any number of times, from any relay.

A row is visible iff it has at least one cell and `$deleted` is not `true`.

## 5. Validation on receipt

A client MUST drop an event unless all of the following hold:

1. `kind == 7303`, `pubkey == owner`, a tag `["n", namespace]` is present;
2. the NIP-01 id and Schnorr signature are valid;
3. the content decrypts with the owner conversation key;
4. the plaintext matches §2.1.

## 6. Sync procedure (informative)

- Subscribe: `{"kinds":[7303],"authors":[owner],"#n":[namespace],"since":cursor-600}` per relay.
- After `EOSE`, page backwards with `until` = oldest received `created_at` until a page returns no
  new events; then set the relay cursor to the newest `created_at` seen.
- Publish to all relays, retry until `minAcks` relays answered `OK true` (or `duplicate:`).
- Events waiting in the outbox longer than 300 s SHOULD be re-signed with a fresh `created_at`
  (same content) before resending, so that `since` cursors of other devices include them.

## 7. Public data

anoDB reads and writes standard events unchanged: kind 0 (NIP-01 metadata), kind 1 (text note),
kind 10002 (NIP-65 relay list). They are cached locally with replaceable-event semantics
(highest `created_at`, ties broken by lowest `id`).
