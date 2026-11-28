# Changelog

## Unreleased — PostgreSQL server driver

- `pgDriver(pool)`: anoDB on a PostgreSQL server (node-postgres `Pool`, e.g. Postgres in Docker),
  with the same behaviour as PGlite: native Postgres tables, Kysely compiled to Postgres, and
  writes from other tools synced. Prisma, TypeORM, Drizzle and psql can use other connections to
  the same database. anoDB picks their writes up through triggers and `LISTEN / NOTIFY`.
  - Transactions run on one pooled client, and `LISTEN` holds another, so give the pool at least 3
    connections.
  - BIGINT columns are read as numbers, like PGlite.
- `npx @anodb/cli init` offers **PostgreSQL server** next to SQLite and PGlite (Node servers):
  - It asks for the connection URL, defaulting to an existing `DATABASE_URL`, and writes it to
    `.env` as `ANODB_DATABASE_URL`.
  - It installs `pg`, plus `@types/pg` for TypeScript projects, and generates a `db.ts` with
    `pgDriver(pool)`.
  - Projects that already use Postgres tooling (Prisma, TypeORM, Drizzle, `pg`, …) get it as the
    default.
  - Flags: `--db postgres --database-url <url>`.
- `npm run test:pg` runs the whole test suite on a PostgreSQL server, with one fresh database per
  test. `docker-compose.test.yml` starts one.

## Unreleased — self-hosted relay on Cloudflare

- `npx anodb relay deploy`: deploys a Nostr relay to your Cloudflare account, on Workers with a
  SQLite-backed Durable Object. It uses Wrangler's browser login and prints the `wss://` URL.
  Running it again updates the same Worker and keeps the stored events.
- `npx anodb relay dev` runs the same relay locally, and `--dry-run` only builds it.
- The relay supports NIP-01, 09, 11 and 77. By default it accepts only the kinds anoDB uses.
  Subscriptions are stored in SQL, so they survive WebSocket hibernation.

## Unreleased — server-confirmed tables

- `confirmed(def, { by })`: only the given identity (your server) may write the table. Every
  device enforces this, including for snapshots, which can no longer vouch for these cells unless
  the authority signed them.
- `serveRequests(db, { requests, results, handle })` (run it on that server): picks up client
  requests, decides them one at a time in a transaction (e.g. the last seat goes to exactly one
  request), and writes the result to the request's space in the same commit. It is idempotent
  across restarts.

## Unreleased — PGlite (Postgres) driver

anoDB can now store its data in **Postgres via [PGlite](https://pglite.dev)**, so it runs on a server
next to Prisma, Drizzle or any other tool that talks to the same database.

### New

- `pgliteDriver(pg, { close? })`: Postgres in WASM. User tables are native Postgres tables
  (`boolean`, `bigint`, `double precision`, `jsonb`). Kysely compiles to Postgres, raw SQL uses
  Postgres syntax (`$1`).
- **Writes from outside anoDB are synced.** On Postgres, triggers queue rows that other tools insert,
  update or delete; anoDB commits them like its own writes (permissions, HLC, signature, encryption,
  relays), on `LISTEN / NOTIFY`, a timer, and at startup. `db.syncExternalWrites()` waits for them.
  Rows that fail the checks are restored and reported as `AnoDBError` code `'rejected-write'`.
- anoDB refuses to start (instead of dropping it) when a Postgres table of the same name already
  exists that it did not create.
- `createAnoDB({ driver })` accepts any `AsyncSqlDriver` (`{ dialect, exec, run, all, transaction?, listen?, close }`).
  New types: `AsyncSqlDriver`, `AnyDriver`, `SqlDialectName`, `PGliteLike`, `PGliteDriverOptions`.
- `npm run test:pglite` runs the whole test suite on PGlite.

### Changed (breaking)

The storage layer is now asynchronous end to end (PGlite has no synchronous API). The SQLite drivers
(`nodeSqlite`, `sqlJsDriver`, `browserDriver`, `expoSqliteDriver`) keep their synchronous interface
and are wrapped internally; local writes stay atomic because every statement goes through one lock
and transactions hold it until they end.

- `syncHealth()` and `resync()` return a `Promise`; `declineInvitation()` returns a `Promise`.
- `reconcile(relay)` no longer returns `false` while another reconciliation with the same relay is
  running: calls for one relay run one after another.
- Protected hooks for subclasses are async and take the transaction store where they write
  (`sendToSpace`, `onMessage`, `rebuildSpace`, `wrap`, `afterLocalWrite`, `afterSnapshot`, …).
  `invalidateMembership(space)` is replaced by `reloadMembership(store, space)`.
- `spaces()`, `members()`, `devices()`, `invitations()`, `roleIn()` stay synchronous (kept in memory).

### `@anodb/cli`

- `init` asks for the database in Node and Electron projects: SQLite (default) or PGlite (default
  when the project already depends on Prisma, Drizzle, `pg` or PGlite). Flag: `--db sqlite|pglite`.
  The PGlite template exports `pg` for sharing with other tools and ignores `anodb-pgdata/`.

### Compatibility

- Wire protocol stays **v2**; PGlite and SQLite devices sync with each other and with 0.12.0.
- Existing SQLite databases open unchanged (same tables, no migration).

## 0.12.0 — automatic relay selection, phase 1 (compatible)

anoDB is moving from a few fixed relays to relays **picked per space from a vetted candidate list**
(docs/DECISIONS.md, rows 29–30). The move happens in three phases so that devices on older versions
never lose sync. **This release is phase 1: nothing is removed, the picked relays are added.**

### What changes

- Envelopes are still written to and read from the fixed relays (`DEFAULT_RELAYS`), exactly as before.
- In addition, each space (per epoch key), this device's inbox and an open pairing link are routed
  to **5 relays picked from `RELAY_CANDIDATES`** by rendezvous hashing over a secret seed (epoch
  key / device pubkey / link secret). Members of a space land on the same relays; relays and
  removed members cannot tell which ones.
- A write counts as delivered when the fixed relays accepted it (`minAcks`), as before. The picked
  relays get extra copies (sent when they connect, and topped up by NIP-77 reconciliation).
- Devices that read the picked relays add `rp: 1` to their space messages. Older versions ignore it.
  Phase 2 uses it to know when a space can switch.
- Ephemeral events (`db.emit`) follow the same routes. WebRTC signaling stays on the fixed relays.

### Options

- `autoRelays` — on by default; **off when you pass `relays`** (your relays stay exactly as
  configured). Pass `autoRelays: true` to add picked relays to your own.
- `relayCandidates` — replace the bundled candidate list.
- `maxAutoRelays` — at most this many extra connections (default 20). Tags beyond the budget stay on
  the fixed relays only.
- New exports: `RELAY_CANDIDATES`, `RELAY_CANDIDATES_VERSION`, `rankRelays`.

### `@anodb/cli` 0.12.0

- Depends on `@anodb/core` `^0.12.0` (with 0.x versions, `^0.11.0` would have kept installs on 0.11).
- The setup wizard's relay choice now reads "Pick automatically (recommended)" / "Enter my own (turns
  automatic selection off)". The generated code is unchanged: the default writes no `relays`
  option, so automatic selection is on.

### Compatibility

- Wire protocol stays **v2**. 0.12.0 and older versions sync with each other in the same space.
- More connections: up to 5 fixed relays plus up to `maxAutoRelays` picked ones.
- The candidate list is **version 1, provisional**: 337 relays that answered every check of the
  relay survey on 2026-11-20/21 (`scripts/relay-survey/`). Retention (7/30 days) and the
  operator/software/region caps are not yet applied; later versions keep every relay that passes the full criteria
  under those caps (no fixed size, at least 20).

### Next phases (not in this release)

- **Phase 2:** once every active device of a space sends `rp: 1`, an admin device switches the space
  automatically at the next epoch: new data goes to the picked relays only, the fixed relays are
  still read for 30 days. The candidate list version is pinned in the space's signed settings, and
  the fault-tolerance rules (ranks 6–10, time-range gap queries) are added.
- **Phase 3:** stop using the fixed relays once old versions are gone. Inbox messages and
  invite/pairing links keep going to the fixed relays until then.
