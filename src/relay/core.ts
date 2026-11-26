import { type Filter, matchFilters } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'
import { Negentropy } from '../sync/negentropy.js'
import type { NostrEvent } from '../types.js'

/**
 * A small Nostr relay (NIP-01, 09, 11, 77) for hosting your own anoDB relay. It is written against
 * the SQL interface of Cloudflare's SQLite-backed Durable Objects (`ctx.storage.sql`), so the same
 * code runs in the Worker (`worker.ts`) and, with a thin adapter, on node:sqlite.
 *
 * Subscriptions live in SQL too: a hibernated Durable Object loses its memory but keeps its
 * WebSockets, and must still deliver to them when it wakes up.
 */

/** `ctx.storage.sql` of a Durable Object (only what the relay uses). */
export interface RelaySql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] }
}

/** One client connection. `id` must stay the same for the life of the WebSocket. */
export interface RelayConn {
  readonly id: string
  send(message: string): void
}

export interface RelayOptions {
  /** Accepted event kinds; `null` accepts every kind. Default: the kinds anoDB uses. */
  kinds?: readonly number[] | null
  name?: string
  description?: string
  /** Largest accepted WebSocket message, in bytes. Default 256 KiB. */
  maxMessageBytes?: number
  /** Open subscriptions per connection. Default 50. */
  maxSubscriptions?: number
  /** Filters per REQ. Default 20. */
  maxFilters?: number
  /** Events returned per filter before EOSE. Default 500. */
  maxLimit?: number
  /** How far `created_at` may be in the future, in seconds. Default 15 minutes. */
  maxFutureSec?: number
  now?: () => number
}

/**
 * Kinds an anoDB app publishes: deletions (NIP-09), envelopes, delegations, key packages,
 * WebRTC signaling (nostr-p2p), ephemeral events, P2P proofs. Literals so the Worker bundle does
 * not pull in the client.
 */
export const ANODB_KINDS: readonly number[] = [5, 7303, 7304, 10304, 25050, 27303, 27305]

export const RELAY_SOFTWARE = 'https://github.com/sho-ritz/anodb'

const isEphemeral = (k: number) => k >= 20000 && k < 30000
const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000)
const isAddressable = (k: number) => k >= 30000 && k < 40000
const HEX64 = /^[0-9a-f]{64}$/
const dTag = (e: NostrEvent) => e.tags.find((t) => t[0] === 'd')?.[1] ?? ''

export class RelayCore {
  readonly #sql: RelaySql
  readonly #connections: () => Iterable<RelayConn>
  readonly #o: Required<Omit<RelayOptions, 'kinds'>> & { kinds: ReadonlySet<number> | null }
  /** Negentropy sessions are short-lived; losing them on hibernation only makes the client retry. */
  readonly #negs = new Map<string, Negentropy>()

  constructor(sql: RelaySql, connections: () => Iterable<RelayConn>, opts: RelayOptions = {}) {
    this.#sql = sql
    this.#connections = connections
    const kinds = opts.kinds === undefined ? ANODB_KINDS : opts.kinds
    this.#o = {
      kinds: kinds === null ? null : new Set(kinds),
      name: opts.name ?? 'anoDB relay',
      description: opts.description ?? 'Self-hosted Nostr relay for anoDB apps',
      maxMessageBytes: opts.maxMessageBytes ?? 256 * 1024,
      maxSubscriptions: opts.maxSubscriptions ?? 50,
      maxFilters: opts.maxFilters ?? 20,
      maxLimit: opts.maxLimit ?? 500,
      maxFutureSec: opts.maxFutureSec ?? 15 * 60,
      now: opts.now ?? Date.now,
    }
    for (const q of [
      'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL, created_at INTEGER NOT NULL, d TEXT, raw TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS events_kind_time ON events (kind, created_at)',
      'CREATE INDEX IF NOT EXISTS events_author ON events (pubkey, kind, d)',
      'CREATE INDEX IF NOT EXISTS events_time ON events (created_at)',
      'CREATE TABLE IF NOT EXISTS tags (event_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS tags_lookup ON tags (name, value, created_at)',
      'CREATE INDEX IF NOT EXISTS tags_event ON tags (event_id)',
      'CREATE TABLE IF NOT EXISTS deleted (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS subs (conn TEXT NOT NULL, id TEXT NOT NULL, filters TEXT NOT NULL, PRIMARY KEY (conn, id))',
    ])
      this.#sql.exec(q)
  }

  /** Forget subscriptions of connections that no longer exist (after a restart). */
  prune(): void {
    const live = [...this.#connections()].map((c) => c.id)
    this.#sql.exec('DELETE FROM subs WHERE conn NOT IN (SELECT value FROM json_each(?))', JSON.stringify(live))
  }

  /** NIP-11 relay information document. */
  info(): Record<string, unknown> {
    const o = this.#o
    return {
      name: o.name,
      description: o.description,
      software: RELAY_SOFTWARE,
      supported_nips: [1, 9, 11, 77],
      limitation: {
        max_message_length: o.maxMessageBytes,
        max_subscriptions: o.maxSubscriptions,
        max_filters: o.maxFilters,
        max_limit: o.maxLimit,
        auth_required: false,
        payment_required: false,
        restricted_writes: o.kinds !== null,
        created_at_upper_limit: o.maxFutureSec,
      },
      ...(o.kinds ? { kinds: [...o.kinds].sort((a, b) => a - b) } : {}),
    }
  }

  /** Handle one WebSocket message. */
  handle(conn: RelayConn, raw: string): void {
    const send = (...m: unknown[]) => conn.send(JSON.stringify(m))
    if (raw.length > this.#o.maxMessageBytes) return send('NOTICE', 'invalid: message too large')
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return send('NOTICE', 'invalid: not JSON')
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return send('NOTICE', 'invalid: not a relay message')
    const [type, a, ...rest] = msg as [string, unknown, ...unknown[]]
    try {
      switch (type) {
        case 'EVENT':
          return this.#onEvent(send, a)
        case 'REQ':
          return this.#onReq(conn, send, a, rest)
        case 'CLOSE':
          if (typeof a === 'string') this.#sql.exec('DELETE FROM subs WHERE conn = ? AND id = ?', conn.id, a)
          return
        case 'NEG-OPEN':
          return this.#onNegOpen(conn, send, a, rest[0], rest[1])
        case 'NEG-MSG':
          return this.#onNegMsg(conn, send, a, rest[0])
        case 'NEG-CLOSE':
          if (typeof a === 'string') this.#negs.delete(`${conn.id}\u0000${a}`)
          return
        default:
          return send('NOTICE', `unsupported: ${type}`)
      }
    } catch (e) {
      send('NOTICE', `error: ${(e as Error).message}`)
    }
  }

  /** A connection closed. */
  closed(conn: RelayConn): void {
    this.#sql.exec('DELETE FROM subs WHERE conn = ?', conn.id)
    for (const k of this.#negs.keys()) if (k.startsWith(`${conn.id}\u0000`)) this.#negs.delete(k)
  }

  // ---- EVENT ------------------------------------------------------------------------

  #onEvent(send: (...m: unknown[]) => void, raw: unknown): void {
    const e = raw as NostrEvent
    const id = typeof e?.id === 'string' ? e.id : ''
    const reject = (reason: string) => send('OK', id, false, reason)
    if (!validShape(e)) return reject('invalid: malformed event')
    if (this.#o.kinds && !this.#o.kinds.has(e.kind)) return reject(`blocked: kind ${e.kind} is not accepted by this relay`)
    if (e.created_at > this.#o.now() / 1000 + this.#o.maxFutureSec) return reject('invalid: created_at is too far in the future')
    if (!verifyEvent({ ...e })) return reject('invalid: bad id or signature')
    const ok = (msg = '') => send('OK', e.id, true, msg)

    if (isEphemeral(e.kind)) {
      this.#broadcast(e)
      return ok()
    }
    if (this.#sql.exec('SELECT 1 FROM events WHERE id = ?', e.id).toArray().length > 0) return ok('duplicate: already have it')
    if (this.#sql.exec('SELECT 1 FROM deleted WHERE id = ? AND pubkey = ?', e.id, e.pubkey).toArray().length > 0) return reject('blocked: this event was deleted')

    const d = isAddressable(e.kind) ? dTag(e) : null
    if (isReplaceable(e.kind) || d !== null) {
      const older = this.#sql
        .exec<{ id: string; created_at: number }>('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d IS ?', e.pubkey, e.kind, d)
        .toArray()
      // NIP-01: keep the newest; on equal timestamps the lowest id wins.
      if (older.some((o) => o.created_at > e.created_at || (o.created_at === e.created_at && o.id < e.id))) return ok('duplicate: have a newer version')
      for (const o of older) this.#remove(o.id)
    }
    if (e.kind === 5) this.#applyDeletion(e)
    this.#sql.exec('INSERT INTO events (id, pubkey, kind, created_at, d, raw) VALUES (?, ?, ?, ?, ?, ?)', e.id, e.pubkey, e.kind, e.created_at, d, JSON.stringify(e))
    for (const t of e.tags) {
      if (t[0]?.length === 1 && typeof t[1] === 'string') this.#sql.exec('INSERT INTO tags (event_id, name, value, created_at) VALUES (?, ?, ?, ?)', e.id, t[0], t[1], e.created_at)
    }
    this.#broadcast(e)
    ok()
  }

  /** NIP-09: delete the referenced events of the same author, and refuse them later. */
  #applyDeletion(del: NostrEvent): void {
    for (const t of del.tags) {
      if (t[0] !== 'e' || !HEX64.test(t[1] ?? '')) continue
      const id = t[1]!
      const own = this.#sql.exec<{ pubkey: string }>('SELECT pubkey FROM events WHERE id = ?', id).toArray()[0]
      if (own && own.pubkey !== del.pubkey) continue
      if (own) this.#remove(id)
      this.#sql.exec('INSERT OR IGNORE INTO deleted (id, pubkey) VALUES (?, ?)', id, del.pubkey)
    }
  }

  #remove(id: string): void {
    this.#sql.exec('DELETE FROM events WHERE id = ?', id)
    this.#sql.exec('DELETE FROM tags WHERE event_id = ?', id)
  }

  #broadcast(e: NostrEvent): void {
    const subs = this.#sql.exec<{ conn: string; id: string; filters: string }>('SELECT conn, id, filters FROM subs').toArray()
    if (subs.length === 0) return
    const byConn = new Map<string, Array<{ id: string; filters: string }>>()
    for (const s of subs) {
      let l = byConn.get(s.conn)
      if (!l) byConn.set(s.conn, (l = []))
      l.push(s)
    }
    let json: string | null = null
    for (const conn of this.#connections()) {
      for (const s of byConn.get(conn.id) ?? []) {
        if (!matchFilters(JSON.parse(s.filters) as Filter[], e)) continue
        json ??= JSON.stringify(e)
        try {
          conn.send(`["EVENT",${JSON.stringify(s.id)},${json}]`)
        } catch {
          // closed meanwhile
        }
      }
    }
  }

  // ---- REQ ----------------------------------------------------------------------------

  #onReq(conn: RelayConn, send: (...m: unknown[]) => void, id: unknown, filters: unknown[]): void {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return send('NOTICE', 'invalid: subscription id')
    const closed = (reason: string) => send('CLOSED', id, reason)
    if (filters.length === 0 || filters.length > this.#o.maxFilters) return closed(`invalid: 1–${this.#o.maxFilters} filters`)
    if (!filters.every(validFilter)) return closed('invalid: malformed filter')
    const fs = filters as Filter[]
    const existing = this.#sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM subs WHERE conn = ? AND id <> ?', conn.id, id).toArray()[0]?.n ?? 0
    if (existing >= this.#o.maxSubscriptions) return closed(`blocked: at most ${this.#o.maxSubscriptions} subscriptions`)
    this.#sql.exec('INSERT OR REPLACE INTO subs (conn, id, filters) VALUES (?, ?, ?)', conn.id, id, JSON.stringify(fs))
    const seen = new Set<string>()
    for (const f of fs) {
      const limit = Math.min(this.#o.maxLimit, f.limit ?? this.#o.maxLimit)
      if (limit <= 0) continue
      const { where, params } = whereOf(f)
      const rows = this.#sql.exec<{ id: string; raw: string }>(`SELECT e.id, e.raw FROM events e ${where} ORDER BY e.created_at DESC, e.id LIMIT ${limit}`, ...params).toArray()
      for (const r of rows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        conn.send(`["EVENT",${JSON.stringify(id)},${r.raw}]`)
      }
    }
    send('EOSE', id)
  }

  // ---- NIP-77 -------------------------------------------------------------------------

  #onNegOpen(conn: RelayConn, send: (...m: unknown[]) => void, id: unknown, filter: unknown, msg: unknown): void {
    if (typeof id !== 'string' || typeof msg !== 'string' || !validFilter(filter)) return send('NEG-ERR', id, 'invalid: NEG-OPEN')
    // Every matching event (not capped by maxLimit): reconciliation must see the whole set.
    const { where, params } = whereOf(filter as Filter)
    const items = this.#sql
      .exec<{ id: string; created_at: number }>(`SELECT e.id, e.created_at FROM events e ${where}`, ...params)
      .toArray()
    const neg = new Negentropy(items, { initiator: false })
    this.#negs.set(`${conn.id}\u0000${id}`, neg)
    this.#negReply(send, id, neg, msg)
  }

  #onNegMsg(conn: RelayConn, send: (...m: unknown[]) => void, id: unknown, msg: unknown): void {
    if (typeof id !== 'string' || typeof msg !== 'string') return
    const neg = this.#negs.get(`${conn.id}\u0000${id}`)
    if (!neg) return send('NEG-ERR', id, 'closed: no such session')
    this.#negReply(send, id, neg, msg)
  }

  #negReply(send: (...m: unknown[]) => void, id: string, neg: Negentropy, msg: string): void {
    try {
      send('NEG-MSG', id, neg.reconcile(msg) ?? '61')
    } catch (e) {
      send('NEG-ERR', id, `invalid: ${(e as Error).message}`)
    }
  }
}

/** SQL WHERE clause for a NIP-01 filter (lists are bound as one JSON array, so any length fits). */
function whereOf(f: Filter): { where: string; params: unknown[] } {
  const conds: string[] = []
  const params: unknown[] = []
  const list = (col: string, v: readonly unknown[]) => {
    conds.push(`${col} IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(v))
  }
  if (f.ids) list('e.id', f.ids)
  if (f.authors) list('e.pubkey', f.authors)
  if (f.kinds) list('e.kind', f.kinds)
  if (f.since !== undefined) {
    conds.push('e.created_at >= ?')
    params.push(f.since)
  }
  if (f.until !== undefined) {
    conds.push('e.created_at <= ?')
    params.push(f.until)
  }
  for (const [k, v] of Object.entries(f)) {
    if (k[0] !== '#' || k.length !== 2 || !Array.isArray(v)) continue
    conds.push('EXISTS (SELECT 1 FROM tags t WHERE t.event_id = e.id AND t.name = ? AND t.value IN (SELECT value FROM json_each(?)))')
    params.push(k[1], JSON.stringify(v))
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params }
}

function validShape(e: NostrEvent): boolean {
  return (
    !!e &&
    typeof e === 'object' &&
    HEX64.test(e.id) &&
    HEX64.test(e.pubkey) &&
    typeof e.sig === 'string' &&
    /^[0-9a-f]{128}$/.test(e.sig) &&
    Number.isSafeInteger(e.kind) &&
    e.kind >= 0 &&
    e.kind <= 65535 &&
    Number.isSafeInteger(e.created_at) &&
    e.created_at >= 0 &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
  )
}

function validFilter(f: unknown): boolean {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    if (k === 'ids' || k === 'authors' || (k[0] === '#' && k.length === 2)) {
      if (!Array.isArray(v) || v.length > 10_000 || !v.every((x) => typeof x === 'string')) return false
    } else if (k === 'kinds') {
      if (!Array.isArray(v) || !v.every((x) => Number.isSafeInteger(x))) return false
    } else if (k === 'since' || k === 'until' || k === 'limit') {
      if (!Number.isSafeInteger(v)) return false
    }
  }
  return true
}
