import type { Filter } from 'nostr-tools/filter'
import type { NostrEvent } from './types.js'

export type { Filter }

type WebSocketCtor = new (url: string) => WebSocket

export interface RelayPoolOptions {
  /** WebSocket implementation. Defaults to `globalThis.WebSocket` (browsers, Node 22+). */
  WebSocket?: WebSocketCtor
  publishTimeoutMs?: number
  connectTimeoutMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
}

export type PublishOutcome = 'ok' | 'rejected' | 'timeout' | 'disconnected'
export interface PublishResult {
  outcome: PublishOutcome
  message: string
}

export interface SubscriptionHandlers {
  onEvent(relay: string, event: NostrEvent): void
  onEose?(relay: string): void
}

interface SubEntry {
  filtersFor: (relay: string) => Filter[] | null
  handlers: SubscriptionHandlers
}

type Listener = (relay: string) => void

export function normalizeRelayUrl(url: string): string {
  const u = new URL(url)
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error(`anoDB: relay URL must be ws(s): ${url}`)
  let s = u.toString()
  if (s.endsWith('/') && u.pathname === '/') s = s.slice(0, -1)
  return s
}

class RelayConnection {
  readonly url: string
  #ws: WebSocket | null = null
  #open = false
  #closed = false
  #attempt = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  readonly #pool: RelayPool
  readonly #persistent: boolean
  readonly #pendingOk = new Map<string, (r: PublishResult) => void>()
  readonly #openWaiters: Array<(ok: boolean) => void> = []

  constructor(pool: RelayPool, url: string, persistent: boolean) {
    this.#pool = pool
    this.url = url
    this.#persistent = persistent
  }

  get isOpen(): boolean {
    return this.#open
  }

  connect(): void {
    if (this.#closed || this.#ws) return
    let ws: WebSocket
    try {
      ws = new this.#pool.WebSocketImpl(this.url)
    } catch {
      this.#scheduleReconnect()
      return
    }
    this.#ws = ws
    ws.onopen = () => {
      this.#open = true
      this.#attempt = 0
      for (const w of this.#openWaiters.splice(0)) w(true)
      this.#pool._onOpen(this)
    }
    ws.onmessage = (msg: MessageEvent) => this.#onMessage(msg.data)
    // Some implementations (Node 22's undici) fire only `error`, never `close`, when the connection fails.
    ws.onerror = () => {
      if (!this.#open) this.#teardown(ws)
    }
    ws.onclose = () => this.#teardown(ws)
  }

  /** Idempotent per socket: handles whichever of error/close arrives first. */
  #teardown(ws: WebSocket): void {
    if (this.#ws !== ws) return
    const wasOpen = this.#open
    this.#open = false
    this.#ws = null
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    for (const w of this.#openWaiters.splice(0)) w(false)
    for (const [, resolve] of this.#pendingOk) resolve({ outcome: 'disconnected', message: 'connection closed' })
    this.#pendingOk.clear()
    if (wasOpen) this.#pool._onClose(this)
    this.#scheduleReconnect()
  }

  waitOpen(timeoutMs: number): Promise<boolean> {
    if (this.#open) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs)
      this.#openWaiters.push((ok) => {
        clearTimeout(t)
        resolve(ok)
      })
    })
  }

  send(msg: unknown[]): boolean {
    if (!this.#open || !this.#ws) return false
    try {
      this.#ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  publish(event: NostrEvent, timeoutMs: number): Promise<PublishResult> {
    if (!this.send(['EVENT', event])) return Promise.resolve({ outcome: 'disconnected', message: 'not connected' })
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#pendingOk.delete(event.id)
        resolve({ outcome: 'timeout', message: 'no OK from relay' })
      }, timeoutMs)
      this.#pendingOk.set(event.id, (r) => {
        clearTimeout(t)
        resolve(r)
      })
    })
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    try {
      this.#ws?.close()
    } catch {
      /* ignore */
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || !this.#persistent || this.#timer) return
    const { reconnectMinMs, reconnectMaxMs } = this.#pool
    const base = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** this.#attempt++)
    const delay = base / 2 + Math.random() * (base / 2)
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.connect()
    }, delay)
  }

  #onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(msg)) return
    const [type, a, b, c] = msg as [unknown, unknown, unknown, unknown]
    if (type === 'EVENT' && typeof a === 'string' && isEventShape(b)) {
      this.#pool._dispatchEvent(this.url, a, b)
    } else if (type === 'EOSE' && typeof a === 'string') {
      this.#pool._dispatchEose(this.url, a)
    } else if (type === 'OK' && typeof a === 'string') {
      const resolve = this.#pendingOk.get(a)
      if (!resolve) return
      this.#pendingOk.delete(a)
      const message = typeof c === 'string' ? c : ''
      const ok = b === true || message.startsWith('duplicate:')
      resolve({ outcome: ok ? 'ok' : 'rejected', message })
    } else if (type === 'CLOSED' && typeof a === 'string') {
      this.#pool._dispatchClosed(this.url, a, typeof b === 'string' ? b : '')
    }
  }
}

function isEventShape(e: unknown): e is NostrEvent {
  if (typeof e !== 'object' || e === null) return false
  const o = e as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.pubkey === 'string' &&
    typeof o.created_at === 'number' &&
    typeof o.kind === 'number' &&
    Array.isArray(o.tags) &&
    typeof o.content === 'string' &&
    typeof o.sig === 'string'
  )
}

let subCounter = 0
const nextSubId = (prefix: string) => `${prefix}${(++subCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * Minimal NIP-01 relay pool: persistent connections with backoff, resubscription on reconnect,
 * per-relay OK tracking, and one-shot queries against arbitrary (discovered) relays.
 */
export class RelayPool {
  readonly WebSocketImpl: WebSocketCtor
  readonly publishTimeoutMs: number
  readonly connectTimeoutMs: number
  readonly reconnectMinMs: number
  readonly reconnectMaxMs: number
  readonly #conns = new Map<string, RelayConnection>()
  readonly #subs = new Map<string, SubEntry>()
  readonly #oneShot = new Map<string, { onEvent: (e: NostrEvent) => void; onEnd: () => void }>()
  readonly #openListeners = new Set<Listener>()
  readonly #closeListeners = new Set<Listener>()
  #closed = false

  constructor(urls: readonly string[], opts: RelayPoolOptions = {}) {
    const impl = opts.WebSocket ?? (globalThis.WebSocket as WebSocketCtor | undefined)
    if (!impl) throw new Error('anoDB: no WebSocket implementation available; pass options.WebSocket')
    this.WebSocketImpl = impl
    this.publishTimeoutMs = opts.publishTimeoutMs ?? 10_000
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5_000
    this.reconnectMinMs = opts.reconnectMinMs ?? 1_000
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000
    for (const u of urls) {
      const url = normalizeRelayUrl(u)
      if (!this.#conns.has(url)) this.#conns.set(url, new RelayConnection(this, url, true))
    }
  }

  get relays(): string[] {
    return [...this.#conns.keys()]
  }

  connected(): string[] {
    return [...this.#conns.values()].filter((c) => c.isOpen).map((c) => c.url)
  }

  connect(): void {
    for (const c of this.#conns.values()) c.connect()
  }

  onOpen(fn: Listener): () => void {
    this.#openListeners.add(fn)
    return () => this.#openListeners.delete(fn)
  }

  onClose(fn: Listener): () => void {
    this.#closeListeners.add(fn)
    return () => this.#closeListeners.delete(fn)
  }

  /** Long-lived subscription. `filtersFor` is re-evaluated on every (re)connect so cursors advance. */
  subscribe(filtersFor: (relay: string) => Filter[] | null, handlers: SubscriptionHandlers): () => void {
    const id = nextSubId('s')
    this.#subs.set(id, { filtersFor, handlers })
    for (const c of this.#conns.values()) if (c.isOpen) this.#sendReq(c, id)
    return () => {
      this.#subs.delete(id)
      for (const c of this.#conns.values()) c.send(['CLOSE', id])
    }
  }

  /** Publish to the given (default: all connected) pool relays. */
  async publish(event: NostrEvent, relays?: readonly string[]): Promise<Map<string, PublishResult>> {
    const targets = (relays ?? this.relays).map((r) => this.#conns.get(r)).filter((c) => c !== undefined)
    const results = await Promise.all(targets.map((c) => c.publish(event, this.publishTimeoutMs)))
    return new Map(targets.map((c, i) => [c.url, results[i]!]))
  }

  /**
   * One-shot fetch: returns all events received before EOSE (or timeout) from each relay.
   * Relays not in the pool are connected temporarily.
   */
  async query(filters: Filter[], opts: { relays?: readonly string[]; timeoutMs?: number } = {}): Promise<NostrEvent[]> {
    const timeoutMs = opts.timeoutMs ?? 6_000
    const urls = [...new Set((opts.relays ?? this.relays).map(normalizeRelayUrl))]
    const seen = new Map<string, NostrEvent>()
    await Promise.all(
      urls.map(async (url) => {
        let conn = this.#conns.get(url)
        let temporary = false
        if (!conn) {
          if (this.#closed) return
          conn = new RelayConnection(this, url, false)
          temporary = true
          conn.connect()
        }
        try {
          if (!(await conn.waitOpen(Math.min(this.connectTimeoutMs, timeoutMs)))) return
          await new Promise<void>((resolve) => {
            const id = nextSubId('q')
            const finish = () => {
              clearTimeout(t)
              this.#oneShot.delete(`${url} ${id}`)
              conn.send(['CLOSE', id])
              resolve()
            }
            const t = setTimeout(finish, timeoutMs)
            this.#oneShot.set(`${url} ${id}`, { onEvent: (e) => seen.set(e.id, e), onEnd: finish })
            if (!conn.send(['REQ', id, ...filters])) finish()
          })
        } finally {
          if (temporary) conn.close()
        }
      }),
    )
    return [...seen.values()]
  }

  close(): void {
    this.#closed = true
    for (const c of this.#conns.values()) c.close()
    this.#subs.clear()
  }

  #sendReq(conn: RelayConnection, id: string): void {
    const entry = this.#subs.get(id)
    const filters = entry?.filtersFor(conn.url)
    if (filters && filters.length > 0) conn.send(['REQ', id, ...filters])
  }

  // ---- internal callbacks from RelayConnection ---------------------------

  _onOpen(conn: RelayConnection): void {
    if (!this.#conns.has(conn.url)) return
    for (const id of this.#subs.keys()) this.#sendReq(conn, id)
    for (const fn of this.#openListeners) fn(conn.url)
  }

  _onClose(conn: RelayConnection): void {
    if (!this.#conns.has(conn.url)) return
    for (const fn of this.#closeListeners) fn(conn.url)
  }

  _dispatchEvent(relay: string, subId: string, event: NostrEvent): void {
    const one = this.#oneShot.get(`${relay} ${subId}`)
    if (one) return one.onEvent(event)
    this.#subs.get(subId)?.handlers.onEvent(relay, event)
  }

  _dispatchEose(relay: string, subId: string): void {
    const one = this.#oneShot.get(`${relay} ${subId}`)
    if (one) return one.onEnd()
    this.#subs.get(subId)?.handlers.onEose?.(relay)
  }

  _dispatchClosed(relay: string, subId: string, _reason: string): void {
    const one = this.#oneShot.get(`${relay} ${subId}`)
    if (one) return one.onEnd()
    // Relay refused/closed a long-lived subscription; treat as caught-up so status is not stuck.
    this.#subs.get(subId)?.handlers.onEose?.(relay)
  }
}
