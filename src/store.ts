import { decodeHlc } from './hlc.js'
import type { Change } from './protocol.js'
import { PUBLIC_SPACE, presetOf } from './public-tables.js'
import { SYS_CREATED, SYS_DELETED, createTableSql, ownerOfRow, quoteIdent, tableFingerprint, toSql } from './schema.js'
import type { NostrEvent, SchemaDefinition, SqlValue, SqliteDriver } from './types.js'

const INTERNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS anodb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, personal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anodb_keys (
  space TEXT NOT NULL, key_id TEXT NOT NULL, num INTEGER NOT NULL, sealed BLOB NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (space, key_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_messages (
  space TEXT NOT NULL, device TEXT NOT NULL, seq INTEGER NOT NULL, identity TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, msg_id TEXT NOT NULL, inner TEXT NOT NULL DEFAULT '', received_at INTEGER NOT NULL,
  PRIMARY KEY (space, device, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS anodb_messages_type ON anodb_messages (space, type);
CREATE TABLE IF NOT EXISTS anodb_prune (event_id TEXT PRIMARY KEY, salt TEXT NOT NULL, tag TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_devices (
  device TEXT PRIMARY KEY, identity TEXT NOT NULL, delegation TEXT NOT NULL, name TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS anodb_invites_out (secret TEXT PRIMARY KEY, space TEXT NOT NULL, role TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS anodb_invites_in (space TEXT PRIMARY KEY, sender TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, received_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS anodb_join_requests (
  id TEXT PRIMARY KEY, secret TEXT NOT NULL, identity TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anodb_cells (
  space TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL, col TEXT NOT NULL, value TEXT NOT NULL, hlc TEXT NOT NULL,
  PRIMARY KEY (space, tbl, row_id, col)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_raw (id TEXT PRIMARY KEY, tag TEXT NOT NULL, created_at INTEGER NOT NULL, event TEXT NOT NULL, relay INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS anodb_raw_tag ON anodb_raw (tag, created_at);
CREATE TABLE IF NOT EXISTS anodb_outbox (id TEXT PRIMARY KEY, event TEXT NOT NULL, queued_at INTEGER NOT NULL, resign INTEGER NOT NULL, hold_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS anodb_acks (
  event_id TEXT NOT NULL, relay TEXT NOT NULL, status TEXT NOT NULL, message TEXT,
  PRIMARY KEY (event_id, relay)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_cursors (relay TEXT NOT NULL, tag TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (relay, tag)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS anodb_public (
  pubkey TEXT NOT NULL, kind INTEGER NOT NULL, event TEXT NOT NULL, created_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, kind)
) WITHOUT ROWID;
`

export type AckStatus = 'ok' | 'rejected'

export interface StoredMessage {
  space: string
  device: string
  seq: number
  identity: string
  type: string
  payload: string
}

/**
 * Local persistence. `anodb_cells` holds one LWW register per (space, table, row, column);
 * user tables are disposable projections rebuilt from cells. `anodb_messages` keeps every
 * accepted message so a space can be re-evaluated when its membership changes.
 */
export class Store {
  readonly #db: SqliteDriver
  #schema: SchemaDefinition = {}
  #depth = 0

  #closed = false

  constructor(db: SqliteDriver) {
    // Background work (sync, reconciliation, timers) may still finish after close(): turn every
    // later call into a no-op instead of an error from a closed SQLite handle.
    this.#db = {
      exec: (sql) => {
        if (!this.#closed) db.exec(sql)
      },
      run: (sql, params) => {
        if (!this.#closed) db.run(sql, params)
      },
      all: <T>(sql: string, params?: readonly SqlValue[]) => (this.#closed ? [] : db.all<T>(sql, params)),
      close: () => {
        if (this.#closed) return
        this.#closed = true
        db.close()
      },
    }
    this.#db.exec(INTERNAL_SCHEMA)
    this.#ensureColumn('anodb_raw', 'relay', 'INTEGER NOT NULL DEFAULT 1')
    this.#ensureColumn('anodb_outbox', 'hold_until', 'INTEGER NOT NULL DEFAULT 0')
    this.#ensureColumn('anodb_messages', 'inner', "TEXT NOT NULL DEFAULT ''")
    // identity whose signed change set the cell (null for cells from older versions)
    this.#ensureColumn('anodb_cells', 'by', 'TEXT')
  }

  /** Add a column created by a newer version (CREATE TABLE IF NOT EXISTS does not alter tables). */
  #ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.#db.all<{ name: string }>(`PRAGMA table_info(${table})`)
    if (!cols.some((c) => c.name === column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }

  get driver(): SqliteDriver {
    return this.#db
  }

  get schema(): SchemaDefinition {
    return this.#schema
  }

  get inTransaction(): boolean {
    return this.#depth > 0
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

  deleteMeta(key: string): void {
    this.#db.run('DELETE FROM anodb_meta WHERE key = ?', [key])
  }

  /** Next own sequence number for a space. */
  nextSeq(space: string): number {
    const key = `seq:${space}`
    const n = Number(this.getMeta(key) ?? '0') + 1
    this.setMeta(key, String(n))
    return n
  }

  // ---- schema / projections ------------------------------------------------

  applySchema(schema: SchemaDefinition, defaultSpace: string, owner?: string): void {
    this.#schema = schema
    this.transaction(() => {
      for (const [table, def] of Object.entries(schema)) {
        const preset = presetOf(def)
        const space = preset ? PUBLIC_SPACE : defaultSpace
        const fp = `${tableFingerprint(def)}|${space}|${preset ? preset.kind : ''}|${owner ?? ''}`
        const key = `schema:${table}`
        if (this.getMeta(key) === fp) continue
        this.#db.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`)
        this.#db.exec(createTableSql(table, def, space, preset ? undefined : owner))
        const rows = this.#db.all<{ space: string; row_id: string }>('SELECT DISTINCT space, row_id FROM anodb_cells WHERE tbl = ?', [table])
        for (const r of rows) this.#project(r.space, table, r.row_id)
        this.setMeta(key, fp)
      }
    })
  }

  /**
   * LWW merge. `by` is the identity that signed the changes (a snapshot cell may carry its own as a
   * 6th element). Returns tables whose visible state may have changed. Run inside `transaction`.
   */
  applyChanges(space: string, changes: readonly Change[], by?: string): Set<string> {
    const dirty = new Map<string, Set<string>>()
    for (const c of changes) {
      const [table, rowId, column, value, hlc] = c
      const cellBy = (c as readonly unknown[])[5]
      const writer = typeof cellBy === 'string' && /^[0-9a-f]{64}$/.test(cellBy) ? cellBy : (by ?? null)
      const current = this.#db.all<{ hlc: string }>(
        'SELECT hlc FROM anodb_cells WHERE space = ? AND tbl = ? AND row_id = ? AND col = ?',
        [space, table, rowId, column],
      )[0]
      if (current && current.hlc >= hlc) continue
      this.#db.run(
        `INSERT INTO anodb_cells (space, tbl, row_id, col, value, hlc, by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(space, tbl, row_id, col) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, by = excluded.by`,
        [space, table, rowId, column, JSON.stringify(value ?? null), hlc, writer],
      )
      let rows = dirty.get(table)
      if (!rows) dirty.set(table, (rows = new Set()))
      rows.add(rowId)
    }
    for (const [table, rows] of dirty) {
      for (const rowId of rows) this.#project(space, table, rowId)
    }
    return new Set(dirty.keys())
  }

  /** All current cells of a space (for snapshots), with the signing identity as a 6th element when known. */
  cells(space: string): Change[] {
    return this.#db
      .all<{ tbl: string; row_id: string; col: string; value: string; hlc: string; by: string | null }>(
        'SELECT tbl, row_id, col, value, hlc, by FROM anodb_cells WHERE space = ? ORDER BY tbl, row_id, col',
        [space],
      )
      .map((c) => (c.by ? [c.tbl, c.row_id, c.col, JSON.parse(c.value), c.hlc, c.by] : [c.tbl, c.row_id, c.col, JSON.parse(c.value), c.hlc]) as unknown as Change)
  }

  /** Drop all cells of a space and its projected rows. Run inside `transaction`. */
  clearSpace(space: string): Set<string> {
    const tables = new Set(this.#db.all<{ tbl: string }>('SELECT DISTINCT tbl FROM anodb_cells WHERE space = ?', [space]).map((r) => r.tbl))
    this.#db.run('DELETE FROM anodb_cells WHERE space = ?', [space])
    for (const t of tables) if (t in this.#schema) this.#db.run(`DELETE FROM ${quoteIdent(t)} WHERE space = ?`, [space])
    return tables
  }

  #project(space: string, table: string, rowId: string): void {
    const def = this.#schema[table]
    if (!def) return // kept in cells; projected once the schema knows the table
    const cells = this.#db.all<{ col: string; value: string; hlc: string; by: string | null }>(
      'SELECT col, value, hlc, by FROM anodb_cells WHERE space = ? AND tbl = ? AND row_id = ?',
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
    if (values.get(SYS_DELETED) === true || cells.length === 0) {
      this.#db.run(`DELETE FROM ${quoteIdent(table)} WHERE space = ? AND id = ?`, [space, rowId])
      return
    }
    const cols = Object.keys(def)
    const created = values.get(SYS_CREATED)
    const params: SqlValue[] = [
      space,
      rowId,
      ...cols.map((c) => toSql(def[c]!, values.get(c))),
      typeof created === 'number' ? created : null,
      decodeHlc(maxHlc).millis,
      ownerOfRow(rowId),
      updatedBy,
    ]
    const names = ['space', 'id', ...cols, 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'].map(quoteIdent).join(', ')
    this.#db.run(`INSERT OR REPLACE INTO ${quoteIdent(table)} (${names}) VALUES (${params.map(() => '?').join(', ')})`, params)
  }

  // ---- spaces & keys -----------------------------------------------------------

  spaces(): Array<{ id: string; name: string; personal: boolean; status: string }> {
    return this.#db
      .all<{ id: string; name: string; personal: number; status: string }>('SELECT id, name, personal, status FROM anodb_spaces ORDER BY created_at, id')
      .map((r) => ({ ...r, personal: r.personal === 1 }))
  }

  upsertSpace(id: string, name: string, personal: boolean, status = 'active'): void {
    this.#db.run(
      `INSERT INTO anodb_spaces (id, name, personal, status, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status`,
      [id, name, personal ? 1 : 0, status, Date.now()],
    )
  }

  setSpaceStatus(id: string, status: string): void {
    this.#db.run('UPDATE anodb_spaces SET status = ? WHERE id = ?', [status, id])
  }

  putKey(space: string, keyId: string, num: number, sealed: Uint8Array): void {
    this.#db.run('INSERT OR IGNORE INTO anodb_keys (space, key_id, num, sealed, created_at) VALUES (?, ?, ?, ?, ?)', [
      space,
      keyId,
      num,
      sealed,
      Date.now(),
    ])
  }

  keys(): Array<{ space: string; keyId: string; num: number; sealed: Uint8Array; createdAt: number }> {
    return this.#db
      .all<{ space: string; key_id: string; num: number; sealed: Uint8Array; created_at: number }>(
        'SELECT space, key_id, num, sealed, created_at FROM anodb_keys',
      )
      .map((r) => ({ space: r.space, keyId: r.key_id, num: r.num, sealed: new Uint8Array(r.sealed), createdAt: r.created_at }))
  }

  // ---- message log ---------------------------------------------------------------

  hasMessage(space: string, device: string, seq: number): boolean {
    return this.#db.all('SELECT 1 FROM anodb_messages WHERE space = ? AND device = ? AND seq = ?', [space, device, seq]).length > 0
  }

  putMessage(m: StoredMessage, msgId: string, inner: string): void {
    this.#db.run(
      'INSERT OR IGNORE INTO anodb_messages (space, device, seq, identity, type, payload, msg_id, inner, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [m.space, m.device, m.seq, m.identity, m.type, m.payload, msgId, inner, Date.now()],
    )
  }

  /** Signed inner events of a message type (portable: verifiable by anyone). */
  inners(space: string, type: string): string[] {
    return this.#db.all<{ inner: string }>('SELECT inner FROM anodb_messages WHERE space = ? AND type = ? ORDER BY received_at, msg_id', [space, type]).map((r) => r.inner)
  }

  opRecords(space: string): Array<{ msgId: string; identity: string; payload: string }> {
    return this.#db.all<{ msgId: string; identity: string; payload: string }>(
      "SELECT msg_id AS msgId, identity, payload FROM anodb_messages WHERE space = ? AND type = 'op'",
      [space],
    )
  }

  /** Highest seq per device of one identity in a space (cut-offs for removal). */
  deviceMaxSeqs(space: string, identity?: string, device?: string): Record<string, number> {
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
    const rows = this.#db.all<{ device: string; m: number }>(`SELECT device, MAX(seq) AS m FROM anodb_messages WHERE ${where.join(' AND ')} GROUP BY device`, params)
    return Object.fromEntries(rows.map((r) => [r.device, r.m]))
  }

  countMessages(space: string, type: string, sinceReceived = 0): number {
    return this.#db.all<{ n: number }>('SELECT COUNT(*) AS n FROM anodb_messages WHERE space = ? AND type = ? AND received_at > ?', [space, type, sinceReceived])[0]?.n ?? 0
  }

  // ---- prunable envelopes (pruneOldEvents) ----------------------------------------

  putPrunable(eventId: string, salt: string, tag: string, createdAt: number): void {
    this.#db.run('INSERT OR IGNORE INTO anodb_prune (event_id, salt, tag, created_at) VALUES (?, ?, ?, ?)', [eventId, salt, tag, createdAt])
  }

  prunable(tags: readonly string[], before: number): Array<{ eventId: string; salt: string }> {
    if (tags.length === 0) return []
    return this.#db.all<{ eventId: string; salt: string }>(
      `SELECT event_id AS eventId, salt FROM anodb_prune WHERE created_at < ? AND tag IN (${tags.map(() => '?').join(',')})`,
      [before, ...tags],
    )
  }

  forgetPrunable(eventId: string): void {
    this.#db.run('DELETE FROM anodb_prune WHERE event_id = ?', [eventId])
  }

  // ---- public table rows ---------------------------------------------------------

  publicRows(table: string, where: string, params: readonly SqlValue[]): Array<Record<string, SqlValue>> {
    return this.#db.all(`SELECT * FROM ${quoteIdent(table)} WHERE space = '${PUBLIC_SPACE}' AND ${where}`, params)
  }

  putPublicRow(table: string, row: Record<string, SqlValue>): void {
    const cols = Object.keys(row)
    this.#db.run(
      `INSERT OR REPLACE INTO ${quoteIdent(table)} (space, ${cols.map(quoteIdent).join(', ')}) VALUES ('${PUBLIC_SPACE}', ${cols.map(() => '?').join(', ')})`,
      cols.map((c) => row[c] ?? null),
    )
  }

  deletePublicRows(table: string, where: string, params: readonly SqlValue[]): void {
    this.#db.run(`DELETE FROM ${quoteIdent(table)} WHERE space = '${PUBLIC_SPACE}' AND ${where}`, params)
  }

  // ---- devices -------------------------------------------------------------------

  putDevice(device: string, identity: string, delegation: string, name: string): void {
    this.#db.run('INSERT OR IGNORE INTO anodb_devices (device, identity, delegation, name) VALUES (?, ?, ?, ?)', [device, identity, delegation, name])
  }

  revokeDevice(device: string): void {
    this.#db.run('UPDATE anodb_devices SET revoked = 1 WHERE device = ?', [device])
  }

  devices(identity?: string): Array<{ device: string; identity: string; delegation: string; name: string; revoked: boolean }> {
    return this.#db
      .all<{ device: string; identity: string; delegation: string; name: string; revoked: number }>(
        `SELECT device, identity, delegation, name, revoked FROM anodb_devices${identity ? ' WHERE identity = ?' : ''} ORDER BY device`,
        identity ? [identity] : [],
      )
      .map((r) => ({ ...r, revoked: r.revoked === 1 }))
  }

  // ---- invitations ---------------------------------------------------------------

  putInviteOut(secret: string, space: string, role: string, expires: number): void {
    this.#db.run('INSERT INTO anodb_invites_out (secret, space, role, expires) VALUES (?, ?, ?, ?)', [secret, space, role, expires])
  }

  invitesOut(): Array<{ secret: string; space: string; role: string; expires: number; used: boolean }> {
    return this.#db
      .all<{ secret: string; space: string; role: string; expires: number; used: number }>('SELECT secret, space, role, expires, used FROM anodb_invites_out')
      .map((r) => ({ ...r, used: r.used === 1 }))
  }

  markInviteUsed(secret: string): void {
    this.#db.run('UPDATE anodb_invites_out SET used = 1 WHERE secret = ?', [secret])
  }

  putInviteIn(space: string, sender: string, role: string, name: string, payload: string): void {
    this.#db.run(
      `INSERT INTO anodb_invites_in (space, sender, role, name, payload, status, received_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(space) DO UPDATE SET sender = excluded.sender, role = excluded.role, name = excluded.name, payload = excluded.payload,
         status = CASE WHEN anodb_invites_in.status = 'accepted' THEN 'accepted' ELSE 'pending' END`,
      [space, sender, role, name, payload, Date.now()],
    )
  }

  invitesIn(status?: string): Array<{ space: string; sender: string; role: string; name: string; payload: string; status: string }> {
    return this.#db.all(
      `SELECT space, sender, role, name, payload, status FROM anodb_invites_in${status ? ' WHERE status = ?' : ''} ORDER BY received_at`,
      status ? [status] : [],
    )
  }

  setInviteInStatus(space: string, status: string): void {
    this.#db.run('UPDATE anodb_invites_in SET status = ? WHERE space = ?', [status, space])
  }

  putJoinRequest(id: string, secret: string, identity: string, payload: string): void {
    this.#db.run("INSERT OR IGNORE INTO anodb_join_requests (id, secret, identity, payload, status, received_at) VALUES (?, ?, ?, ?, 'pending', ?)", [
      id,
      secret,
      identity,
      payload,
      Date.now(),
    ])
  }

  joinRequests(status = 'pending'): Array<{ id: string; secret: string; identity: string; payload: string }> {
    return this.#db.all('SELECT id, secret, identity, payload FROM anodb_join_requests WHERE status = ? ORDER BY received_at', [status])
  }

  setJoinRequestStatus(id: string, status: string): void {
    this.#db.run('UPDATE anodb_join_requests SET status = ? WHERE id = ?', [status, id])
  }

  /** Forget all spaces and data (device pairing adopts another identity). Keeps node id and clock. */
  wipe(): void {
    this.transaction(() => {
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
        'anodb_invites_out',
        'anodb_invites_in',
        'anodb_join_requests',
      ]) {
        this.#db.run(`DELETE FROM ${t}`)
      }
      this.#db.run("DELETE FROM anodb_meta WHERE key LIKE 'seq:%' OR key LIKE 'schema:%' OR key LIKE 'snap:%'")
      for (const t of Object.keys(this.#schema)) this.#db.run(`DELETE FROM ${quoteIdent(t)}`)
    })
  }

  messages(space: string, type?: string): StoredMessage[] {
    const sql = `SELECT space, device, seq, identity, type, payload FROM anodb_messages WHERE space = ?${type ? ' AND type = ?' : ''} ORDER BY device, seq`
    return this.#db.all<StoredMessage>(sql, type ? [space, type] : [space])
  }

  /** Highest contiguous and highest seen seq per device (for gap detection). */
  seqRanges(space: string): Array<{ device: string; maxSeq: number; count: number }> {
    return this.#db.all<{ device: string; maxSeq: number; count: number }>(
      'SELECT device, MAX(seq) AS maxSeq, COUNT(*) AS count FROM anodb_messages WHERE space = ? GROUP BY device',
      [space],
    )
  }

  // ---- raw envelopes (for re-publishing and NIP-77) ------------------------------

  hasRaw(id: string): boolean {
    return this.#db.all('SELECT 1 FROM anodb_raw WHERE id = ?', [id]).length > 0
  }

  /** `viaRelay` = false for envelopes only exchanged peer-to-peer (not to be uploaded to relays). */
  putRaw(event: NostrEvent, tag: string, viaRelay = true): void {
    this.#db.run(
      `INSERT INTO anodb_raw (id, tag, created_at, event, relay) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET relay = MAX(relay, excluded.relay)`,
      [event.id, tag, event.created_at, JSON.stringify(event), viaRelay ? 1 : 0],
    )
  }

  markRawLocal(id: string): void {
    this.#db.run('UPDATE anodb_raw SET relay = 0 WHERE id = ?', [id])
  }

  rawIndex(tags: readonly string[]): Array<{ id: string; created_at: number }> {
    if (tags.length === 0) return []
    return this.#db.all<{ id: string; created_at: number }>(
      `SELECT id, created_at FROM anodb_raw WHERE relay = 1 AND tag IN (${tags.map(() => '?').join(',')})`,
      tags,
    )
  }

  getRaw(id: string): NostrEvent | undefined {
    const r = this.#db.all<{ event: string }>('SELECT event FROM anodb_raw WHERE id = ?', [id])[0]
    return r && (JSON.parse(r.event) as NostrEvent)
  }

  // ---- outbox --------------------------------------------------------------------

  enqueue(event: NostrEvent, resign: boolean, holdUntil = 0): void {
    this.#db.run('INSERT OR IGNORE INTO anodb_outbox (id, event, queued_at, resign, hold_until) VALUES (?, ?, ?, ?, ?)', [
      event.id,
      JSON.stringify(event),
      Date.now(),
      resign ? 1 : 0,
      holdUntil,
    ])
  }

  /** Release a held outbox entry so the next flush sends it to relays. */
  releaseOutbox(entryId: string): void {
    this.#db.run('UPDATE anodb_outbox SET hold_until = 0 WHERE id = ?', [entryId])
  }

  outbox(): Array<{ entryId: string; event: NostrEvent; resign: boolean; holdUntil: number; acks: Map<string, AckStatus> }> {
    const rows = this.#db.all<{ id: string; event: string; resign: number; hold_until: number }>(
      'SELECT id, event, resign, hold_until FROM anodb_outbox ORDER BY queued_at, id',
    )
    const acks = this.#db.all<{ event_id: string; relay: string; status: AckStatus }>('SELECT event_id, relay, status FROM anodb_acks')
    const byEvent = new Map<string, Map<string, AckStatus>>()
    for (const a of acks) {
      let m = byEvent.get(a.event_id)
      if (!m) byEvent.set(a.event_id, (m = new Map()))
      m.set(a.relay, a.status)
    }
    return rows.map((r) => ({
      entryId: r.id,
      event: JSON.parse(r.event) as NostrEvent,
      resign: r.resign === 1,
      holdUntil: r.hold_until,
      acks: byEvent.get(r.id) ?? new Map(),
    }))
  }

  replaceOutboxEvent(entryId: string, event: NostrEvent): void {
    this.#db.run('UPDATE anodb_outbox SET event = ? WHERE id = ?', [JSON.stringify(event), entryId])
  }

  clearRejections(): void {
    this.#db.run("DELETE FROM anodb_acks WHERE status = 'rejected'")
  }

  outboxSize(): number {
    return this.#db.all<{ n: number }>('SELECT COUNT(*) AS n FROM anodb_outbox')[0]?.n ?? 0
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

  // ---- cursors -------------------------------------------------------------------

  getCursor(relay: string, tag: string): number | undefined {
    return this.#db.all<{ since: number }>('SELECT since FROM anodb_cursors WHERE relay = ? AND tag = ?', [relay, tag])[0]?.since
  }

  advanceCursor(relay: string, tag: string, createdAt: number): void {
    this.#db.run(
      `INSERT INTO anodb_cursors (relay, tag, since) VALUES (?, ?, ?)
       ON CONFLICT(relay, tag) DO UPDATE SET since = MAX(since, excluded.since)`,
      [relay, tag, createdAt],
    )
  }

  resetCursors(): void {
    this.#db.run('DELETE FROM anodb_cursors')
  }

  // ---- public (replaceable) event cache ---------------------------------

  getPublic(pubkey: string, kind: number): { event: NostrEvent; fetchedAt: number } | undefined {
    const row = this.#db.all<{ event: string; fetched_at: number }>('SELECT event, fetched_at FROM anodb_public WHERE pubkey = ? AND kind = ?', [
      pubkey,
      kind,
    ])[0]
    return row && { event: JSON.parse(row.event) as NostrEvent, fetchedAt: row.fetched_at }
  }

  putPublic(event: NostrEvent | undefined, pubkey: string, kind: number, fetchedAt: number): void {
    const existing = this.getPublic(pubkey, kind)
    const newer =
      event &&
      (!existing || event.created_at > existing.event.created_at || (event.created_at === existing.event.created_at && event.id < existing.event.id))
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
