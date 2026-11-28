import { decodeHlc } from './hlc.js'
import { Mutex } from './mutex.js'
import type { Change } from './protocol.js'
import { SYS_CREATED, SYS_DELETED, createTableSql, ownerOfRow, quoteIdent, tableFingerprint, toSql } from './schema.js'
import type { AnyDriver, AsyncSqlDriver, NostrEvent, SchemaDefinition, SqlDialectName, SqlValue } from './types.js'

function internalSchema(pg: boolean): string {
  // Postgres: millisecond timestamps need 64 bits; no rowid tables.
  const INT = pg ? 'BIGINT' : 'INTEGER'
  const BLOB = pg ? 'BYTEA' : 'BLOB'
  const WR = pg ? '' : ' WITHOUT ROWID'
  const capture = pg
    ? `
CREATE TABLE IF NOT EXISTS anodb_cap (n BIGSERIAL PRIMARY KEY, op TEXT NOT NULL, space TEXT, tbl TEXT NOT NULL, row_id TEXT, col TEXT NOT NULL, val JSONB);
CREATE TABLE IF NOT EXISTS anodb_ext (n BIGSERIAL PRIMARY KEY, op TEXT NOT NULL, space TEXT, tbl TEXT NOT NULL, row_id TEXT, col TEXT NOT NULL, val JSONB);`
    : ''
  return `
CREATE TABLE IF NOT EXISTS anodb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, personal ${INT} NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', created_at ${INT} NOT NULL
);
CREATE TABLE IF NOT EXISTS anodb_keys (
  space TEXT NOT NULL, key_id TEXT NOT NULL, num ${INT} NOT NULL, sealed ${BLOB} NOT NULL, created_at ${INT} NOT NULL,
  PRIMARY KEY (space, key_id)
)${WR};
CREATE TABLE IF NOT EXISTS anodb_messages (
  space TEXT NOT NULL, device TEXT NOT NULL, seq ${INT} NOT NULL, identity TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, msg_id TEXT NOT NULL, "inner" TEXT NOT NULL DEFAULT '', received_at ${INT} NOT NULL,
  PRIMARY KEY (space, device, seq)
)${WR};
CREATE INDEX IF NOT EXISTS anodb_messages_type ON anodb_messages (space, type);
CREATE TABLE IF NOT EXISTS anodb_prune (event_id TEXT PRIMARY KEY, salt TEXT NOT NULL, tag TEXT NOT NULL, created_at ${INT} NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_devices (
  device TEXT PRIMARY KEY, identity TEXT NOT NULL, delegation TEXT NOT NULL, name TEXT NOT NULL, revoked ${INT} NOT NULL DEFAULT 0
);
DROP TABLE IF EXISTS anodb_invites_out;
CREATE TABLE IF NOT EXISTS anodb_invites_in (space TEXT PRIMARY KEY, sender TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, received_at ${INT} NOT NULL);
DROP TABLE IF EXISTS anodb_join_requests;
CREATE TABLE IF NOT EXISTS anodb_cells (
  space TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT NOT NULL, hlc TEXT NOT NULL,
  PRIMARY KEY (space, tbl, row_id, col)
)${WR};
CREATE TABLE IF NOT EXISTS anodb_raw (id TEXT PRIMARY KEY, tag TEXT NOT NULL, created_at ${INT} NOT NULL, event TEXT NOT NULL, relay ${INT} NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS anodb_raw_tag ON anodb_raw (tag, created_at);
CREATE TABLE IF NOT EXISTS anodb_outbox (id TEXT PRIMARY KEY, event TEXT NOT NULL, queued_at ${INT} NOT NULL, resign ${INT} NOT NULL, hold_until ${INT} NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS anodb_acks (
  event_id TEXT NOT NULL, relay TEXT NOT NULL, status TEXT NOT NULL, message TEXT,
  PRIMARY KEY (event_id, relay)
)${WR};
CREATE TABLE IF NOT EXISTS anodb_cursors (relay TEXT NOT NULL, tag TEXT NOT NULL, since ${INT} NOT NULL, PRIMARY KEY (relay, tag))${WR};
DROP TABLE IF EXISTS anodb_public;${capture}
`
}

export type AckStatus = 'ok' | 'rejected'

export interface StoredMessage {
  space: string
  device: string
  seq: number
  identity: string
  type: string
  payload: string
}

export interface SpaceRow {
  id: string
  name: string
  personal: boolean
  status: string
}

export interface DeviceRow {
  device: string
  identity: string
  delegation: string
  name: string
  revoked: boolean
}

export interface InviteRow {
  space: string
  sender: string
  role: string
  name: string
  payload: string
  status: string
}

/** Wrap a synchronous SQLite driver in the async interface. */
export function toAsyncDriver(d: AnyDriver): AsyncSqlDriver {
  if ('dialect' in d) return d
  return {
    dialect: 'sqlite',
    exec: async (sql) => d.exec(sql),
    run: async (sql, params = []) => {
      d.run(sql, params as SqlValue[])
      return 0
    },
    all: async <T>(sql: string, params: readonly unknown[] = []) => d.all<T>(sql, params as SqlValue[]),
    close: async () => d.close(),
  }
}

const pgPlaceholderCache = new Map<string, string>()

/** `?` → `$n` outside quoted strings / identifiers (anoDB's own statements only). */
export function toPgPlaceholders(sql: string): string {
  let out = pgPlaceholderCache.get(sql)
  if (out !== undefined) return out
  out = ''
  let n = 0
  let quote: string | null = null
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null
      out += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
    } else out += ch === '?' ? `$${++n}` : ch
  }
  if (pgPlaceholderCache.size > 1000) pgPlaceholderCache.clear()
  pgPlaceholderCache.set(sql, out)
  return out
}

interface Caches {
  spaces: Map<string, SpaceRow & { createdAt: number }>
  devices: Map<string, DeviceRow>
  invites: Map<string, InviteRow & { receivedAt: number }>
  cursors: Map<string, number>
  outbox: Set<string>
}

interface Shared {
  db: AsyncSqlDriver
  pg: boolean
  mutex: Mutex
  closed: boolean
  schema: SchemaDefinition
  c: Caches
}

const ROLLBACK = Symbol('anodb.rollback')
const cursorKey = (relay: string, tag: string) => `${relay}\n${tag}`

/**
 * Local persistence. `anodb_cells` holds one LWW register per (space, table, row, column);
 * user tables are disposable projections rebuilt from cells. `anodb_messages` keeps every
 * accepted message so a space can be re-evaluated when its membership changes.
 *
 * Every statement is serialized through one lock. `transaction(fn)` holds the lock for the whole
 * callback and hands it a view (`s`) whose statements run inside the transaction: code called from
 * a transaction must use that view, never the outer store (which would wait for the lock forever).
 * Small, hot tables (spaces, devices, invitations, cursors, outbox ids) are mirrored in memory so
 * they can be read synchronously.
 */
export class Store {
  readonly #sh: Shared
  /** Connection of a transaction view (null for the store itself). */
  readonly #tx: AsyncSqlDriver | null
  #done = false

  private constructor(sh: Shared, tx: AsyncSqlDriver | null) {
    this.#sh = sh
    this.#tx = tx
  }

  static async open(driver: AnyDriver): Promise<Store> {
    const db = toAsyncDriver(driver)
    const pg = db.dialect === 'postgres'
    const sh: Shared = {
      db,
      pg,
      mutex: new Mutex(),
      closed: false,
      schema: {},
      c: { spaces: new Map(), devices: new Map(), invites: new Map(), cursors: new Map(), outbox: new Set() },
    }
    const store = new Store(sh, null)
    await store.transaction(async (s) => {
      await s.exec(internalSchema(pg))
      await s.#ensureColumn('anodb_raw', 'relay', 'INTEGER NOT NULL DEFAULT 1')
      await s.#ensureColumn('anodb_outbox', 'hold_until', 'INTEGER NOT NULL DEFAULT 0')
      await s.#ensureColumn('anodb_messages', 'inner', "TEXT NOT NULL DEFAULT ''")
      // identity whose signed change set the cell (null for cells from older versions)
      await s.#ensureColumn('anodb_cells', 'by', 'TEXT')
    })
    const release = await sh.mutex.lock()
    try {
      await store.#loadCaches(db)
    } finally {
      release()
    }
    return store
  }

  /** Add a column created by a newer version (CREATE TABLE IF NOT EXISTS does not alter tables). */
  async #ensureColumn(table: string, column: string, ddl: string): Promise<void> {
    if (this.#sh.pg) {
      await this.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdent(column)} ${ddl.replace(/^INTEGER/, 'BIGINT')}`)
      return
    }
    const cols = await this.all<{ name: string }>(`PRAGMA table_info(${table})`)
    if (!cols.some((c) => c.name === column)) await this.exec(`ALTER TABLE ${table} ADD COLUMN ${quoteIdent(column)} ${ddl}`)
  }

  async #loadCaches(db: AsyncSqlDriver): Promise<void> {
    const q = <T>(sql: string) => db.all<T>(sql)
    const c = this.#sh.c
    c.spaces = new Map(
      (await q<{ id: string; name: string; personal: number; status: string; created_at: number }>('SELECT id, name, personal, status, created_at FROM anodb_spaces')).map(
        (r) => [r.id, { id: r.id, name: r.name, personal: Number(r.personal) === 1, status: r.status, createdAt: Number(r.created_at) }],
      ),
    )
    c.devices = new Map(
      (await q<{ device: string; identity: string; delegation: string; name: string; revoked: number }>('SELECT device, identity, delegation, name, revoked FROM anodb_devices')).map(
        (r) => [r.device, { ...r, revoked: Number(r.revoked) === 1 }],
      ),
    )
    c.invites = new Map(
      (await q<InviteRow & { received_at: number }>('SELECT space, sender, role, name, payload, status, received_at FROM anodb_invites_in')).map(({ received_at, ...r }) => [
        r.space,
        { ...r, receivedAt: Number(received_at) },
      ]),
    )
    c.cursors = new Map((await q<{ relay: string; tag: string; since: number }>('SELECT relay, tag, since FROM anodb_cursors')).map((r) => [cursorKey(r.relay, r.tag), Number(r.since)]))
    c.outbox = new Set((await q<{ id: string }>('SELECT id FROM anodb_outbox')).map((r) => r.id))
  }

  get dialect(): SqlDialectName {
    return this.#sh.pg ? 'postgres' : 'sqlite'
  }

  get pg(): boolean {
    return this.#sh.pg
  }

  get schema(): SchemaDefinition {
    return this.#sh.schema
  }

  get closed(): boolean {
    return this.#sh.closed
  }

  /** True for a transaction view. */
  get inTransaction(): boolean {
    return this.#tx !== null
  }

  // ---- statements ------------------------------------------------------------------

  async #use<T>(fn: (d: AsyncSqlDriver) => Promise<T>, fallback: T): Promise<T> {
    // Background work (sync, reconciliation, timers) may still finish after close(): turn every
    // later call into a no-op instead of an error from a closed handle.
    if (this.#sh.closed) return fallback
    if (this.#tx) {
      if (this.#done) throw new Error('anoDB: statement on a finished transaction')
      return fn(this.#tx)
    }
    const release = await this.#sh.mutex.lock()
    try {
      return this.#sh.closed ? fallback : await fn(this.#sh.db)
    } finally {
      release()
    }
  }

  #sql(sql: string): string {
    return this.#sh.pg ? toPgPlaceholders(sql) : sql
  }

  /** One of anoDB's own statements (`?` placeholders in both dialects). */
  all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.#use((d) => d.all<T>(this.#sql(sql), params), [])
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.#use((d) => d.run(this.#sql(sql), params), 0)
  }

  exec(sql: string): Promise<void> {
    return this.#use((d) => d.exec(sql), undefined)
  }

  /** A statement in the driver's own dialect (user SQL: `$1` placeholders on Postgres). */
  allNative<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.#use((d) => d.all<T>(sql, params), [])
  }

  // ---- transactions ----------------------------------------------------------------

  async #inTx<T>(fn: (tx: AsyncSqlDriver) => Promise<T>, rollback: boolean): Promise<T> {
    const db = this.#sh.db
    if (db.transaction) {
      if (!rollback) return db.transaction(fn)
      let out!: T
      try {
        await db.transaction(async (tx) => {
          out = await fn(tx)
          throw ROLLBACK
        })
      } catch (e) {
        if (e !== ROLLBACK) throw e
      }
      return out
    }
    await db.exec(this.#sh.pg ? 'BEGIN' : 'BEGIN IMMEDIATE')
    let result: T
    try {
      result = await fn(db)
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => {})
      throw e
    }
    await db.exec(rollback ? 'ROLLBACK' : 'COMMIT')
    return result
  }

  async #view<T>(tx: AsyncSqlDriver, mode: 'internal' | 'capture', fn: (s: Store) => Promise<T>): Promise<T> {
    const view = new Store(this.#sh, tx)
    try {
      // Postgres triggers tell anoDB's own writes from other writers by this setting.
      if (this.#sh.pg) await tx.exec(`SELECT set_config('anodb.mode', '${mode}', true)`)
      return await fn(view)
    } finally {
      view.#done = true
    }
  }

  /** Run `fn` atomically. Nested calls on a view join the open transaction. */
  async transaction<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    if (this.#tx) return fn(this)
    const release = await this.#sh.mutex.lock()
    try {
      if (this.#sh.closed) return await fn(new Store(this.#sh, this.#sh.db))
      return await this.#inTx((tx) => this.#view(tx, 'internal', fn), false)
    } catch (e) {
      // In-memory mirrors may hold changes that were rolled back.
      if (!this.#sh.closed) await this.#loadCaches(this.#sh.db).catch(() => {})
      throw e
    } finally {
      release()
    }
  }

  /**
   * Hold the connection inside a transaction that always rolls back (write capture: the user's SQL
   * runs, triggers record the changed cells, the projection is restored). Call `end` once.
   */
  async capture(): Promise<{ s: Store; end: () => Promise<void> }> {
    if (this.#tx) throw new Error('anoDB: capture inside a transaction')
    const release = await this.#sh.mutex.lock()
    if (this.#sh.closed) {
      release()
      throw new Error('anoDB: database is closed')
    }
    let finish!: () => void
    const finished = new Promise<void>((r) => (finish = r))
    let ready!: (s: Store) => void
    let failed!: (e: unknown) => void
    const started = new Promise<Store>((res, rej) => {
      ready = res
      failed = rej
    })
    const done = this.#inTx(
      (tx) =>
        this.#view(tx, 'capture', async (s) => {
          ready(s)
          await finished
        }),
      true,
    ).finally(release)
    done.catch(failed)
    const s = await started
    return {
      s,
      end: async () => {
        finish()
        await done
      },
    }
  }

  async close(): Promise<void> {
    if (this.#sh.closed) return
    const release = await this.#sh.mutex.lock()
    try {
      if (this.#sh.closed) return
      this.#sh.closed = true
      await this.#sh.db.close()
    } finally {
      release()
    }
  }

  /** Change notifications from the driver (Postgres LISTEN), if it supports them. */
  listen(channel: string, fn: (payload: string) => void): Promise<(() => Promise<void>) | null> {
    return this.#sh.db.listen ? this.#sh.db.listen(channel, fn) : Promise.resolve(null)
  }

  // ---- meta ------------------------------------------------------------------------

  async getMeta(key: string): Promise<string | undefined> {
    return (await this.all<{ value: string }>('SELECT value FROM anodb_meta WHERE key = ?', [key]))[0]?.value
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.run('INSERT INTO anodb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  deleteMeta(key: string): Promise<void> {
    return this.run('DELETE FROM anodb_meta WHERE key = ?', [key])
  }

  /** Next own sequence number for a space. */
  nextSeq(space: string): Promise<number> {
    return this.transaction(async (s) => {
      const key = `seq:${space}`
      const n = Number((await s.getMeta(key)) ?? '0') + 1
      await s.setMeta(key, String(n))
      return n
    })
  }

  // ---- schema / projections ------------------------------------------------

  async applySchema(schema: SchemaDefinition, defaultSpace: string, owner?: string): Promise<void> {
    this.#sh.schema = schema
    await this.transaction(async (s) => {
      for (const [table, def] of Object.entries(schema)) {
        const fp = `${tableFingerprint(def)}|${defaultSpace}|${owner ?? ''}`
        const key = `schema:${table}`
        if ((await s.getMeta(key)) === fp) continue
        if (s.pg) {
          // Never drop a table someone else created (an existing Prisma table of the same name).
          const exists = (await s.allNative<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [quoteIdent(table)]))[0]?.t
          if (exists && !(await s.getMeta(`pgtable:${table}`))) {
            throw new Error(`anoDB: table "${table}" already exists and was not created by anoDB; rename the schema table or the existing one`)
          }
        }
        await s.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`)
        await s.exec(createTableSql(table, def, defaultSpace, owner, s.pg))
        if (s.pg) await s.setMeta(`pgtable:${table}`, '1')
        const rows = await s.all<{ space: string; row_id: string }>('SELECT DISTINCT space, row_id FROM anodb_cells WHERE tbl = ?', [table])
        for (const r of rows) await s.project(r.space, table, r.row_id)
        await s.setMeta(key, fp)
      }
    })
  }

  /**
   * LWW merge. `by` is the identity that signed the changes (a snapshot cell may carry its own as a
   * 6th element). Returns tables whose visible state may have changed.
   */
  applyChanges(space: string, changes: readonly Change[], by?: string): Promise<Set<string>> {
    return this.transaction(async (s) => {
      const dirty = new Map<string, Set<string>>()
      for (const c of changes) {
        const [table, rowId, column, value, hlc] = c
        const cellBy = (c as readonly unknown[])[5]
        const writer = typeof cellBy === 'string' && /^[0-9a-f]{64}$/.test(cellBy) ? cellBy : (by ?? null)
        const current = (await s.all<{ hlc: string }>('SELECT hlc FROM anodb_cells WHERE space = ? AND tbl = ? AND row_id = ? AND col = ?', [space, table, rowId, column]))[0]
        if (current && current.hlc >= hlc) continue
        await s.run(
          `INSERT INTO anodb_cells (space, tbl, row_id, col, value, hlc, "by") VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(space, tbl, row_id, col) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, "by" = excluded."by"`,
          [space, table, rowId, column, JSON.stringify(value ?? null), hlc, writer],
        )
        let rows = dirty.get(table)
        if (!rows) dirty.set(table, (rows = new Set()))
        rows.add(rowId)
      }
      for (const [table, rows] of dirty) {
        for (const rowId of rows) await s.project(space, table, rowId)
      }
      return new Set(dirty.keys())
    })
  }

  /** All current cells of a space (for snapshots), with the signing identity as a 6th element when known. */
  async cells(space: string): Promise<Change[]> {
    return (
      await this.all<{ tbl: string; row_id: string; col: string; value: string; hlc: string; by: string | null }>(
        'SELECT tbl, row_id, col, value, hlc, "by" FROM anodb_cells WHERE space = ? ORDER BY tbl, row_id, col',
        [space],
      )
    ).map((c) => (c.by ? [c.tbl, c.row_id, c.col, JSON.parse(c.value), c.hlc, c.by] : [c.tbl, c.row_id, c.col, JSON.parse(c.value), c.hlc]) as unknown as Change)
  }

  /** Drop all cells of a space and its projected rows. */
  clearSpace(space: string): Promise<Set<string>> {
    return this.transaction(async (s) => {
      const tables = new Set((await s.all<{ tbl: string }>('SELECT DISTINCT tbl FROM anodb_cells WHERE space = ?', [space])).map((r) => r.tbl))
      await s.run('DELETE FROM anodb_cells WHERE space = ?', [space])
      for (const t of tables) if (t in this.#sh.schema) await s.run(`DELETE FROM ${quoteIdent(t)} WHERE space = ?`, [space])
      return tables
    })
  }

  /** Rewrite one projected row from its cells (also restores rows changed by a rejected outside write). */
  project(space: string, table: string, rowId: string): Promise<void> {
    // Always inside anoDB's own transaction, so Postgres triggers know it is not an outside write.
    return this.transaction((s) => s.#projectRow(space, table, rowId))
  }

  async #projectRow(space: string, table: string, rowId: string): Promise<void> {
    const def = this.#sh.schema[table]
    if (!def) return // kept in cells; projected once the schema knows the table
    const cells = await this.all<{ col: string; value: string; hlc: string; by: string | null }>(
      'SELECT col, value, hlc, "by" FROM anodb_cells WHERE space = ? AND tbl = ? AND row_id = ?',
      [space, table, rowId],
    )
    const values = new Map<string, unknown>()
    let maxHlc = ''
    let updatedBy: string | null = null
    for (const c of cells) {
      values.set(c.col, JSON.parse(c.value))
      if (c.hlc > maxHlc) {
        maxHlc = c.hlc
        updatedBy = c.by
      }
    }
    // A row whose id names its creator exists only once that creator created it (others may not
    // write its $createdAt), so edits to a plain table cannot conjure a row in someone else's name.
    const unborn = ownerOfRow(rowId) !== null && !values.has(SYS_CREATED)
    if (values.get(SYS_DELETED) === true || cells.length === 0 || unborn) {
      await this.run(`DELETE FROM ${quoteIdent(table)} WHERE space = ? AND id = ?`, [space, rowId])
      return
    }
    const cols = Object.keys(def)
    const created = values.get(SYS_CREATED)
    const params: unknown[] = [
      space,
      rowId,
      ...cols.map((c) => toSql(def[c]!, values.get(c), this.#sh.pg)),
      typeof created === 'number' ? created : null,
      decodeHlc(maxHlc).millis,
      ownerOfRow(rowId),
      updatedBy,
    ]
    const names = ['space', 'id', ...cols, 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'].map(quoteIdent)
    const values$ = params.map(() => '?').join(', ')
    await this.run(
      this.#sh.pg
        ? `INSERT INTO ${quoteIdent(table)} (${names.join(', ')}) VALUES (${values$}) ON CONFLICT (space, id) DO UPDATE SET ${names
            .slice(2)
            .map((n) => `${n} = excluded.${n}`)
            .join(', ')}`
        : `INSERT OR REPLACE INTO ${quoteIdent(table)} (${names.join(', ')}) VALUES (${values$})`,
      params,
    )
  }

  // ---- spaces & keys (spaces mirrored in memory) -------------------------------------

  spaces(): SpaceRow[] {
    return [...this.#sh.c.spaces.values()]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ createdAt: _c, ...r }) => ({ ...r }))
  }

  space(id: string): SpaceRow | undefined {
    const r = this.#sh.c.spaces.get(id)
    return r && { id: r.id, name: r.name, personal: r.personal, status: r.status }
  }

  async upsertSpace(id: string, name: string, personal: boolean, status = 'active'): Promise<void> {
    const now = Date.now()
    await this.run(
      `INSERT INTO anodb_spaces (id, name, personal, status, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status`,
      [id, name, personal ? 1 : 0, status, now],
    )
    const cur = this.#sh.c.spaces.get(id)
    this.#sh.c.spaces.set(id, cur ? { ...cur, name, status } : { id, name, personal, status, createdAt: now })
  }

  async setSpaceStatus(id: string, status: string): Promise<void> {
    await this.run('UPDATE anodb_spaces SET status = ? WHERE id = ?', [status, id])
    const cur = this.#sh.c.spaces.get(id)
    if (cur) cur.status = status
  }

  putKey(space: string, keyId: string, num: number, sealed: Uint8Array): Promise<void> {
    return this.run('INSERT INTO anodb_keys (space, key_id, num, sealed, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      space,
      keyId,
      num,
      sealed,
      Date.now(),
    ])
  }

  async keys(): Promise<Array<{ space: string; keyId: string; num: number; sealed: Uint8Array; createdAt: number }>> {
    return (await this.all<{ space: string; key_id: string; num: number; sealed: Uint8Array; created_at: number }>('SELECT space, key_id, num, sealed, created_at FROM anodb_keys')).map(
      (r) => ({ space: r.space, keyId: r.key_id, num: Number(r.num), sealed: new Uint8Array(r.sealed), createdAt: Number(r.created_at) }),
    )
  }

  // ---- message log ---------------------------------------------------------------

  async hasMessage(space: string, device: string, seq: number): Promise<boolean> {
    return (await this.all('SELECT 1 AS x FROM anodb_messages WHERE space = ? AND device = ? AND seq = ?', [space, device, seq])).length > 0
  }

  putMessage(m: StoredMessage, msgId: string, inner: string): Promise<void> {
    return this.run(
      'INSERT INTO anodb_messages (space, device, seq, identity, type, payload, msg_id, "inner", received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [m.space, m.device, m.seq, m.identity, m.type, m.payload, msgId, inner, Date.now()],
    )
  }

  /** Signed inner events of a message type (portable: verifiable by anyone). */
  async inners(space: string, type: string): Promise<string[]> {
    return (await this.all<{ inner: string }>('SELECT "inner" FROM anodb_messages WHERE space = ? AND type = ? ORDER BY received_at, msg_id', [space, type])).map((r) => r.inner)
  }

  opRecords(space: string): Promise<Array<{ msgId: string; identity: string; payload: string }>> {
    return this.all<{ msgId: string; identity: string; payload: string }>(
      `SELECT msg_id AS "msgId", identity, payload FROM anodb_messages WHERE space = ? AND type = 'op' ORDER BY received_at, msg_id`,
      [space],
    )
  }

  /** Highest seq per device of one identity in a space (cut-offs for removal). */
  async deviceMaxSeqs(space: string, identity?: string, device?: string): Promise<Record<string, number>> {
    const where = ['space = ?']
    const params: SqlValue[] = [space]
    if (identity) {
      where.push('identity = ?')
      params.push(identity)
    }
    if (device) {
      where.push('device = ?')
      params.push(device)
    }
    const rows = await this.all<{ device: string; m: number }>(`SELECT device, MAX(seq) AS m FROM anodb_messages WHERE ${where.join(' AND ')} GROUP BY device`, params)
    return Object.fromEntries(rows.map((r) => [r.device, Number(r.m)]))
  }

  async countMessages(space: string, type: string, sinceReceived = 0): Promise<number> {
    return Number((await this.all<{ n: number }>('SELECT COUNT(*) AS n FROM anodb_messages WHERE space = ? AND type = ? AND received_at > ?', [space, type, sinceReceived]))[0]?.n ?? 0)
  }

  async seqsOf(space: string, device: string): Promise<number[]> {
    return (await this.all<{ seq: number }>('SELECT seq FROM anodb_messages WHERE space = ? AND device = ?', [space, device])).map((r) => Number(r.seq))
  }

  // ---- prunable envelopes (pruneOldEvents) ----------------------------------------

  putPrunable(eventId: string, salt: string, tag: string, createdAt: number): Promise<void> {
    return this.run('INSERT INTO anodb_prune (event_id, salt, tag, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [eventId, salt, tag, createdAt])
  }

  prunable(tags: readonly string[], before: number): Promise<Array<{ eventId: string; salt: string }>> {
    if (tags.length === 0) return Promise.resolve([])
    return this.all<{ eventId: string; salt: string }>(
      `SELECT event_id AS "eventId", salt FROM anodb_prune WHERE created_at < ? AND tag IN (${tags.map(() => '?').join(',')})`,
      [before, ...tags],
    )
  }

  forgetPrunable(eventId: string): Promise<void> {
    return this.run('DELETE FROM anodb_prune WHERE event_id = ?', [eventId])
  }

  // ---- devices (mirrored in memory) ---------------------------------------------------

  async putDevice(device: string, identity: string, delegation: string, name: string): Promise<void> {
    await this.run('INSERT INTO anodb_devices (device, identity, delegation, name) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [device, identity, delegation, name])
    if (!this.#sh.c.devices.has(device)) this.#sh.c.devices.set(device, { device, identity, delegation, name, revoked: false })
  }

  async revokeDevice(device: string): Promise<void> {
    await this.run('UPDATE anodb_devices SET revoked = 1 WHERE device = ?', [device])
    const d = this.#sh.c.devices.get(device)
    if (d) d.revoked = true
  }

  devices(identity?: string): DeviceRow[] {
    return [...this.#sh.c.devices.values()]
      .filter((d) => !identity || d.identity === identity)
      .sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0))
      .map((d) => ({ ...d }))
  }

  // ---- invitations (mirrored in memory) ---------------------------------------------

  async putInviteIn(space: string, sender: string, role: string, name: string, payload: string): Promise<void> {
    const now = Date.now()
    await this.run(
      `INSERT INTO anodb_invites_in (space, sender, role, name, payload, status, received_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(space) DO UPDATE SET sender = excluded.sender, role = excluded.role, name = excluded.name, payload = excluded.payload,
         status = CASE WHEN anodb_invites_in.status = 'accepted' THEN 'accepted' ELSE 'pending' END`,
      [space, sender, role, name, payload, now],
    )
    const cur = this.#sh.c.invites.get(space)
    this.#sh.c.invites.set(space, {
      space,
      sender,
      role,
      name,
      payload,
      status: cur?.status === 'accepted' ? 'accepted' : 'pending',
      receivedAt: cur?.receivedAt ?? now,
    })
  }

  invitesIn(status?: string): InviteRow[] {
    return [...this.#sh.c.invites.values()]
      .filter((i) => !status || i.status === status)
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .map(({ receivedAt: _r, ...i }) => ({ ...i }))
  }

  async setInviteInStatus(space: string, status: string): Promise<void> {
    await this.run('UPDATE anodb_invites_in SET status = ? WHERE space = ?', [status, space])
    const cur = this.#sh.c.invites.get(space)
    if (cur) cur.status = status
  }

  /** Forget all spaces and data (device pairing adopts another identity). Keeps node id and clock. */
  wipe(): Promise<void> {
    return this.transaction(async (s) => {
      for (const t of [
        'anodb_spaces',
        'anodb_keys',
        'anodb_messages',
        'anodb_cells',
        'anodb_raw',
        'anodb_outbox',
        'anodb_acks',
        'anodb_cursors',
        'anodb_devices',
        'anodb_invites_in',
      ]) {
        await s.run(`DELETE FROM ${t}`)
      }
      await s.run("DELETE FROM anodb_meta WHERE key LIKE 'seq:%' OR key LIKE 'schema:%' OR key LIKE 'snap:%'")
      for (const t of Object.keys(this.#sh.schema)) await s.run(`DELETE FROM ${quoteIdent(t)}`)
      const c = this.#sh.c
      c.spaces.clear()
      c.devices.clear()
      c.invites.clear()
      c.cursors.clear()
      c.outbox.clear()
    })
  }

  async messages(space: string, type?: string): Promise<StoredMessage[]> {
    const sql = `SELECT space, device, seq, identity, type, payload FROM anodb_messages WHERE space = ?${type ? ' AND type = ?' : ''} ORDER BY device, seq`
    return (await this.all<StoredMessage>(sql, type ? [space, type] : [space])).map((m) => ({ ...m, seq: Number(m.seq) }))
  }

  // ---- raw envelopes (for re-publishing and NIP-77) ------------------------------

  async hasRaw(id: string): Promise<boolean> {
    return (await this.all('SELECT 1 AS x FROM anodb_raw WHERE id = ?', [id])).length > 0
  }

  /** `viaRelay` = false for envelopes only exchanged peer-to-peer (not to be uploaded to relays). */
  putRaw(event: NostrEvent, tag: string, viaRelay = true): Promise<void> {
    return this.run(
      `INSERT INTO anodb_raw (id, tag, created_at, event, relay) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET relay = CASE WHEN excluded.relay > anodb_raw.relay THEN excluded.relay ELSE anodb_raw.relay END`,
      [event.id, tag, event.created_at, JSON.stringify(event), viaRelay ? 1 : 0],
    )
  }

  markRawLocal(id: string): Promise<void> {
    return this.run('UPDATE anodb_raw SET relay = 0 WHERE id = ?', [id])
  }

  async rawIndex(tags: readonly string[]): Promise<Array<{ id: string; created_at: number }>> {
    if (tags.length === 0) return []
    return (await this.all<{ id: string; created_at: number }>(`SELECT id, created_at FROM anodb_raw WHERE relay = 1 AND tag IN (${tags.map(() => '?').join(',')})`, tags)).map(
      (r) => ({ id: r.id, created_at: Number(r.created_at) }),
    )
  }

  async getRaw(id: string): Promise<NostrEvent | undefined> {
    const r = (await this.all<{ event: string }>('SELECT event FROM anodb_raw WHERE id = ?', [id]))[0]
    return r && (JSON.parse(r.event) as NostrEvent)
  }

  // ---- outbox --------------------------------------------------------------------

  async enqueue(event: NostrEvent, resign: boolean, holdUntil = 0): Promise<void> {
    await this.run('INSERT INTO anodb_outbox (id, event, queued_at, resign, hold_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      event.id,
      JSON.stringify(event),
      Date.now(),
      resign ? 1 : 0,
      holdUntil,
    ])
    this.#sh.c.outbox.add(event.id)
  }

  /** Release a held outbox entry so the next flush sends it to relays. */
  releaseOutbox(entryId: string): Promise<void> {
    return this.run('UPDATE anodb_outbox SET hold_until = 0 WHERE id = ?', [entryId])
  }

  async outbox(): Promise<Array<{ entryId: string; event: NostrEvent; resign: boolean; holdUntil: number; acks: Map<string, AckStatus> }>> {
    return this.transaction(async (s) => {
      const rows = await s.all<{ id: string; event: string; resign: number; hold_until: number }>('SELECT id, event, resign, hold_until FROM anodb_outbox ORDER BY queued_at, id')
      const acks = await s.all<{ event_id: string; relay: string; status: AckStatus }>('SELECT event_id, relay, status FROM anodb_acks')
      const byEvent = new Map<string, Map<string, AckStatus>>()
      for (const a of acks) {
        let m = byEvent.get(a.event_id)
        if (!m) byEvent.set(a.event_id, (m = new Map()))
        m.set(a.relay, a.status)
      }
      return rows.map((r) => ({
        entryId: r.id,
        event: JSON.parse(r.event) as NostrEvent,
        resign: Number(r.resign) === 1,
        holdUntil: Number(r.hold_until),
        acks: byEvent.get(r.id) ?? new Map(),
      }))
    })
  }

  replaceOutboxEvent(entryId: string, event: NostrEvent): Promise<void> {
    return this.run('UPDATE anodb_outbox SET event = ? WHERE id = ?', [JSON.stringify(event), entryId])
  }

  clearRejections(): Promise<void> {
    return this.run("DELETE FROM anodb_acks WHERE status = 'rejected'")
  }

  outboxSize(): number {
    return this.#sh.c.outbox.size
  }

  recordAck(eventId: string, relay: string, status: AckStatus, message: string): Promise<void> {
    return this.run(
      `INSERT INTO anodb_acks (event_id, relay, status, message) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, relay) DO UPDATE SET status = excluded.status, message = excluded.message`,
      [eventId, relay, status, message],
    )
  }

  async dequeue(eventId: string): Promise<void> {
    await this.transaction(async (s) => {
      await s.run('DELETE FROM anodb_outbox WHERE id = ?', [eventId])
      await s.run('DELETE FROM anodb_acks WHERE event_id = ?', [eventId])
    })
    this.#sh.c.outbox.delete(eventId)
  }

  // ---- cursors (mirrored in memory) ------------------------------------------------

  getCursor(relay: string, tag: string): number | undefined {
    return this.#sh.c.cursors.get(cursorKey(relay, tag))
  }

  async advanceCursor(relay: string, tag: string, createdAt: number): Promise<void> {
    await this.run(
      `INSERT INTO anodb_cursors (relay, tag, since) VALUES (?, ?, ?)
       ON CONFLICT(relay, tag) DO UPDATE SET since = CASE WHEN excluded.since > anodb_cursors.since THEN excluded.since ELSE anodb_cursors.since END`,
      [relay, tag, createdAt],
    )
    const k = cursorKey(relay, tag)
    this.#sh.c.cursors.set(k, Math.max(this.#sh.c.cursors.get(k) ?? 0, createdAt))
  }

  async resetCursors(): Promise<void> {
    await this.run('DELETE FROM anodb_cursors')
    this.#sh.c.cursors.clear()
  }
}
