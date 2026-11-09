import { BACKFILL_PAGE, CURSOR_SKEW_SEC, RESIGN_AFTER_SEC } from './defaults.js'
import { TAG, WRAP_KIND } from './protocol.js'
import type { Filter, RelayPool } from './relay-pool.js'
import type { Store } from './store.js'
import type { NostrEvent, SyncStatus } from './types.js'

export type IngestResult = 'new' | 'seen' | 'invalid'

export interface SyncHost {
  /** Tags to subscribe to (space epochs + own inbox + pending secrets). */
  tags(): string[]
  ingest(relay: string, event: NostrEvent): IngestResult
  /** Give a stale outbox envelope a fresh created_at (new envelope, same content). */
  resign(event: NostrEvent): NostrEvent
  statusChanged(): void
  publishRejected(entryId: string): void
  now(): number
  /** Hook for extra reconciliation once a relay finished its initial batch (NIP-77, gap repair). */
  afterCatchUp?(relay: string): Promise<void>
}

interface RelayState {
  gen: number
  sinceByTag: Map<string, number>
  oldest: number | null
  newestByTag: Map<string, number>
  caughtUp: boolean
}

const tagOf = (e: NostrEvent) => e.tags.find((t) => t[0] === TAG)?.[1]

/** Subscriptions, catch-up paging, per-tag cursors and the durable outbox. */
export class SyncEngine {
  readonly #store: Store
  readonly #pool: RelayPool
  readonly #host: SyncHost
  readonly #minAcks: number
  readonly #state = new Map<string, RelayState>()
  #gen = 0
  #unsub: (() => void) | null = null
  #flushing: Promise<void> | null = null
  #flushAgain = false
  #timer: ReturnType<typeof setInterval> | null = null
  #closed = false
  #tagKey = ''

  constructor(store: Store, pool: RelayPool, host: SyncHost, opts: { minAcks: number; retryIntervalMs: number }) {
    this.#store = store
    this.#pool = pool
    this.#host = host
    this.#minAcks = opts.minAcks
    pool.onOpen(() => {
      host.statusChanged()
      void this.flush()
    })
    pool.onClose((relay) => {
      this.#state.delete(relay)
      host.statusChanged()
    })
    this.#timer = setInterval(() => {
      if (this.#store.outboxSize() > 0) void this.flush()
    }, opts.retryIntervalMs)
    ;(this.#timer as { unref?: () => void }).unref?.()
  }

  get pool(): RelayPool {
    return this.#pool
  }

  start(): void {
    this.refresh(true)
    this.#pool.connect()
  }

  /** Re-subscribe if the tag set changed (new space, new epoch key…). */
  refresh(force = false): void {
    if (this.#closed) return
    const tags = this.#host.tags()
    const key = [...tags].sort().join(',')
    if (!force && key === this.#tagKey) return
    this.#tagKey = key
    this.#unsub?.()
    this.#gen++
    this.#unsub = this.#pool.subscribe((relay) => this.#filtersFor(relay), {
      onEvent: (relay, event) => this.#onEvent(relay, event),
      onEose: (relay) => void this.#onEose(relay),
    })
    this.#host.statusChanged()
  }

  #filtersFor(relay: string): Filter[] | null {
    const tags = this.#host.tags()
    const bySince = new Map<number, string[]>()
    const sinceByTag = new Map<string, number>()
    for (const tag of tags) {
      const c = this.#store.getCursor(relay, tag)
      const since = c === undefined ? 0 : Math.max(0, c - CURSOR_SKEW_SEC)
      sinceByTag.set(tag, since)
      let list = bySince.get(since)
      if (!list) bySince.set(since, (list = []))
      list.push(tag)
    }
    this.#state.set(relay, { gen: this.#gen, sinceByTag, oldest: null, newestByTag: new Map(), caughtUp: tags.length === 0 })
    if (tags.length === 0) return null
    return [...bySince].map(([since, list]) => {
      const f: Filter = { kinds: [WRAP_KIND], [`#${TAG}`]: list }
      if (since > 0) f.since = since
      return f
    })
  }

  #onEvent(relay: string, event: NostrEvent): void {
    if (this.#closed || event.kind !== WRAP_KIND) return
    const tag = tagOf(event)
    if (!tag) return
    if (this.#host.ingest(relay, event) === 'invalid') return
    const st = this.#state.get(relay)
    if (st && !st.caughtUp) {
      st.oldest = st.oldest === null ? event.created_at : Math.min(st.oldest, event.created_at)
      st.newestByTag.set(tag, Math.max(st.newestByTag.get(tag) ?? 0, event.created_at))
    } else {
      this.#store.advanceCursor(relay, tag, event.created_at)
    }
  }

  /** Initial batch done: page backwards with `until` until nothing new arrives, then advance cursors. */
  async #onEose(relay: string): Promise<void> {
    const st = this.#state.get(relay)
    if (!st || st.caughtUp) return
    const tags = [...st.sinceByTag.keys()]
    const minSince = Math.min(...st.sinceByTag.values())
    let until = st.oldest
    while (until !== null && !this.#closed) {
      const f: Filter = { kinds: [WRAP_KIND], [`#${TAG}`]: tags, until, limit: BACKFILL_PAGE }
      if (minSince > 0) f.since = minSince
      const page = await this.#pool.query([f], { relays: [relay] })
      let fresh = 0
      let oldest: number | null = null
      for (const e of page) {
        const tag = tagOf(e)
        if (!tag) continue
        if (this.#host.ingest(relay, e) === 'new') fresh++
        oldest = oldest === null ? e.created_at : Math.min(oldest, e.created_at)
        st.newestByTag.set(tag, Math.max(st.newestByTag.get(tag) ?? 0, e.created_at))
      }
      if (oldest === null) break
      if (fresh > 0) until = oldest
      else if (oldest === until) {
        // A full page of one already-seen second: NIP-01 cannot page inside a second; skip it.
        until -= 1
        if (until < minSince) break
      } else break
    }
    if (this.#state.get(relay) !== st) return
    try {
      await this.#host.afterCatchUp?.(relay)
    } catch {
      /* best effort */
    }
    if (this.#state.get(relay) !== st) return
    for (const [tag, newest] of st.newestByTag) this.#store.advanceCursor(relay, tag, newest)
    st.caughtUp = true
    this.#host.statusChanged()
  }

  get status(): SyncStatus {
    const connectedRelays = this.#pool.connected()
    const pendingEvents = this.#store.outboxSize()
    let state: SyncStatus['state']
    if (connectedRelays.length === 0) state = 'offline'
    else if (pendingEvents > 0 || connectedRelays.some((r) => !this.#state.get(r)?.caughtUp)) state = 'syncing'
    else state = 'synced'
    return { state, connectedRelays, pendingEvents }
  }

  /** Forget cursors so the next subscription re-downloads everything (merge is idempotent). */
  resync(): void {
    this.#store.resetCursors()
    this.refresh(true)
  }

  // ---- outbox ----------------------------------------------------------------

  flush(): Promise<void> {
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
        this.#host.statusChanged()
      }
    })()
    return this.#flushing
  }

  async #flushOnce(): Promise<void> {
    if (this.#closed) return
    const connected = new Set(this.#pool.connected())
    if (connected.size === 0) return
    const relays = this.#pool.relays
    await Promise.all(
      this.#store.outbox().map(async ({ entryId, event, resign, acks }) => {
        const targets = relays.filter((r) => connected.has(r) && !acks.has(r))
        if (targets.length === 0) return
        let toSend = event
        const nowSec = Math.floor(this.#host.now() / 1000)
        if (resign && nowSec - event.created_at > RESIGN_AFTER_SEC) {
          // Offline writes: a fresh created_at so `since` cursors on other devices include them.
          toSend = this.#host.resign(event)
          this.#store.transaction(() => {
            this.#store.replaceOutboxEvent(entryId, toSend)
            const tag = tagOf(toSend)
            if (tag) this.#store.putRaw(toSend, tag)
          })
        }
        const results = await this.#pool.publish(toSend, targets)
        if (this.#closed) return
        for (const [relay, r] of results) {
          if (r.outcome === 'ok' || r.outcome === 'rejected') {
            acks.set(relay, r.outcome)
            this.#store.recordAck(entryId, relay, r.outcome, r.message)
          }
        }
        const ok = [...acks.values()].filter((s) => s === 'ok').length
        if (ok >= this.#minAcks || (ok > 0 && acks.size === relays.length)) this.#store.dequeue(entryId)
        else if (acks.size === relays.length) this.#host.publishRejected(entryId)
      }),
    )
  }

  enqueue(event: NostrEvent, resign: boolean): void {
    this.#store.enqueue(event, resign)
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#unsub?.()
    this.#pool.close()
  }
}
