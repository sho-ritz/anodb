<p align="center">
  <img src="assets/anodb-logo.svg" alt="anoDB — Absolutely None DB" width="720" />
</p>

<h1 align="center">anoDB — Absolutely None DB</h1>

<p align="center"><strong>A local-first SQLite database that syncs over Nostr relays — no backend to provision.</strong></p>

anoDB is a local-first database SDK that treats on-device SQLite as the source of truth and distributes changes as **end-to-end encrypted Nostr events** through existing public relays.

True to its name, it requires **absolutely no developer-operated server**: no API server, no database server, and no project setup. Offline reads and writes, multi-device synchronization, and fetching other users' public Nostr profiles are available through a single typed API.

> **Status: v0.1 / experimental.** The protocol ([PROTOCOL.md](PROTOCOL.md)) may change incompatibly. See [docs/DESIGN.md](docs/DESIGN.md) for design details and limitations.

## Features

- 📴 **Offline-first** — Writes commit immediately to local SQLite. The network catches up later.
- 🔐 **End-to-end encryption** — Values, table names, column names, and the app ID are hidden from relays (encrypted to the owner's own key using NIP-44 v2).
- 🔀 **Deterministic merging** — Cell-level (row × column) Last-Writer-Wins with Hybrid Logical Clocks, designed to tolerate out-of-order delivery, duplicates, and retries.
- 📮 **Outbox** — Retries until `minAcks` relays acknowledge storage, including changes made offline.
- 🧬 **Rebuildable projection tables** — Reconstruct tables from stored cells after schema changes without discarding columns unknown to older devices.
- 🌐 **Nostr compatibility** — Read and publish kind 0 (profiles), kind 1 (notes), and kind 10002 (NIP-65 relay lists). Retrieved data is cached in SQLite.
- 🪶 **Minimal dependencies** — Only `nostr-tools` and `@noble/hashes`.

## Installation

```sh
npm install anodb
```

Runs on Node.js 22.13+ (using `node:sqlite`) or in browsers with a synchronous SQLite implementation such as `sql.js`.

## Usage

```ts
import { createAnoDB, defineSchema } from 'anodb'
import { nodeSqlite } from 'anodb/node'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean', priority: 'integer', meta: 'json' },
})

const db = createAnoDB({
  appId: 'com.example.todo',
  schema,
  driver: nodeSqlite('todo.sqlite'),
  // secretKey: 'nsec1…',   // Generated and saved in the DB if omitted
  // relays: [...],          // Defaults to DEFAULT_RELAYS; [] enables local-only mode
})

const todos = db.table('todo')
const id = todos.insert({ title: 'Buy groceries', done: false })
todos.update(id, { done: true })

todos.findMany({ where: { done: false }, orderBy: { createdAt: 'desc' }, limit: 20 })
db.sql('SELECT title FROM todo WHERE priority > ?', [1]) // Read-only SQL

// Subscribe to changes from this device or other devices
const stop = todos.subscribe({ where: { done: false } }, (rows) => render(rows))

// Group multiple writes into one transaction (= one event)
db.transaction((tx) => {
  const a = tx.insert('todo', { title: 'A' })
  tx.update('todo', a, { priority: 1 })
})
```

### Sync across devices

Simply provide the same owner key on another device.

```ts
const key = db.exportSecretKey() // nsec1… Transfer securely to the other device
const other = createAnoDB({ appId: 'com.example.todo', schema, driver: nodeSqlite('b.sqlite'), secretKey: key })
```

### Sync status

```ts
db.status // { state: 'offline' | 'syncing' | 'synced', connectedRelays, pendingEvents }
db.onStatus((s) => console.log(s.state))
db.onError((e) => console.warn(e.code, e.message))
await db.waitForSync()
```

### Public Nostr data

Compatible with other Nostr clients.

```ts
const { value: profile, status } = await db.nostr.getProfile(pubkey)
// status: 'synced' | 'stale' (cached data returned after a fetch failure) | 'unavailable'
db.nostr.cachedProfile(pubkey)           // No network access

db.nostr.publishProfile({ name: 'alice', about: 'hello' })
db.nostr.publishNote('Posting from anoDB', [['t', 'anodb']])
await db.nostr.getNotes(pubkey, { limit: 20 })
```

### Browser (sql.js)

```ts
import initSqlJs from 'sql.js'
import { createAnoDB, sqlJsDriver } from 'anodb'

const SQL = await initSqlJs()
const db = createAnoDB({ appId, schema, driver: sqlJsDriver(new SQL.Database()) })
```

`sql.js` uses an in-memory database. For persistence, implement a synchronous VFS (such as the sqlite-wasm OPFS SAH Pool) in a Worker and expose it as a `SqliteDriver`. A bundled OPFS driver is planned for v0.3.

## Column types

| Type | TypeScript | SQLite |
|---|---|---|
| `text` | `string` | TEXT |
| `integer` | `number` (safe integer) | INTEGER |
| `real` | `number` | REAL |
| `boolean` | `boolean` | INTEGER 0/1 |
| `json` | `unknown` | TEXT |

All columns are nullable. Every row automatically includes `id`, `createdAt`, and `updatedAt`.

## Limitations

- **Public relays do not guarantee retention.** Using multiple relays and `minAcks` improves durability but cannot guarantee it.
- **Consistency across devices is eventual.** This is not suitable for enforcing global inventory counts, balances, or uniqueness constraints.
- **SQL queries only cover locally available data.**
- **Deletion uses tombstones.** Historical events may remain on relays.
- **v0.1 supports one owner across multiple devices.** Sharing with other users is planned for v0.2.
- **Initial synchronization can miss events** when the number of events in a single second exceeds a relay's result limit. NIP-77 support is planned to address this.

For more, see the unresolved issues in [docs/DESIGN.md](docs/DESIGN.md).

## Development

```sh
npm test              # Unit and local WebSocket relay integration tests (with fault injection)
npm run typecheck
npm run smoke:public  # Connectivity smoke test against public relays (requires network)
```

## License

MIT
