# anoDB wire protocol — version 2 (draft)

Status: **draft**. Kind numbers and the tag name are provisional until checked against the NIP
registry. Implementations MUST drop anything they cannot validate. Version 1 (anoDB 0.1) is
obsolete and not supported.

## 1. Keys

| key | holder | used for |
|---|---|---|
| **identity** (secp256k1) | the user (key store, recovery key, or a NIP-07/46/55 signer) | delegations, revocations, key packages, public Nostr events |
| **device** (secp256k1) | one installation | signing every inner message |
| **epoch key** (32 random bytes) | every active device of every member of a space | encrypting a space stream for one epoch |

### 1.1 Delegation (kind 7304)

```jsonc
{ "kind": 7304, "pubkey": "<identity>", "tags": [["device", "<device pubkey>"]], "content": "{\"name\":\"phone\"}" }
```

A revocation is the same kind with `["revoke", "<device pubkey>"]`. Delegations are not published
on their own; they travel inside encrypted messages (and in key packages, §6).

## 2. Envelope (kind 7303)

```jsonc
{
  "kind": 7303,
  "pubkey": "<throwaway key>",        // device key if metadataProtection = 'none'
  "created_at": <unix seconds>,
  "tags": [["n", "<routing tag>"]],
  "content": "<NIP-44 v2 ciphertext of the inner message JSON>"
}
```

| routing | tag | NIP-44 conversation key |
|---|---|---|
| space stream | `hex(sha256("anodb/v2/space/" + hex(epochKey)))[0:32]` | the epoch key itself |
| device inbox | `hex(sha256("anodb/v2/inbox/" + devicePubkey))[0:32]` | ECDH(envelope key, device key) |
| invite / pairing secret | `hex(sha256("anodb/v2/secret-tag/" + secret))[0:32]` | `sha256("anodb/v2/secret-key/" + secret)` |

`keyId(epochKey) = hex(sha256("anodb/v2/key-id/" + hex(epochKey)))[0:16]`.

Relays therefore see only: a random pubkey, a tag that changes every epoch, time and size.

## 3. Inner message (kind 7305)

A NIP-01 event signed by the **device** key, never published unencrypted. `content` is the payload:

```jsonc
{ "v": 2, "t": "<type>", "sp": "<space id, 32 hex>", "ep": "<keyId>", "seq": <n>, "dlg": <delegation event>, ...body }
```

- `seq` starts at 1 and increases by one per (space, device). Gaps reveal missing messages.
- A receiver MUST check: inner signature; `dlg` delegates to the inner pubkey; `sp`/`ep` match
  the key that decrypted the envelope; payload shape.

| `t` | body | meaning |
|---|---|---|
| `ch` | `c: [[table, rowId, column, value, hlc], …]` | cell changes |
| `op` | `op: {…}, par: [msgId…]` | membership operation (§5) |
| `snap` | `sid, i, n, body` | part `i` of `n` of a snapshot |

## 4. Cells and merge

State is `(space, table, rowId, column) → (value, hlc)`; a change wins iff its HLC is greater.
`hlc = base36(ms, 10) + base36(counter, 5) + "-" + nodeId(16 hex)`; string order = causal order.
System columns: `$deleted` (`true` = tombstone), `$createdAt` (ms). Changes are applied only if the
signing identity is authorized (§5) for that device and sequence number; unauthorized messages are
kept and re-evaluated whenever membership changes.

## 5. Spaces and membership

Every row belongs to a space. A user's personal data is a space whose only member is the user.
The first message of a space is an `op` with `{ "type": "create", "owner": <identity>, "name": … }`
signed by a device of that owner.

(Roles, invitations, removal cut-offs and key rotation: added in protocol revisions for anoDB 0.3.)

## 6. Sync (informative)

Subscribe per relay to `{"kinds":[7303], "#n":[tags…], "since": cursor − 600}`; after `EOSE`
page backwards with `until` until nothing new arrives; then advance per-(relay, tag) cursors.
Envelopes are retried until `minAcks` relays acknowledge them; envelopes older than 300 s are
re-signed with a fresh `created_at` (and a new throwaway key) before resending.
