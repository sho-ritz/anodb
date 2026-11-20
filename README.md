<p align="center">
  <img src="assets/anodb-logo.svg" alt="anoDB — Absolutely No DB" width="720" />
</p>

<h1 align="center">anoDB — Absolutely No DB</h1>

<p align="center"><strong>A decentralized, local-first database.</strong><br />Zero servers to run. Zero servers to trust.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@anodb/core"><img src="https://img.shields.io/npm/v/@anodb/core?label=%40anodb%2Fcore" alt="@anodb/core on npm" /></a>
  <a href="https://www.npmjs.com/package/@anodb/cli"><img src="https://img.shields.io/npm/v/@anodb/cli?label=%40anodb%2Fcli" alt="@anodb/cli on npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

anoDB is a decentralized, local-first database SDK that treats on-device SQLite as the source of truth and distributes changes as **end-to-end encrypted Nostr events** through existing public relays.

True to its name, it requires **absolutely no developer-operated server**: no API server, no database server, and no project setup. Offline reads and writes, multi-device sync and sharing with other people are available through a single type-safe, SQL-like API.

> **Status: v0.11 / experimental.** The protocol ([PROTOCOL.md](PROTOCOL.md), v2) may change incompatibly. See [docs/DESIGN.md](docs/DESIGN.md) for design details and limitations, and [docs/DECISIONS.md](docs/DECISIONS.md) for the decision log.

## Features

- 📴 **Offline-first** — Writes commit immediately to local SQLite. The network catches up later.
- 🧾 **Type-safe SQL** — A [Kysely](https://kysely.dev) query builder with JOINs, plus raw SQL writes (`UPDATE … LIKE`, `INSERT … SELECT`, upserts) that are captured and synced.
- 🗃️ **A plain database by default** — your data, on all your devices, with no invites and no rules to set up.
- 👥 **Sharing when you want it** — spaces with owner / admin / writer / reader roles, members added by public key, removal with cut-offs, key rotation. *How* people get invited (links, approval, sign-in with Google or your company's SSO) is left to your app or [anoAuth](#who-may-join-is-up-to-you).
- 🔐 **Signed and encrypted** — Writes are signed by per-device keys, keys are stored encrypted, relays see only throwaway pubkeys and rotating tags, and new members of a space never see deleted history.
- 🔀 **Deterministic merging** — Cell-level Last-Writer-Wins with Hybrid Logical Clocks; tolerant of out-of-order delivery, duplicates and retries.
- ⚡ **Direct device-to-device sync** — Your devices connect over WebRTC ([nostr-p2p](https://github.com/sho-ritz/nostr-p2p)) and exchange changes in tens of milliseconds; relays remain the store for offline devices.
- 🔁 **4-layer sync** — NIP-77 Negentropy, time-based fallback, sequence-gap detection, snapshots. A durable outbox retries until `minAcks` relays acknowledge.
- 📎 **Encrypted files** — Large files go to [Blossom](https://github.com/hzrd149/blossom) servers, encrypted on the device; only a reference is stored in the database.
- 🔏 **Opt-in row rules** — `createdBy` / `updatedBy` come from signatures and can’t be forged; mark a table `owned()` so only a row’s creator can edit it (checked on every device).
- ⚛️ **React** — `useQuery`, `useSyncStatus`, and ready-made `<PairDevice />`, `<AddMember />`, `<Invitations />`, `<Members />` components.

## Get started

In an existing app (Next.js, Vite, SvelteKit, Tauri, Electron, Expo or Node):

```sh
npx @anodb/cli init
```

One interactive command does the whole setup:

1. Asks the language (English / 日本語) and detects your environment and framework
2. Installs `@anodb/core` (plus `sql.js` for web apps)
3. Generates `anodb/schema`, `anodb/db` and a React `<DBProvider>`
4. Web apps: copies the SQLite WASM files to `public/anodb/` and adds `"postinstall": "anodb assets"` to keep them in sync
5. Wraps your app in `<DBProvider>` (Next.js `app/layout` or Vite `src/main`)
6. Optionally checks that the relays store and serve events

Then use it from any component:

```tsx
import { useAnoDB, useQuery } from '@anodb/core/react'

const db = useAnoDB()
const todos = useQuery((db) => db.selectFrom('todo').selectAll(), [])
await db.insertInto('todo').values({ title: 'Milk', done: false }).execute()
```

No bundler configuration, no server, no account. Keys are generated on each user's device on first
launch. Only one tab per origin opens the database; other tabs get `AnoDBError('tab-locked')`.

### Packages

The product is **anoDB**; on npm it lives under the `@anodb` scope.

| Package | What it is |
|---|---|
| [`@anodb/core`](https://www.npmjs.com/package/@anodb/core) | The database: sync, sharing, keys, files, React hooks (`@anodb/core/react`) and Node driver (`@anodb/core/node`) |
| [`@anodb/cli`](https://www.npmjs.com/package/@anodb/cli) | `npx @anodb/cli init` — the setup wizard (you never import it) |
| [`nostr-p2p`](https://www.npmjs.com/package/nostr-p2p) | WebRTC over Nostr signaling, used internally by `@anodb/core` |

### Manual setup

```sh
npm install @anodb/core sql.js   # sql.js only for browsers / Tauri
npx anodb assets                 # copy the SQLite WASM files to public/anodb/
```

```ts
import { browserDriver, createAnoDB } from '@anodb/core'
const db = await createAnoDB({ appId, schema, driver: await browserDriver({ name: appId }) })
```

Runs in browsers / Tauri (sql.js persisted to IndexedDB), Electron and Node.js 22.13+ (`node:sqlite`), and React Native / Expo (`expo-sqlite`).

## Usage

```ts
import { createAnoDB, defineSchema } from '@anodb/core'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean', priority: 'integer', meta: 'json' },
  tag: { name: 'text', todoId: 'text' },
})

const db = await createAnoDB({ appId: 'com.example.todo', schema, driver })

// SQL-like and type-safe, JOINs included
await db.insertInto('todo').values({ title: 'Buy groceries', done: false }).execute()
await db.updateTable('todo').set({ done: true }).where('title', 'like', '%groceries%').execute()
const rows = await db
  .selectFrom('todo')
  .leftJoin('tag', 'tag.todoId', 'todo.id')
  .select(['todo.title', 'tag.name'])
  .execute()

// Raw SQL works too; writes are captured by triggers, encrypted and synced
await db.execute('UPDATE todo SET done = 1 WHERE priority > ?', [2])

// Transactions (atomic locally, one sync unit)
await db.transaction().execute(async (tx) => {
  await tx.insertInto('todo').values({ title: 'A' }).execute()
})

// Live queries: re-run on local or remote changes
const stop = db.subscribe(db.selectFrom('todo').selectAll(), (rows) => render(rows))
```

- Every table gets `id`, `space`, `createdAt`, `updatedAt`, `createdBy` and `updatedBy` (`space` defaults to your personal space, see below).
- `boolean` columns read as `true / false` and `json` columns as parsed values (also through JOINs, aliases and live queries). Raw SQL strings (`db.execute`) return plain SQLite values.

### Keys (most secure defaults)

| Environment | Default key store |
|---|---|
| Browser / Tauri | IndexedDB, sealed with a non-extractable WebCrypto key |
| Node | Environment variables (`npx @anodb/cli init` writes only the device key and delegation to `.env`, never the identity key) |
| Electron / Expo | `electronKeyStore(safeStorage)` / `secureStorageKeyStore(expo-secure-store)` |

- Every write is signed by a **device key**; the identity key is used once to register the device.
- With `identity: 'recovery'`, the identity key is handed to `onRecoveryKey` once and never stored on the device.
- External signers: `signer: nip07Signer() | nip46Signer(uri) | nip55Signer(bridge)`.
- Relays see only throwaway pubkeys, per-epoch tags, times and sizes (`metadataProtection: 'none'` turns this off for allow-listed relays).

## Where data lives

| Space | Who can read and write | Use it for |
|---|---|---|
| **Personal space** (default, `db.personalSpace`) | your own devices | everything that is yours: no invites, no rules — just a database that follows you across devices |
| **Shared spaces** (`db.createSpace`) | the members you add (owner / admin / writer / reader) | a family list, a team, a chat room |

Everything is end-to-end encrypted. Without a server, *who can read* means *who holds the key*, so
sharing always means handing the key to someone — that is what an invitation does.

### Owned tables (opt-in row rule)

In a shared space, by default any writer may change or delete any row (like a table without row-level security). In an `owned(...)` table only the member who
created a row can change it; deleting is also allowed for admins and the owner of a shared space
(moderation), but they can't edit it. Every device enforces this when it applies a change, so a
modified client gets nowhere.

```ts
import { defineSchema, owned } from '@anodb/core'
defineSchema({
  todo: { title: 'text', done: 'boolean' },   // anyone can tick items
  messages: owned({ text: 'text' }),          // only the author can edit / delete
  profiles: owned({ name: 'text' }),
})
// "one row per member": use your identity as the id — in an owned table only you can write it
await db.insertInto('profiles').values({ id: db.pubkey, name: 'Taro' }).execute()
```

In every table, `createdBy` / `updatedBy` are taken from signatures (read-only), and nobody can
create a row whose id names someone else.

## Sharing (spaces)

```ts
const family = await db.createSpace('Family')
await db.insertInto('todo').values({ title: 'Milk', space: family }).execute()

// Add by public key (owners / admins): the space key is delivered to their devices.
// Their devices come from the key package they published (alice.publishKeyPackage()),
// or are handed over directly: { devices: alice.deviceDelegations() }
await db.addMember(family, 'npub1alice…', 'writer')     // admin / writer / reader
// The new member: nothing syncs until they accept
alice.onInvitation((i) => …); await alice.acceptInvitation(i.space)

await db.setRole(family, who, 'reader')
await db.removeMember(family, who)
```

- New members receive **only a snapshot of the current state** — no edit history and no deleted content.
- Group keys rotate on member removal, device revocation, member addition and every 30 days.
- After removal, writes beyond each device's sequence-number cut-off are rejected (backdating does not help).

### Who may join is up to you

anoDB only knows public keys: it adds and removes members and delivers keys to them. Deciding
*who* may join — invite links, approval by an admin, "anyone who signs in with Google as
@company.com", a company SSO — is a separate concern, planned as **anoAuth**, which runs on an
admin's device and calls `addMember` when someone qualifies.

### Adding and revoking devices

```ts
// New device: show a QR code
const offer = await newDevice.startPairing()   // render offer.uri as QR, show offer.code
await offer.done; await newDevice.close()      // reopen: it now has the same identity
// Existing device: scan, compare the code, approve (the identity key is never copied)
const req = db.parsePairing(uri); /* check req.code */ await req.approve('Laptop')

await db.revokeDevice(lostDevicePubkey)        // lost or stolen device
```

> ⚠ Group keys are delivered to device keys only. **If you lose every device, your personal space cannot be recovered** (shared spaces can be restored by other members). Register at least two devices.

## Ephemeral events

For things that should reach whoever is online right now and then vanish — "typing…", presence,
cursors — use events instead of rows:

```ts
const stop = db.onEvent((e) => showTyping(e.from), { space, type: 'typing' })
await db.emit(space, 'typing', { on: true })
```

- Delivered to the space's members who are online; **never stored or synced later** (relays treat
  them as ephemeral, kind 27303). Your own `emit` is not echoed back.
- Encrypted with the space key and signed by your device like every write; `e.from` is the sender's
  identity. Any member (readers included) may send; outsiders can neither send nor read.
- Up to 8 KB each, dropped after 60 seconds.

## Direct sync over WebRTC

Where WebRTC is available (browsers, or Node with `node-datachannel`), **your own devices connect
directly** and exchange changes peer-to-peer (signaling goes through the same Nostr relays).

```ts
createAnoDB({ ..., p2p: { mode: 'own-devices' } })       // default where WebRTC exists
createAnoDB({ ..., p2p: { mode: 'members' } })           // also connect to other members (they see your IP)
createAnoDB({ ..., p2p: { mode: 'off' } })               // relays only
// Node: p2p: { rtc: { RTCPeerConnection } } from 'node-datachannel/polyfill'

db.p2pPeers() // [{ space, device, transport: 'direct' }]
```

- Rooms are derived from each space's epoch key, so only members can join and removed members drop out when keys rotate.
- Every peer proves which device it is with a signature; envelopes received directly go through the same verification as relay ones.
- A change **skips relays entirely when every device of the space acknowledged it**; otherwise it is published to relays after 2 s, so offline devices still get it.
- `members` mode is opt-in because direct connections reveal IP addresses to other members.

## Files (Blossom)

Values are limited to ~44 KB, so files go to Blossom servers (Nostr's blob storage). They are
encrypted on the device with a random key; the database only stores a small reference, which is
synced end-to-end encrypted like any other value — so only members of the space can open the file.

```ts
const schema = defineSchema({ notes: { text: 'text', photo: 'json' } })

const ref = await db.blobs.put(file, { type: file.type, name: file.name }) // encrypt + upload (mirrored)
await db.insertInto('notes').values({ text: 'receipt', photo: ref }).execute()

const [row] = await db.selectFrom('notes').select('photo').execute()
const blob = await db.blobs.getBlob(row.photo)   // download, verify hash, decrypt
img.src = URL.createObjectURL(blob)

await db.blobs.delete(ref)                        // only from the device that uploaded it
```

- Servers see only ciphertext, its size, upload time and your IP. Each upload is signed by a throwaway key.
- Downloads are verified against the sha256, so a server cannot alter a file; other servers are tried on failure.
- Default servers: `DEFAULT_BLOB_SERVERS` (public servers that accept encrypted uploads). **Most public Blossom servers only accept images/video and reject ciphertext**, and none guarantee retention — use `blobServers` to add your own or paid servers.

## Relays

By default anoDB writes to a few fixed relays (`DEFAULT_RELAYS`) **and**, since 0.12.0, to 5 relays
picked for each space from a bundled candidate list (`RELAY_CANDIDATES`). The pick is derived from a
secret (the space's epoch key, the device key for its inbox, the link secret for pairing), so every
member lands on the same relays and outsiders cannot tell which ones.

```ts
createAnoDB({ ... })                                        // fixed + automatically picked relays
createAnoDB({ ..., relays: ['wss://my.relay'] })            // only your relays (no automatic pick)
createAnoDB({ ..., relays: ['wss://my.relay'], autoRelays: true }) // yours + automatically picked
createAnoDB({ ..., maxAutoRelays: 10 })                     // cap the extra connections (default 20)
```

This is **phase 1** of a compatible migration (see `docs/DECISIONS.md`, rows 29–30): the fixed relays
are still always written and read, so older versions keep syncing. A later version switches each
space to its picked relays automatically once all of its devices run a version that reads them.

## Sync health

```ts
db.status        // { state: 'offline' | 'syncing' | 'synced', connectedRelays, pendingEvents }
db.syncHealth()  // { gaps: [{ space, device, missing: [7, 8] }], nip77: { 'wss://…': true } }
await db.repair() // deep re-fetch from every relay
```

On NIP-77 relays, reconciliation is exact and lost envelopes are re-uploaded automatically. On other relays, per-device sequence numbers still **detect** anything missing.

## React

```tsx
import { AnoDBProvider, useQuery, useSyncStatus } from '@anodb/core/react'

<AnoDBProvider db={db}><App /></AnoDBProvider>
const todos = useQuery((db) => db.selectFrom('todo').selectAll().where('done', '=', false), [])
const status = useSyncStatus()
```

### Ready-made components

Sharing and multi-device are anoDB's core features, so their UI ships with it:

```tsx
import { AddMember, DeviceList, Invitations, Members, PairDevice } from '@anodb/core/react'

<PairDevice />            {/* add a device: QR code + a code to compare on both devices */}
<DeviceList />            {/* your devices, revoke with a confirming second click */}
<AddMember space={id} />  {/* add someone by npub (owners / admins) */}
<Invitations onJoined={setSpace} /> {/* spaces you were added to: accept / decline */}
<Members space={id} />    {/* roles and removal for owners / admins */}
```

- Plain HTML with `anodb-*` class names and only layout styles — style them like the rest of your app.
- English and Japanese built in (`lang="ja"`, default: the browser's language); override any text with `labels`.
- Pairing links and QR codes are ordinary `https://your-app/#anodb=…` URLs. Scanning one with a phone
  camera opens your app with the request filled in — nothing is approved without a click, and pairing
  always shows a code to compare.
- Building your own? `useLive((db) => db.members(id))`, `toAppLink()`, `parseAppLink()` and `<QRCode />` are exported too.

## Column types

| Type | Write (TS) | Read (TS) | SQLite |
|---|---|---|---|
| `text` | `string` | `string` | TEXT |
| `integer` | `number` (safe integer) | `number` | INTEGER |
| `real` | `number` | `number` | REAL |
| `boolean` | `boolean` | `boolean` | INTEGER (0 / 1) |
| `json` | any JSON value | `unknown` | TEXT |
| `json<T>()` | `T` | `T` | TEXT |

```ts
import { defineSchema, json } from '@anodb/core'
const schema = defineSchema({ note: { title: 'text', meta: json<{ tags: string[] }>() } })
```

All columns are nullable.

## Limitations

- **Public relays do not guarantee retention.** Multiple relays, `minAcks` and repair improve durability but cannot guarantee it.
- **Consistency across devices is eventual.** Not suitable for global inventory counts, balances or uniqueness constraints.
- **SQL queries only cover locally available data.**
- **Deletion uses tombstones.** Copies held by relays or other people are not erased; removed members keep what they already read.
- **Losing every device loses your personal space** (by design, for security).
- With only non-NIP-77 relays, more events in a single second than a relay's result limit can be missed; `syncHealth()` reports the gap.
- Files depend on Blossom servers' retention policies (none are guaranteed).
- The local SQLite file itself is not encrypted; rely on disk encryption.

See [docs/DESIGN.md](docs/DESIGN.md) for the threat model and open issues.

## Development

```sh
npm test              # unit + integration tests against a mock relay (NIP-77, fault injection)
npm run typecheck
npm run smoke:public  # checks against real public relays (network required)
```

## License

MIT
