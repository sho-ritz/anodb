import { BACKFILL_PAGE, CURSOR_SKEW_SEC, DEFAULT_RELAYS, RESIGN_AFTER_SEC } from './defaults.js'
import { OwnerKey, type SecretKeyInput, namespaceTag, newRowId, parseSecretKey, randomHex, verifySignedEvent } from './crypto.js'
import { Clock } from './hlc.js'
import { CHANGE_KIND, type Change, NAMESPACE_TAG, decodePayload, encodePayload, splitChanges } from './protocol.js'
import { PublicData } from './public.js'
import { type Filter, RelayPool, type RelayPoolOptions } from './relay-pool.js'
import { SYS_CREATED, SYS_DELETED, checkValue, fromSql, quoteIdent, validateSchema } from './schema.js'
import { Store } from './store.js'
import type {
  FindOptions,
  NostrEvent,
  Row,
  SchemaDefinition,
  SqlValue,
  SqliteDriver,
  SyncStatus,
  Writable,
} from './types.js'

export interface AnoDBOptions<S extends SchemaDefinition> {
  /** Application namespace. Different appIds never see each other's data, even with the same key. */
  appId: string
  schema: S
  driver: SqliteDriver
  /** Relays to sync through. `[]` = local only. Defaults to `DEFAULT_RELAYS`. */
  relays?: readonly string[]
  /** Relays used to discover other users' NIP-65 relay lists and profiles. */
  discoveryRelays?: readonly string[]
  /**
   * Owner key (bytes, hex or nsec). If omitted, a key stored in the database is used, or a new one
   * is generated and stored. Use the same key on every device of the same owner.
   */
  secretKey?: SecretKeyInput
  /** A write leaves the outbox after this many relays accepted it. Default: min(2, relays.length). */
  minAcks?: number
  /** How often to retry the outbox while events are pending. Default 30s. */
  retryIntervalMs?: number
  relayOptions?: RelayPoolOptions
  /** Wall clock in ms. For tests. */
  now?: () => number
}

export type ChangeListener = (tables: ReadonlySet<string>, origin: 'local' | 'remote') => void
export type ErrorListener = (error: AnoDBError) => void
export type StatusListener = (status: SyncStatus) => void

export class AnoDBError extends Error {
  readonly code: 'publish-rejected' | 'invalid-event' | 'unsupported-protocol' | 'decrypt-failed'
  readonly eventId: string | undefined
  constructor(code: AnoDBError['code'], message: string, eventId?: string) {
    super(message)
    this.name = 'AnoDBError'
    this.code = code
    this.eventId = eventId
  }
}

type TableName<S> = Extract<keyof S, string>

/** Write handle passed to `db.transaction`. All writes in one transaction are committed atomically locally. */
export interface Transaction<S extends SchemaDefinition> {
  insert<T extends TableName<S>>(table: T, values: Writable<S[T]>, opts?: { id?: string }): string
  update<T extends TableName<S>>(table: T, id: string, values: Writable<S[T]>): void
  delete<T extends TableName<S>>(table: T, id: string): void
}

/** Convenience handle bound to one table. */
export interface TableHandle<S extends SchemaDefinition, T extends TableName<S>> {
  insert(values: Writable<S[T]>, opts?: { id?: string }): string
  update(id: string, values: Writable<S[T]>): void
  delete(id: string): void
  findMany(opts?: FindOptions<S[T]>): Row<S[T]>[]
  findById(id: string): Row<S[T]> | undefined
  count(opts?: Pick<FindOptions<S[T]>, 'where'>): number
  subscribe(opts: FindOptions<S[T]>, cb: (rows: Row<S[T]>[]) => void): () => void
}

interface RelaySyncState {
  /** `since` used in the current REQ. */
  reqSince: number
  /** Oldest / newest created_at received in the initial batch of the current REQ. */
  oldest: number | null
  newest: number | null
  caughtUp: boolean
}

export function createAnoDB<const S extends SchemaDefinition>(opts: AnoDBOptions<S>): AnoDB<S> {
  return new AnoDB(opts)
}

export class AnoDB<S extends SchemaDefinition> {
  readonly appId: string
  readonly schema: S
  readonly pubkey: string
  readonly npub: string
  /** Public Nostr data: profiles, notes, relay lists (interoperable with other Nostr clients). */
  readonly nostr: PublicData

  readonly #store: Store
  readonly #key: OwnerKey
  readonly #clock: Clock
  readonly #ns: string
  readonly #pool: RelayPool | null
  readonly #minAcks: number
  readonly #now: () => number
  readonly #relayState = new Map<string, RelaySyncState>()
  readonly #changeListeners = new Set<ChangeListener>()
  readonly #errorListeners = new Set<ErrorListener>()
  readonly #statusListeners = new Set<StatusListener>()
  #flushing: Promise<void> | null = null
  #flushAgain = false
  #retryTimer: ReturnType<typeof setInterval> | null = null
  #unsubscribe: (() => void) | null = null
  #closed = false
  #lastStatus = ''

  constructor(opts: AnoDBOptions<S>) {
    if (!opts.appId) throw new Error('anoDB: appId is required')
    validateSchema(opts.schema)
    this.appId = opts.appId
    this.schema = opts.schema
    this.#now = opts.now ?? Date.now
    this.#store = new Store(opts.driver)

    let secret: Uint8Array
    if (opts.secretKey !== undefined) {
      secret = parseSecretKey(opts.secretKey)
      const stored = this.#store.getMeta('owner_pubkey')
      const key = new OwnerKey(secret)
      if (stored && stored !== key.pubkey) {
        throw new Error('anoDB: this database belongs to a different owner key')
      }
    } else {
      const stored = this.#store.getMeta('owner_secret')
      secret = stored ? parseSecretKey(stored) : OwnerKey.generate().secret
    }
    this.#key = new OwnerKey(secret)
    this.pubkey = this.#key.pubkey
    this.npub = this.#key.npub
    this.#ns = namespaceTag(this.appId, this.pubkey)

    let nodeId = this.#store.getMeta('node_id')
    if (!nodeId) nodeId = randomHex(8)
    this.#clock = new Clock(nodeId, this.#store.getMeta('hlc'), this.#now)
    this.#store.transaction(() => {
      this.#store.setMeta('node_id', nodeId)
      this.#store.setMeta('owner_pubkey', this.pubkey)
      if (opts.secretKey === undefined) this.#store.setMeta('owner_secret', this.#key.hex)
    })
    this.#store.applySchema(this.schema)

    const relays = opts.relays ?? DEFAULT_RELAYS
    this.#minAcks = Math.max(1, Math.min(opts.minAcks ?? 2, relays.length))
    this.#pool = relays.length > 0 ? new RelayPool(relays, opts.relayOptions) : null
    this.nostr = new PublicData({
      store: this.#store,
      key: this.#key,
      pool: this.#pool,
      discoveryRelays: opts.discoveryRelays,
      now: this.#now,
      enqueue: (event) => this.#enqueuePublic(event),
    })

    if (this.#pool) {
      const pool = this.#pool
      pool.onOpen(() => {
        this.#emitStatus()
        void this.#flush()
      })
      pool.onClose((relay) => {
        this.#relayState.delete(relay)
        this.#emitStatus()
      })
      this.#startSubscription()
      pool.connect()
      const interval = opts.retryIntervalMs ?? 30_000
      this.#retryTimer = setInterval(() => {
        if (this.#store.outboxSize() > 0) void this.#flush()
      }, interval)
      ;(this.#retryTimer as { unref?: () => void }).unref?.()
    }
  }

  // ---- identity ------------------------------------------------------------

  /** The owner secret as `nsec1…`. Import it on another device to sync the same data. */
  exportSecretKey(): string {
    return this.#key.nsec
  }

  // ---- writes --------------------------------------------------------------

  transaction(fn: (tx: Transaction<S>) => void): void {
    this.#assertOpen()
    const changes: Change[] = []
    const tx: Transaction<S> = {
      insert: (table, values, o) => {
        const id = o?.id ?? newRowId()
        this.#collect(changes, table, id, values)
        changes.push([table, id, SYS_CREATED, this.#now(), this.#clock.tick()])
        return id
      },
      update: (table, id, values) => this.#collect(changes, table, id, values),
      delete: (table, id) => {
        this.#tableDef(table)
        changes.push([table, id, SYS_DELETED, true, this.#clock.tick()])
      },
    }
    fn(tx)
    if (changes.length === 0) return
    this.#commit(changes)
  }

  table<T extends TableName<S>>(table: T): TableHandle<S, T> {
    this.#tableDef(table)
    return {
      insert: (values, o) => {
        let id = ''
        this.transaction((tx) => {
          id = tx.insert(table, values, o)
        })
        return id
      },
      update: (id, values) => this.transaction((tx) => tx.update(table, id, values)),
      delete: (id) => this.transaction((tx) => tx.delete(table, id)),
      findMany: (o) => this.findMany(table, o),
      findById: (id) => this.findMany(table, { where: { id } as NonNullable<FindOptions<S[T]>['where']>, limit: 1 })[0],
      count: (o) => this.count(table, o),
      subscribe: (o, cb) => this.subscribe(table, o, cb),
    }
  }

  #tableDef(table: string) {
    const def = this.schema[table]
    if (!def) throw new Error(`anoDB: unknown table "${table}"`)
    return def
  }

  #collect(changes: Change[], table: string, id: string, values: Record<string, unknown>): void {
    const def = this.#tableDef(table)
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new Error('anoDB: invalid row id')
    for (const [column, value] of Object.entries(values)) {
      if (value === undefined) continue
      const type = def[column]
      if (!type) throw new Error(`anoDB: unknown column "${table}.${column}"`)
      changes.push([table, id, column, checkValue(table, column, type, value), this.#clock.tick()])
    }
  }

  #commit(changes: Change[]): void {
    const batches = splitChanges(changes)
    const createdAt = Math.floor(this.#now() / 1000)
    const events = batches.map((batch) =>
      this.#key.sign({
        kind: CHANGE_KIND,
        created_at: createdAt,
        tags: [[NAMESPACE_TAG, this.#ns]],
        content: this.#key.encryptToSelf(encodePayload(batch)),
      }),
    )
    const tables = this.#store.transaction(() => {
      const touched = this.#store.applyChanges(changes)
      this.#store.setMeta('hlc', this.#clock.current())
      for (const e of events) {
        this.#store.markEvent(e.id, e.created_at)
        if (this.#pool) this.#store.enqueue(e)
      }
      return touched
    })
    this.#notify(tables, 'local')
    if (this.#pool) {
      this.#emitStatus()
      void this.#flush()
    }
  }

  // ---- reads ---------------------------------------------------------------

  findMany<T extends TableName<S>>(table: T, opts: FindOptions<S[T]> = {}): Row<S[T]>[] {
    this.#assertOpen()
    const def = this.#tableDef(table)
    const { clause, params } = this.#where(table, opts.where)
    let sql = `SELECT * FROM ${quoteIdent(table)}${clause}`
    const order = Object.entries(opts.orderBy ?? {})
    if (order.length > 0) {
      sql += ` ORDER BY ${order
        .map(([col, dir]) => {
          this.#assertColumn(table, col)
          return `${quoteIdent(col)} ${dir === 'desc' ? 'DESC' : 'ASC'}`
        })
        .join(', ')}`
    }
    if (opts.limit !== undefined || opts.offset !== undefined) {
      sql += ' LIMIT ? OFFSET ?'
      params.push(opts.limit ?? -1, opts.offset ?? 0)
    }
    const rows = this.#store.driver.all<Record<string, SqlValue>>(sql, params)
    return rows.map((r) => {
      const out: Record<string, unknown> = { id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt }
      for (const [col, type] of Object.entries(def)) out[col] = fromSql(type, r[col] ?? null)
      return out as Row<S[T]>
    })
  }

  count<T extends TableName<S>>(table: T, opts: Pick<FindOptions<S[T]>, 'where'> = {}): number {
    this.#assertOpen()
    const { clause, params } = this.#where(table, opts.where)
    return this.#store.driver.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${clause}`, params)[0]!.n
  }

  /** Read-only SQL over the local projection (`SELECT` / `WITH` only). Tables are named after the schema. */
  sql<R = Record<string, SqlValue>>(query: string, params: readonly SqlValue[] = []): R[] {
    this.#assertOpen()
    if (!/^\s*(select|with)\b/i.test(query)) throw new Error('anoDB: db.sql() is read-only; use table writes')
    return this.#store.driver.all<R>(query, params)
  }

  /** Calls `cb` now and whenever `table` changes (locally or from sync). */
  subscribe<T extends TableName<S>>(table: T, opts: FindOptions<S[T]>, cb: (rows: Row<S[T]>[]) => void): () => void {
    const run = () => cb(this.findMany(table, opts))
    const listener: ChangeListener = (tables) => {
      if (tables.has(table)) run()
    }
    this.#changeListeners.add(listener)
    run()
    return () => this.#changeListeners.delete(listener)
  }

  #assertColumn(table: string, col: string): void {
    if (col === 'id' || col === 'createdAt' || col === 'updatedAt') return
    if (!(col in this.#tableDef(table))) throw new Error(`anoDB: unknown column "${table}.${col}"`)
  }

  #where(table: string, where: Record<string, unknown> | undefined): { clause: string; params: SqlValue[] } {
    const def = this.#tableDef(table)
    const parts: string[] = []
    const params: SqlValue[] = []
    for (const [col, value] of Object.entries(where ?? {})) {
      if (value === undefined) continue
      this.#assertColumn(table, col)
      if (value === null) {
        parts.push(`${quoteIdent(col)} IS NULL`)
        continue
      }
      const type = def[col]
      parts.push(`${quoteIdent(col)} = ?`)
      if (type === 'boolean') params.push(value ? 1 : 0)
      else if (type === 'json') params.push(JSON.stringify(value))
      else params.push(value as SqlValue)
    }
    return { clause: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params }
  }

  // ---- events & status -------------------------------------------------------

  onChange(fn: ChangeListener): () => void {
    this.#changeListeners.add(fn)
    return () => this.#changeListeners.delete(fn)
  }

  onError(fn: ErrorListener): () => void {
    this.#errorListeners.add(fn)
    return () => this.#errorListeners.delete(fn)
  }

  onStatus(fn: StatusListener): () => void {
    this.#statusListeners.add(fn)
    fn(this.status)
    return () => this.#statusListeners.delete(fn)
  }

  get status(): SyncStatus {
    const connectedRelays = this.#pool?.connected() ?? []
    const pendingEvents = this.#store.outboxSize()
    let state: SyncStatus['state']
    if (connectedRelays.length === 0) state = 'offline'
    else if (pendingEvents > 0 || connectedRelays.some((r) => !this.#relayState.get(r)?.caughtUp)) state = 'syncing'
    else state = 'synced'
    return { state, connectedRelays, pendingEvents }
  }

  /** Resolves once every connected relay has been caught up and the outbox is flushed (or `timeoutMs`). */
  async waitForSync(timeoutMs = 10_000): Promise<SyncStatus> {
    const deadline = this.#now() + timeoutMs
    for (;;) {
      const s = this.status
      if (s.state === 'synced' || Date.now() >= deadline) return s
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** Retry relays that rejected pending events and flush the outbox now. */
  async sync(): Promise<void> {
    this.#store.clearRejections()
    await this.#flush()
  }

  // ---- receive path ------------------------------------------------------------

  #filtersFor(relay: string): Filter[] {
    const cursor = this.#store.getCursor(relay)
    const since = cursor === undefined ? 0 : Math.max(0, cursor - CURSOR_SKEW_SEC)
    this.#relayState.set(relay, { reqSince: since, oldest: null, newest: null, caughtUp: false })
    const filter: Filter = { kinds: [CHANGE_KIND], authors: [this.pubkey], [`#${NAMESPACE_TAG}`]: [this.#ns] }
    if (since > 0) filter.since = since
    return [filter]
  }

  #onRelayEvent(relay: string, event: NostrEvent): void {
    if (this.#closed) return
    const state = this.#relayState.get(relay)
    if (this.#ingest(event) === 'invalid') return
    if (state && !state.caughtUp) {
      state.oldest = state.oldest === null ? event.created_at : Math.min(state.oldest, event.created_at)
      state.newest = state.newest === null ? event.created_at : Math.max(state.newest, event.created_at)
    } else {
      this.#store.advanceCursor(relay, event.created_at)
    }
  }

  /** Validate, decrypt and merge one change event. */
  #ingest(event: NostrEvent): 'new' | 'seen' | 'invalid' {
    if (
      event.kind !== CHANGE_KIND ||
      event.pubkey !== this.pubkey ||
      !event.tags.some((t) => t[0] === NAMESPACE_TAG && t[1] === this.#ns)
    ) {
      return 'invalid'
    }
    if (this.#store.hasEvent(event.id)) return 'seen'
    if (event.content.length > 200_000 || !verifySignedEvent(event)) {
      this.#error('invalid-event', 'event failed signature or size check', event.id)
      return 'invalid'
    }
    let plaintext: string
    try {
      plaintext = this.#key.decryptFromSelf(event.content)
    } catch {
      this.#error('decrypt-failed', 'could not decrypt change event', event.id)
      return 'invalid'
    }
    const payload = decodePayload(plaintext)
    if (!payload) {
      // Not marked as seen: a future version of anoDB may understand it after `resync`.
      this.#error('unsupported-protocol', 'change event has an unknown format or newer protocol version', event.id)
      return 'invalid'
    }
    let maxHlc = ''
    for (const c of payload.changes) if (c[4] > maxHlc) maxHlc = c[4]
    if (maxHlc) this.#clock.receive(maxHlc)
    const tables = this.#store.transaction(() => {
      const touched = this.#store.applyChanges(payload.changes)
      this.#store.markEvent(event.id, event.created_at)
      this.#store.setMeta('hlc', this.#clock.current())
      return touched
    })
    this.#notify(tables, 'remote')
    return 'new'
  }

  /**
   * Initial batch of a REQ finished. Relays cap how many stored events they return, so page
   * backwards with `until` until a page brings nothing new, then advance the cursor.
   */
  async #onEose(relay: string): Promise<void> {
    const state = this.#relayState.get(relay)
    if (!state || state.caughtUp || !this.#pool) return
    let until = state.oldest
    let newest = state.newest
    while (until !== null && !this.#closed) {
      const filter: Filter = {
        kinds: [CHANGE_KIND],
        authors: [this.pubkey],
        [`#${NAMESPACE_TAG}`]: [this.#ns],
        until,
        limit: BACKFILL_PAGE,
      }
      if (state.reqSince > 0) filter.since = state.reqSince
      const page = await this.#pool.query([filter], { relays: [relay] })
      let fresh = 0
      let oldest: number | null = null
      for (const e of page) {
        if (this.#ingest(e) === 'new') fresh++
        oldest = oldest === null ? e.created_at : Math.min(oldest, e.created_at)
        newest = newest === null ? e.created_at : Math.max(newest, e.created_at)
      }
      if (oldest === null) break
      if (fresh > 0) until = oldest
      else if (oldest === until) {
        // The whole page is one already-seen second: the relay's limit is saturated by that second.
        // NIP-01 cannot page inside a second, so skip it and continue with older events.
        until -= 1
        if (until < state.reqSince) break
      } else break
    }
    if (this.#relayState.get(relay) !== state) return // reconnected meanwhile
    if (newest !== null) this.#store.advanceCursor(relay, newest)
    state.caughtUp = true
    this.#emitStatus()
  }

  /** Forget sync cursors and re-download everything from relays (idempotent merge). */
  resync(): void {
    this.#store.resetCursors()
    this.#store.driver.run('DELETE FROM anodb_events')
    this.#unsubscribe?.()
    this.#startSubscription()
    this.#emitStatus()
  }

  #startSubscription(): void {
    if (!this.#pool) return
    this.#unsubscribe = this.#pool.subscribe((relay) => this.#filtersFor(relay), {
      onEvent: (relay, event) => this.#onRelayEvent(relay, event),
      onEose: (relay) => void this.#onEose(relay),
    })
  }

  // ---- outbox ------------------------------------------------------------------

  #enqueuePublic(event: NostrEvent): void {
    this.#assertOpen()
    if (!this.#pool) throw new Error('anoDB: no relays configured')
    this.#store.enqueue(event)
    this.#emitStatus()
    void this.#flush()
  }

  #flush(): Promise<void> {
    if (this.#flushing) {
      this.#flushAgain = true
      return this.#flushing
    }
    this.#flushing = (async () => {
      try {
        do {
          this.#flushAgain = false
          await this.#flushOnce()
        } while (this.#flushAgain && !this.#closed)
      } finally {
        this.#flushing = null
        this.#emitStatus()
      }
    })()
    return this.#flushing
  }

  async #flushOnce(): Promise<void> {
    const pool = this.#pool
    if (!pool || this.#closed) return
    const connected = new Set(pool.connected())
    if (connected.size === 0) return
    await Promise.all(
      this.#store.outbox().map(async ({ entryId, event, acks }) => {
        const targets = pool.relays.filter((r) => connected.has(r) && !acks.has(r))
        if (targets.length === 0) return
        let toSend = event
        const nowSec = Math.floor(this.#now() / 1000)
        if (event.kind === CHANGE_KIND && nowSec - event.created_at > RESIGN_AFTER_SEC) {
          // Offline writes: give the event a fresh created_at so `since` cursors on other devices see it.
          toSend = this.#key.sign({ kind: event.kind, tags: event.tags, content: event.content, created_at: nowSec })
          this.#store.transaction(() => {
            this.#store.replaceOutboxEvent(entryId, toSend)
            this.#store.markEvent(toSend.id, toSend.created_at)
          })
        }
        const results = await pool.publish(toSend, targets)
        if (this.#closed) return
        for (const [relay, r] of results) {
          if (r.outcome === 'ok' || r.outcome === 'rejected') {
            acks.set(relay, r.outcome)
            this.#store.recordAck(entryId, relay, r.outcome, r.message)
          }
        }
        const ok = [...acks.values()].filter((s) => s === 'ok').length
        if (ok >= this.#minAcks || (ok > 0 && acks.size === pool.relays.length)) {
          this.#store.dequeue(entryId)
        } else if (acks.size === pool.relays.length) {
          this.#error('publish-rejected', `every relay rejected event ${entryId}; call db.sync() to retry`, entryId)
        }
      }),
    )
  }

  // ---- misc ------------------------------------------------------------------

  #notify(tables: ReadonlySet<string>, origin: 'local' | 'remote'): void {
    if (tables.size === 0) return
    for (const fn of [...this.#changeListeners]) fn(tables, origin)
  }

  #error(code: AnoDBError['code'], message: string, eventId?: string): void {
    const err = new AnoDBError(code, message, eventId)
    for (const fn of this.#errorListeners) fn(err)
  }

  #emitStatus(): void {
    if (this.#closed) return
    const s = this.status
    const key = JSON.stringify(s)
    if (key === this.#lastStatus) return
    this.#lastStatus = key
    for (const fn of this.#statusListeners) fn(s)
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('anoDB: database is closed')
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#retryTimer) clearInterval(this.#retryTimer)
    this.#pool?.close()
    this.#changeListeners.clear()
    this.#statusListeners.clear()
    this.#store.driver.close()
  }
}
