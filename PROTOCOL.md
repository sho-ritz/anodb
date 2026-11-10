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

Every row belongs to a space; a user's personal data is a space whose only member is the user.
`spaceId = hex(sha256("anodb/v2/space-id/" + owner + "/" + nonce))[0:32]`, so only the owner can
produce the valid `create` op.

### 5.1 Ops (`t: "op"`)

`par` lists the ids of the ops the author had seen (DAG heads). An op is evaluated only once all its
ancestors are known; it is **valid iff its author was permitted to perform it in the state formed
by its valid ancestors**.

| op | fields | who may |
|---|---|---|
| `create` | `owner, nonce, name` | the owner (no parents; id must match) |
| `add` | `identity, role` | owner: any role; admin: writer/reader |
| `role` | `identity, role, cut?` | owner: any non-owner; admin: writer/reader of non-admins |
| `remove` | `identity, cut` | owner: anyone but itself; admin: writers/readers |
| `leave` | `cut` | any non-owner member, for itself |
| `transfer` | `identity` | the owner, to a member (old owner becomes admin) |
| `revoke` | `revocation` (kind 7304 event), `cut` | any member, relaying a valid revocation |

Roles: `owner` (exactly one) > `admin` > `writer` > `reader`.

Conflict rules:

- a `remove` of X overrides every `add`/`role` for X that is not its descendant;
- `cut` maps device → highest accepted `seq`. Concurrent cut-offs for one device combine to the
  **minimum**. A message from a device with a cut-off is applied only if `seq ≤ cut`;
- a later (descendant) `add` lifts the identity's cut-offs.

A `ch` or `snap` message is applied iff its author may write under the final membership state
(including cut-offs). Unauthorized messages are stored and re-evaluated on every membership change.

### 5.2 Keys and rotation

The current epoch key is the one with the highest `num` (ties: lowest key id). Owners/admins
rotate on removal, device revocation, member addition and every 30 days, by sending the new key to
every active device of every member through their inboxes, then posting a snapshot in the new
epoch.

### 5.3 Inbox messages (inner kind 7305, payload `{ v: 2, t, dlg, … }`)

| `t` | fields | accepted when |
|---|---|---|
| `key` | `sp, name, personal, num, key, ops[]` | sender is admin+ of `sp` (or the same identity) under the carried + known ops, and the receiver is a member |
| `invite` | as `key` + `role`, optional `req` | as above; stored until the user accepts (`req = sha256(link secret)` → auto-accept for own join requests) |

`ops` are complete signed inner op events, verifiable without the old epoch keys.

### 5.4 Snapshots (`t: "snap"`)

Parts `i/n` with `body: { ops?: [inner…], cells?: [change…] }`. Rows that are deleted carry only their
`$deleted` cell. A complete snapshot from an authorized writer is merged like ordinary changes.
New members and newly paired devices receive keys for the **new** epoch only and catch up from
snapshots.

### 5.5 Invite links and pairing (secret routing)

- Invite link: `anodb://join?app=<appId>&s=<secret>`. The requester sends `{ t: "joinreq", devices: [delegations], name }`
  to the secret tag. An admin must approve; the link is single-use and expires.
- Pairing: `anodb://pair?app=<appId>&d=<new device pubkey>&s=<secret>`; both devices display
  `sha256("anodb/v2/pair-code/" + d + "/" + s)` as a 6-digit code. The approving device sends
  `{ t: "pair", delegation, spaces: [grant…] }` to the secret tag. The identity key is never sent.

### 5.6 Key package (kind 10304, public, replaceable)

`content = {"v":2,"delegations":[…]}` signed by the identity, listing current device delegations so
others can invite by npub.

## 6. Sync (informative)

1. **NIP-77**: `NEG-OPEN` with `{"kinds":[7303],"#n":[tags…]}` over the local envelope set; fetch
   `need` ids (repeat until complete — relays cap id lookups too), re-publish `have` envelopes.
   A relay answering `NEG-ERR`, a `NOTICE`, or nothing is treated as unsupported.
2. **Time-based**: `{"kinds":[7303],"#n":[tags…],"since":cursor−600}` per relay; after `EOSE`, page
   with `until` until nothing new; advance per-(relay, tag) cursors.
3. **Gaps**: per (space, device), every `seq` above the coverage of complete snapshots
   (`heads` in part 0) must be present; missing ones trigger a deep re-fetch.
4. **Snapshots**: new members/devices start from them.

Outbox: retry until `minAcks` relays acknowledge; envelopes older than 300 s are re-signed (new
throwaway key, fresh `created_at`, same content).

Optional pruning: envelope key = `sha256("anodb/v2/prune/" + hex(deviceSk) + "/" + salt)`; after a
snapshot the author publishes NIP-09 kind 5 `["e", id], ["k", "7303"]` for its older envelopes.

## 7. Public tables

Standard events, unencrypted, signed by the identity key:

| preset | kind | row id | replace rule |
|---|---|---|---|
| note | 1 | event id | none (delete = kind 5) |
| profile | 0 | author | newest per author |
| follows | 3 | `author:target` | newest list per author |
| reaction | 7 | event id | none |
| longForm | 30023 | `author:d` | newest per address |

A client publishing a new version of a replaceable event MUST use a `created_at` greater than the
version it replaces.

## 8. Blob references (Blossom)

Files are stored on Blossom servers (BUD-01/02/11/12), encrypted with AES-256-GCM
(`blob = iv(12) || ciphertext || tag`). The reference stored in a `json` column:

```jsonc
{ "v": 1, "sha256": "<sha256 of the encrypted blob>", "size": <plaintext bytes>, "type": "<mime>",
  "key": "<AES key, hex>", "servers": ["https://…"], "salt": "<hex>", "name"?: "…" }
```

Uploads/deletes carry `Authorization: Nostr <base64url(kind 24242 event)>` with `t`, `x`,
`expiration` and `server` tags, signed by `sha256("anodb/v2/blob/" + hex(deviceSk) + "/" + salt)`.
Clients MUST verify the sha256 of downloaded bytes before decrypting.

## 9. Direct delivery (WebRTC, via nostr-p2p)

- Room: `joinRoom("anodb:" + appId, hex(sha256("anodb/v2/p2p/" + hex(epochKey))), { transport: "direct" })`.
- Channel `anodb` messages:
  - `{ t: "hi", proof }` — `proof` is an event of kind 27305 signed by the device key with
    `content = roomId + ":" + <recipient session pubkey>`; only devices of current members are accepted.
  - `{ t: "e", e: <envelope> }` — a regular envelope (§2), verified exactly like one from a relay.
  - `{ t: "a", id }` — acknowledgement after successful ingestion.
- A sender MAY skip relays for an envelope only if every active device of every member of the space
  acknowledged it; otherwise it MUST publish it to relays (default after 2 s).
