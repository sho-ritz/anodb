import { decodeHlc } from './hlc.js'
import type { Change } from './protocol.js'
import { SYS_CREATED, SYS_DELETED, createTableSql, quoteIdent, tableFingerprint, toSql } from './schema.js'
import type { NostrEvent, SchemaDefinition, SqlValue, SqliteDriver } from './types.js'

const INTERNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS anodb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_cells (
  tbl TEXT NOT NULL, row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT NOT NULL, hlc TEXT NOT NULL,
  PRIMARY KEY (tbl, row_id, col)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_outbox (id TEXT PRIMARY KEY, event TEXT NOT NULL, queued_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_acks (
  event_id TEXT NOT NULL, relay TEXT NOT NULL, status TEXT NOT NULL, message TEXT,
  PRIMARY KEY (event_id, relay)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_cursors (relay TEXT PRIMARY KEY, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_public (
  pubkey TEXT NOT NULL, kind INTEGER NOT NULL, event TEXT NOT NULL, created_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, kind)
) WITHOUT ROWID;
`

export type AckStatus = 'ok' | 'rejected'

/**
 * Local persistence. `anodb_cells` is the source of truth (one LWW register per cell);
 * user tables are disposable projections rebuilt from cells whenever the schema changes.
 */
export class Store {
  readonly #db: SqliteDriver
  #schema: SchemaDefinition = {}
  #depth = 0

  constructor(db: SqliteDriver) {
    this.#db = db
    db.exec(INTERNAL_SCHEMA)
  }

  get driver(): SqliteDriver {
    return this.#db
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn()
    this.#db.exec('BEGIN IMMEDIATE')
    this.#depth++
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (e) {
      this.#db.exec('ROLLBACK')
      throw e
    } finally {
      this.#depth--
    }
  }

  getMeta(key: string): string | undefined {
    return this.#db.all<{ value: string }>('SELECT value FROM anodb_meta WHERE key = ?', [key])[0]?.value
  }

  setMeta(key: string, value: string): void {
    this.#db.run('INSERT INTO anodb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  /** Create/refresh projection tables. A table whose definition changed is rebuilt from cells. */
  applySchema(schema: SchemaDefinition): void {
    this.#schema = schema
    this.transaction(() => {
      for (const [table, def] of Object.entries(schema)) {
        const fp = tableFingerprint(def)
        const key = `schema:${table}`
        if (this.getMeta(key) === fp) continue
        this.#db.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`)
        this.#db.exec(createTableSql(table, def))
        const rows = this.#db.all<{ row_id: string }>('SELECT DISTINCT row_id FROM anodb_cells WHERE tbl = ?', [table])
        for (const { row_id } of rows) this.#project(table, row_id)
        this.setMeta(key, fp)
      }
    })
  }

  /**
   * Merge changes with last-writer-wins per cell (higher HLC wins; equal HLC is a duplicate).
   * Returns the tables whose visible state may have changed. Must run inside `transaction`.
   */
  applyChanges(changes: readonly Change[]): Set<string> {
    const dirty = new Map<string, Set<string>>()
    for (const [table, rowId, column, value, hlc] of changes) {
      const current = this.#db.all<{ hlc: string }>(
        'SELECT hlc FROM anodb_cells WHERE tbl = ? AND row_id = ? AND col = ?',
        [table, rowId, column],
      )[0]
      if (current && current.hlc >= hlc) continue
      this.#db.run(
        `INSERT INTO anodb_cells (tbl, row_id, col, value, hlc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tbl, row_id, col) DO UPDATE SET value = excluded.value, hlc = excluded.hlc`,
        [table, rowId, column, JSON.stringify(value ?? null), hlc],
      )
      let rows = dirty.get(table)
      if (!rows) dirty.set(table, (rows = new Set()))
      rows.add(rowId)
    }
    for (const [table, rows] of dirty) {
      if (!(table in this.#schema)) continue // kept in cells, projected once the schema knows it
      for (const rowId of rows) this.#project(table, rowId)
    }
    return new Set(dirty.keys())
  }

  #project(table: string, rowId: string): void {
    const def = this.#schema[table]
    if (!def) return
    const cells = this.#db.all<{ col: string; value: string; hlc: string }>(
      'SELECT col, value, hlc FROM anodb_cells WHERE tbl = ? AND row_id = ?',
      [table, rowId],
    )
    const values = new Map<string, unknown>()
    let maxHlc = ''
    for (const c of cells) {
      values.set(c.col, JSON.parse(c.value))
      if (c.hlc > maxHlc) maxHlc = c.hlc
    }
    if (values.get(SYS_DELETED) === true || cells.length === 0) {
      this.#db.run(`DELETE FROM ${quoteIdent(table)} WHERE id = ?`, [rowId])
      return
    }
    const cols = Object.keys(def)
    const created = values.get(SYS_CREATED)
    const params: SqlValue[] = [
      rowId,
      ...cols.map((c) => toSql(def[c]!, values.get(c))),
      typeof created === 'number' ? created : null,
      decodeHlc(maxHlc).millis,
    ]
    const names = ['id', ...cols, 'createdAt', 'updatedAt'].map(quoteIdent).join(', ')
    this.#db.run(
      `INSERT OR REPLACE INTO ${quoteIdent(table)} (${names}) VALUES (${params.map(() => '?').join(', ')})`,
      params,
    )
  }

  // ---- event bookkeeping -------------------------------------------------

  hasEvent(id: string): boolean {
    return this.#db.all('SELECT 1 FROM anodb_events WHERE id = ?', [id]).length > 0
  }

  markEvent(id: string, createdAt: number): void {
    this.#db.run('INSERT OR IGNORE INTO anodb_events (id, created_at) VALUES (?, ?)', [id, createdAt])
  }

  enqueue(event: NostrEvent): void {
    this.#db.run('INSERT OR IGNORE INTO anodb_outbox (id, event, queued_at) VALUES (?, ?, ?)', [
      event.id,
      JSON.stringify(event),
      Date.now(),
    ])
  }

  outbox(): Array<{ entryId: string; event: NostrEvent; acks: Map<string, AckStatus> }> {
    const rows = this.#db.all<{ id: string; event: string }>('SELECT id, event FROM anodb_outbox ORDER BY queued_at, id')
    const acks = this.#db.all<{ event_id: string; relay: string; status: AckStatus }>(
      'SELECT event_id, relay, status FROM anodb_acks',
    )
    const byEvent = new Map<string, Map<string, AckStatus>>()
    for (const a of acks) {
      let m = byEvent.get(a.event_id)
      if (!m) byEvent.set(a.event_id, (m = new Map()))
      m.set(a.relay, a.status)
    }
    return rows.map((r) => ({ entryId: r.id, event: JSON.parse(r.event) as NostrEvent, acks: byEvent.get(r.id) ?? new Map() }))
  }

  /** Replace the signed event of an outbox entry (re-signed with a fresh created_at). */
  replaceOutboxEvent(entryId: string, event: NostrEvent): void {
    this.#db.run('UPDATE anodb_outbox SET event = ? WHERE id = ?', [JSON.stringify(event), entryId])
  }

  /** Forget relay rejections so the next flush retries those relays. */
  clearRejections(): void {
    this.#db.run("DELETE FROM anodb_acks WHERE status = 'rejected'")
  }

  outboxSize(): number {
    return this.#db.all<{ n: number }>('SELECT COUNT(*) AS n FROM anodb_outbox')[0]!.n
  }

  recordAck(eventId: string, relay: string, status: AckStatus, message: string): void {
    this.#db.run(
      `INSERT INTO anodb_acks (event_id, relay, status, message) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, relay) DO UPDATE SET status = excluded.status, message = excluded.message`,
      [eventId, relay, status, message],
    )
  }

  dequeue(eventId: string): void {
    this.transaction(() => {
      this.#db.run('DELETE FROM anodb_outbox WHERE id = ?', [eventId])
      this.#db.run('DELETE FROM anodb_acks WHERE event_id = ?', [eventId])
    })
  }

  getCursor(relay: string): number | undefined {
    return this.#db.all<{ since: number }>('SELECT since FROM anodb_cursors WHERE relay = ?', [relay])[0]?.since
  }

  advanceCursor(relay: string, createdAt: number): void {
    this.#db.run(
      `INSERT INTO anodb_cursors (relay, since) VALUES (?, ?)
       ON CONFLICT(relay) DO UPDATE SET since = MAX(since, excluded.since)`,
      [relay, createdAt],
    )
  }

  resetCursors(): void {
    this.#db.run('DELETE FROM anodb_cursors')
  }

  // ---- public (replaceable) event cache ---------------------------------

  getPublic(pubkey: string, kind: number): { event: NostrEvent; fetchedAt: number } | undefined {
    const row = this.#db.all<{ event: string; fetched_at: number }>(
      'SELECT event, fetched_at FROM anodb_public WHERE pubkey = ? AND kind = ?',
      [pubkey, kind],
    )[0]
    return row && { event: JSON.parse(row.event) as NostrEvent, fetchedAt: row.fetched_at }
  }

  /** Store if newer than what we have (NIP-01 replaceable semantics). Always refreshes fetched_at. */
  putPublic(event: NostrEvent | undefined, pubkey: string, kind: number, fetchedAt: number): void {
    const existing = this.getPublic(pubkey, kind)
    const newer =
      event &&
      (!existing ||
        event.created_at > existing.event.created_at ||
        (event.created_at === existing.event.created_at && event.id < existing.event.id))
    if (newer) {
      this.#db.run(
        `INSERT INTO anodb_public (pubkey, kind, event, created_at, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pubkey, kind) DO UPDATE SET event = excluded.event, created_at = excluded.created_at, fetched_at = excluded.fetched_at`,
        [pubkey, kind, JSON.stringify(event), event.created_at, fetchedAt],
      )
    } else if (existing) {
      this.#db.run('UPDATE anodb_public SET fetched_at = ? WHERE pubkey = ? AND kind = ?', [fetchedAt, pubkey, kind])
    }
  }
}
