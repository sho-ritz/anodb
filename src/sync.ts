import { BACKFILL_PAGE, CURSOR_SKEW_SEC, RESIGN_AFTER_SEC } from './defaults.js'
import { TAG, WRAP_KIND } from './protocol.js'
import type { Filter, RelayPool } from './relay-pool.js'
import { AUTO_RELAYS_PER_SEED, type PlannedRoute, RelayRouter, type TagRoute } from './relay-routing.js'
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
  /** How a tag uses relays (null: fixed relays only). */
  route?(tag: string): TagRoute | null
}

export interface SyncOptions {
  minAcks: number
  retryIntervalMs: number
  router?: RelayRouter
  /** Polling interval for tags read on picked relays beyond the connection budget (DECISIONS 29 ④). */
  pollIntervalMs?: number
  /** Interval of the check of ranks 6–10 (DECISIONS 29 ⑤). */
  checkIntervalMs?: number
}

interface RelayState {
  gen: number
  sinceByTag: Map<string, number>
  oldest: number | null
  newestByTag: Map<string, number>
  caughtUp: boolean
}

const tagOf = (e: NostrEvent) => e.tags.find((t) => t[0] === TAG)?.[1]
/** Acceptances a write needs on picked relays when they are the store (phase 2+). */
const PRIMARY_ACKS = AUTO_RELAYS_PER_SEED

/** Subscriptions, catch-up paging, per-tag cursors, relay routing and the durable outbox. */
export class SyncEngine {
  readonly #store: Store
  readonly #pool: RelayPool
  readonly #host: SyncHost
  readonly #minAcks: number
  readonly #router: RelayRouter
  readonly #state = new Map<string, RelayState>()
  #gen = 0
  #unsub: (() => void) | null = null
  #flushing: Promise<void> | null = null
  #flushAgain = false
  #timer: ReturnType<typeof setInterval> | null = null
  #tick: ReturnType<typeof setInterval> | null = null
  #closed = false
  #tagKey = ''
  #lastPoll = 0
  #lastCheck = 0
  readonly #pollMs: number
  readonly #checkMs: number
  /**
   * Copies still owed to picked relays that were offline at delivery (in memory, best effort).
   * `resign`: the event reached only lower ranks, so the copy for a top relay gets a fresh created_at.
   */
  readonly #owed = new Map<string, Map<string, { event: NostrEvent; resign: boolean }>>()

  constructor(store: Store, pool: RelayPool, host: SyncHost, opts: SyncOptions) {
    this.#store = store
    this.#pool = pool
    this.#host = host
    this.#minAcks = opts.minAcks
    this.#router = opts.router ?? new RelayRouter(pool.relays, null, 0)
    this.#pollMs = opts.pollIntervalMs ?? 3 * 60_000
    this.#checkMs = opts.checkIntervalMs ?? 10 * 60_000
    pool.onOpen((relay) => {
      host.statusChanged()
      this.#payOwed(relay)
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
    if (this.#router.enabled) {
      this.#tick = setInterval(() => void this.#background(), Math.max(50, Math.min(this.#pollMs, this.#checkMs) / 2))
      ;(this.#tick as { unref?: () => void }).unref?.()
    }
  }

  get pool(): RelayPool {
    return this.#pool
  }

  get router(): RelayRouter {
    return this.#router
  }

  /** The fixed relays (`relays` option / DEFAULT_RELAYS), without the automatically picked ones. */
  get fixedRelays(): readonly string[] {
    return this.#router.fixed
  }

  #route(tag: string): PlannedRoute {
    return this.#router.resolve(tag, this.#host.route?.(tag) ?? null)
  }

  /** Every relay that may hold `tag`: its fixed part plus all used ranks (repair, one-off reads). */
  relaysFor(tag: string): string[] {
    return this.#router.relaysFor(tag, this.#host.route?.(tag) ?? null)
  }

  /** Connected relays that read `tag` live (ephemeral events). */
  liveRelaysFor(tag: string): string[] {
    const connected = new Set(this.#pool.connected())
    return this.#pool.relays.filter((r) => connected.has(r) && this.#router.reads(tag, r))
  }

  /** The subset of `tags` this device reads live on `relay`. */
  tagsOn(relay: string, tags: readonly string[]): string[] {
    return tags.filter((t) => this.#router.reads(t, relay))
  }

  start(): void {
    this.refresh(true)
    this.#pool.connect()
  }

  /** Re-subscribe if the tag set or a tag's route changed (new space, new epoch key, switch…). */
  refresh(force = false): void {
    if (this.#closed) return
    const tags = this.#host.tags()
    const routes = tags.map((tag) => ({ tag, route: this.#host.route?.(tag) ?? null }))
    const key = routes
      .map((r) => `${r.tag}:${r.route ? `${r.route.fixed ? 'f' : ''}${r.route.primary ? 'p' : ''}${r.route.auto ? r.route.auto.list.length : ''}:${r.route.prio}` : ''}`)
      .sort()
      .join(',')
    if (!force && key === this.#tagKey) return
    this.#tagKey = key
    if (this.#router.enabled) {
      const keep = this.#router.plan(routes)
      this.#pool.setRelays(keep)
      for (const r of [...this.#state.keys()]) if (!keep.includes(r)) this.#state.delete(r)
    } else this.#router.plan(routes)
    this.#unsub?.()
    this.#gen++
    this.#unsub = this.#pool.subscribe((relay) => this.#filtersFor(relay), {
      onEvent: (relay, event) => this.#onEvent(relay, event),
      onEose: (relay) => void this.#onEose(relay),
    })
    this.#host.statusChanged()
  }

  #filtersFor(relay: string): Filter[] | null {
    const tags = this.tagsOn(relay, this.#host.tags())
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
    for (const [tag, newest] of st.newestByTag) this.#store.advanceCursor(relay, tag, newest)
    st.caughtUp = true
    this.#host.statusChanged()
    // Extra layers (NIP-77, gap repair) run in the background; they only add data.
    this.#host.afterCatchUp?.(relay).catch(() => {})
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

  // ---- reads beyond the live connections (DECISIONS 29 ④⑤) ---------------------------------

  async #background(): Promise<void> {
    if (this.#closed) return
    this.refresh() // routes also change with time (grace periods ending)
    const now = this.#host.now()
    if (now - this.#lastPoll >= this.#pollMs) {
      this.#lastPoll = now
      await this.poll().catch(() => {})
    }
    if (now - this.#lastCheck >= this.#checkMs) {
      this.#lastCheck = now
      await this.checkLowerRanks().catch(() => {})
    }
  }

  /** Read `tags` on `relays` from each (relay, tag) cursor; returns events that were new. */
  async #readFrom(pairs: Map<string, string[]>): Promise<NostrEvent[]> {
    const fresh: NostrEvent[] = []
    await Promise.all(
      [...pairs].map(async ([relay, tags]) => {
        const filters: Filter[] = tags.map((tag) => {
          const c = this.#store.getCursor(relay, tag)
          const f: Filter = { kinds: [WRAP_KIND], [`#${TAG}`]: [tag] }
          if (c !== undefined) f.since = Math.max(0, c - CURSOR_SKEW_SEC)
          return f
        })
        const events = await this.#pool.query(filters, { relays: [relay] })
        for (const e of events) {
          const tag = tagOf(e)
          if (!tag || this.#closed) continue
          if (this.#host.ingest(relay, e) === 'new') fresh.push(e)
          this.#store.advanceCursor(relay, tag, e.created_at)
        }
      }),
    )
    return fresh
  }

  /** Tags on picked relays beyond the connection budget: connect, fetch what is new, disconnect. */
  async poll(): Promise<void> {
    const pairs = new Map<string, string[]>()
    for (const [tag, p] of this.#router.planned()) {
      if (p.live || !p.route.primary) continue
      for (const r of p.ranks.slice(0, AUTO_RELAYS_PER_SEED)) pairs.set(r, [...(pairs.get(r) ?? []), tag])
    }
    if (pairs.size > 0) await this.#readFrom(pairs)
  }

  /**
   * Ranks 6–10 of every primary tag: whatever a writer could only place there (its top relays were
   * down) is found here even if the writer never comes back, and copied unchanged to the top 5.
   */
  async checkLowerRanks(): Promise<void> {
    const pairs = new Map<string, string[]>()
    const top = new Map<string, readonly string[]>()
    for (const [tag, p] of this.#router.planned()) {
      if (!p.route.primary) continue
      top.set(tag, p.ranks.slice(0, AUTO_RELAYS_PER_SEED))
      for (const r of p.ranks.slice(AUTO_RELAYS_PER_SEED)) pairs.set(r, [...(pairs.get(r) ?? []), tag])
    }
    if (pairs.size === 0) return
    const fresh = await this.#readFrom(pairs)
    await Promise.all(fresh.map((e) => this.#pool.publish(e, top.get(tagOf(e)!) ?? [])))
  }

  /** Time-range query of `tags` on every relay that may hold them (sequence-gap repair). */
  async queryRange(tags: readonly string[], since: number, until: number): Promise<number> {
    const byRelay = new Map<string, string[]>()
    for (const tag of tags) for (const r of this.relaysFor(tag)) byRelay.set(r, [...(byRelay.get(r) ?? []), tag])
    let fresh = 0
    await Promise.all(
      [...byRelay].map(async ([relay, list]) => {
        const events = await this.#pool.query([{ kinds: [WRAP_KIND], [`#${TAG}`]: list, since: Math.max(0, since), until }], { relays: [relay] })
        for (const e of events) if (this.#host.ingest(relay, e) === 'new') fresh++
      }),
    )
    return fresh
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

  /** A pool relay that is not connected is skipped; relays outside the pool are tried with a one-off connection. */
  #usable(relay: string, connected: ReadonlySet<string>): boolean {
    return this.#pool.has(relay) ? connected.has(relay) : true
  }

  /**
   * Rank order: connected relays are taken, relays that failed to connect are skipped (the write
   * falls through to the next rank, up to 10), and a relay still connecting stops the fall-through.
   */
  #primaryTargets(ranks: readonly string[], acks: ReadonlyMap<string, unknown>, need: number, connected: ReadonlySet<string>): string[] {
    const out: string[] = []
    let waiting = false
    for (const r of ranks) {
      if (out.length >= need) break
      if (acks.has(r)) continue
      if (this.#pool.has(r)) {
        if (connected.has(r)) out.push(r)
        else if (!this.#pool.isDown(r)) waiting = true
      } else if (!waiting) out.push(r)
    }
    return out
  }

  async #flushOnce(): Promise<void> {
    if (this.#closed) return
    const connected = new Set(this.#pool.connected())
    // Offline (no persistent relay reachable): do not keep opening one-off connections.
    if (this.#pool.relays.length > 0 && connected.size === 0) return
    await Promise.all(
      this.#store.outbox().map(async ({ entryId, event, resign, holdUntil, acks }) => {
        // Held while peers acknowledge it over WebRTC; released (or dequeued) by the P2P layer.
        if (holdUntil > Date.now()) return
        const tag = tagOf(event)
        const p = tag ? this.#route(tag) : this.#router.resolve('', null) // untagged (key packages): fixed relays
        const ok = (rs: readonly string[]) => rs.filter((r) => acks.get(r) === 'ok').length
        const answered = (rs: readonly string[]) => rs.filter((r) => acks.has(r)).length
        let targets: string[]
        if (p.route.primary) {
          // Phase 2+: the first reachable relays in rank order, falling through to ranks 6–10.
          const need = Math.min(PRIMARY_ACKS, p.ranks.length) - ok(p.ranks)
          targets = need > 0 ? this.#primaryTargets(p.ranks, acks, need, connected) : []
        } else {
          targets = [...new Set([...p.fixed, ...p.ranks])].filter((r) => !acks.has(r) && this.#usable(r, connected))
        }
        if (targets.length === 0 && !p.route.primary) return
        let toSend = event
        const nowSec = Math.floor(this.#host.now() / 1000)
        if (targets.length > 0 && resign && nowSec - event.created_at > RESIGN_AFTER_SEC) {
          // Offline writes: a fresh created_at so `since` cursors on other devices include them.
          toSend = this.#host.resign(event)
          this.#store.transaction(() => {
            this.#store.replaceOutboxEvent(entryId, toSend)
            const t = tagOf(toSend)
            if (t) this.#store.putRaw(toSend, t)
          })
        }
        if (targets.length > 0) {
          const results = await this.#pool.publish(toSend, targets)
          if (this.#closed) return
          for (const [relay, r] of results) {
            if (r.outcome === 'ok' || r.outcome === 'rejected') {
              acks.set(relay, r.outcome)
              this.#store.recordAck(entryId, relay, r.outcome, r.message)
            }
          }
        }
        if (p.route.primary) {
          const top = p.ranks.slice(0, AUTO_RELAYS_PER_SEED)
          if (ok(p.ranks) >= Math.min(PRIMARY_ACKS, p.ranks.length) || (ok(p.ranks) > 0 && answered(p.ranks) === p.ranks.length)) {
            this.#store.dequeue(entryId)
            // Placed partly on ranks 6–10: the top relays get a re-signed copy when they are back.
            for (const r of top) if (!acks.has(r)) this.#owe(r, toSend, true)
          } else if (p.ranks.length > 0 && answered(p.ranks) === p.ranks.length) this.#host.publishRejected(entryId)
          return
        }
        // Phase 1: delivery is judged on the fixed relays (picked ones get extra copies), or on the
        // picked ones when there are no fixed relays.
        const judged = p.fixed.length > 0 ? p.fixed : p.ranks
        if (judged.length === 0) return
        if (ok(judged) >= Math.min(this.#minAcks, judged.length) || (ok(judged) > 0 && answered(judged) === judged.length)) {
          this.#store.dequeue(entryId)
          for (const r of p.ranks) if (!acks.has(r) && !judged.includes(r)) this.#owe(r, toSend, false)
        } else if (answered(judged) === judged.length) this.#host.publishRejected(entryId)
      }),
    )
  }

  #owe(relay: string, event: NostrEvent, resign: boolean): void {
    if (!this.#pool.has(relay)) return // not followed by this device: lower ranks / NIP-77 cover it
    if (this.#pool.connected().includes(relay)) {
      void this.#pool.publish(event, [relay])
      return
    }
    let m = this.#owed.get(relay)
    if (!m) this.#owed.set(relay, (m = new Map()))
    m.set(event.id, { event, resign })
    if (m.size > 500) m.delete(m.keys().next().value!)
  }

  #payOwed(relay: string): void {
    const m = this.#owed.get(relay)
    if (!m || this.#closed) return
    this.#owed.delete(relay)
    const fresh = new Map<string, NostrEvent>()
    for (const { event, resign } of m.values()) {
      let e = event
      if (resign) {
        e = fresh.get(event.id) ?? this.#host.resign(event)
        fresh.set(event.id, e)
        const t = tagOf(e)
        if (t) this.#store.putRaw(e, t)
      }
      void this.#pool.publish(e, [relay])
    }
  }

  enqueue(event: NostrEvent, resign: boolean, holdUntil = 0): void {
    this.#store.enqueue(event, resign, holdUntil)
  }

  close(): void {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#tick) clearInterval(this.#tick)
    this.#unsub?.()
    this.#pool.close()
  }
}
