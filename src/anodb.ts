import { bytesToHex, hexToBytes, randomHex, sha256Hex, signWith } from './crypto.js'
import { type AnoDBOptions, prepare } from './db.js'
import { EVENT_KIND, EVENT_MAX_AGE_SEC, type SpaceEvent, openEvent, sealEvent } from './events.js'
import { TAG, WRAP_KIND } from './protocol.js'
import { type P2PMode, type PeerInfo, P2PSync } from './p2p.js'
import type { Filter } from './relay-pool.js'
import { AnoDBSharing } from './sharing.js'
import type { NostrEvent, SchemaDefinition } from './types.js'

const BACKFILL_PAGE = 500

export interface SyncGap {
  space: string
  device: string
  /** Missing sequence numbers (at most 100 listed). */
  missing: number[]
}

/** anoDB database handle: SQL-like API, spaces & sharing, NIP-77 sync. */
export class AnoDB<S extends SchemaDefinition> extends AnoDBSharing<S> {
  readonly #negUnsupported = new Set<string>()
  #reconcileTimer: ReturnType<typeof setInterval> | null = null
  #lastRepair = 0
  #reconciling = new Set<string>()
  #p2p: P2PSync | null = null
  readonly #eventListeners = new Set<{ fn: (e: SpaceEvent) => void; space?: string; type?: string }>()
  readonly #seenEvents = new Set<string>()
  #eventUnsub: (() => void) | null = null
  #eventKey = ''
  #eventTimer: ReturnType<typeof setInterval> | null = null

  protected override async afterInit(): Promise<void> {
    await super.afterInit()
    this.#startP2P()
    if (this.sync) {
      this.#reconcileTimer = setInterval(() => {
        for (const r of this.sync?.pool.connected() ?? []) void this.reconcile(r)
      }, this.opts.reconcileIntervalMs ?? 10 * 60_000)
      ;(this.#reconcileTimer as { unref?: () => void }).unref?.()
    }
  }

  // ---- direct WebRTC sync ---------------------------------------------------------------

  /** Effective P2P mode: own devices by default where WebRTC exists. */
  get p2pMode(): P2PMode {
    const o = this.opts.p2p
    const rtc = o?.rtc ?? (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection
    if (!this.sync || !rtc) return 'off'
    return o?.mode ?? 'own-devices'
  }

  #startP2P(): void {
    const mode = this.p2pMode
    if (mode === 'off') return
    this.#p2p = new P2PSync(
      {
        appId: this.appId,
        relays: () => this.sync?.pool.relays ?? [],
        deviceSk: this.deviceSk,
        devicePubkey: this.devicePubkey,
        rooms: () =>
          this.store
            .spaces()
            .filter((s) => s.status === 'active' && (mode === 'members' || s.personal))
            .flatMap((s) => {
              const k = this.keysBySpace.get(s.id)?.[0]
              return k ? [{ space: s.id, keyId: k.keyId, key: k.key }] : []
            }),
        allowedDevices: (space) => {
          const m = this.membership(space)
          const out = new Set<string>()
          for (const [identity] of m.roles) {
            for (const d of this.store.devices(identity)) if (!d.revoked && !m.revokedDevices.has(d.device)) out.add(d.device)
          }
          return out
        },
        ingest: (e) => this.ingestGated('p2p', e) !== 'invalid',
        delivered: (entryId) => {
          this.store.dequeue(entryId)
          this.store.markRawLocal(entryId)
          this.emitStatus()
        },
        release: (entryId) => {
          this.store.releaseOutbox(entryId)
          void this.sync?.flush()
        },
      },
      this.opts.p2p ?? {},
    )
    this.#p2p.start()
  }

  protected override holdForPeers(space: string): number {
    return this.#p2p?.holdMs(space) ?? 0
  }

  protected override afterEnvelope(space: string, outer: NostrEvent, held: boolean): void {
    if (this.#p2p) queueMicrotask(() => this.#p2p?.send(space, outer, held))
  }

  /** Raw P2P room state (troubleshooting). */
  p2pDiagnostics(): ReturnType<P2PSync['diagnostics']> {
    return this.#p2p?.diagnostics() ?? []
  }

  /** Devices currently connected directly (for status UIs). */
  p2pPeers(): PeerInfo[] {
    return this.#p2p?.peers() ?? []
  }

  // ---- NIP-77 + gap repair ------------------------------------------------------------

  protected override async afterCatchUp(relay: string): Promise<void> {
    await this.reconcile(relay)
  }

  /**
   * Layer 1: NIP-77 set reconciliation with one relay (fetch what we miss, upload what it misses).
   * Layer 3: if sequence gaps remain, do a deep re-fetch from all relays (rate limited).
   * Returns whether the relay supports NIP-77.
   */
  async reconcile(relay: string): Promise<boolean> {
    const pool = this.sync?.pool
    if (!pool || this.closed || this.#reconciling.has(relay)) return false
    this.#reconciling.add(relay)
    try {
      let supported = false
      if (!this.#negUnsupported.has(relay)) {
        const tags = this.subscriptionTags()
        const res = tags.length ? await pool.negentropy(relay, { kinds: [WRAP_KIND], [`#${TAG}`]: tags }, this.store.rawIndex(tags)) : null
        if (!res) this.#negUnsupported.add(relay)
        else {
          supported = true
          // Relays cap results per REQ even for id lookups: keep asking for what is still missing.
          let remaining = new Set(res.need)
          while (remaining.size > 0) {
            const ids = [...remaining].slice(0, 100)
            const events = await pool.query([{ ids }], { relays: [relay] })
            let progress = false
            for (const e of events) {
              if (!remaining.delete(e.id)) continue
              progress = true
              this.ingestGated(relay, e)
            }
            if (!progress) break
          }
          remaining = new Set()
          const uploads = res.have.map((id) => this.store.getRaw(id)).filter((e): e is NostrEvent => e !== undefined)
          await Promise.all(uploads.map((e) => pool.publish(e, [relay])))
        }
      }
      if (this.syncHealth().gaps.length > 0 && this.now() - this.#lastRepair > 10 * 60_000) await this.repair()
      return supported
    } finally {
      this.#reconciling.delete(relay)
    }
  }

  /** Layer 3: messages known to exist (by per-device sequence numbers) but not received. */
  syncHealth(): { gaps: SyncGap[]; nip77: Record<string, boolean> } {
    const gaps: SyncGap[] = []
    for (const s of this.store.spaces()) {
      if (s.status !== 'active') continue
      const cover = this.snapshotCoverage(s.id)
      for (const [device, max] of Object.entries(this.store.deviceMaxSeqs(s.id))) {
        if (device === this.devicePubkey) continue
        const have = new Set(
          this.store.driver.all<{ seq: number }>('SELECT seq FROM anodb_messages WHERE space = ? AND device = ?', [s.id, device]).map((r) => r.seq),
        )
        const missing: number[] = []
        for (let q = (cover.get(device) ?? 0) + 1; q <= max && missing.length < 100; q++) if (!have.has(q)) missing.push(q)
        if (missing.length) gaps.push({ space: s.id, device, missing })
      }
    }
    const nip77 = Object.fromEntries((this.sync?.pool.relays ?? []).map((r) => [r, !this.#negUnsupported.has(r)]))
    return { gaps, nip77 }
  }

  /** Deep re-fetch of every stream from every connected relay (ignores cursors). */
  async repair(): Promise<void> {
    const pool = this.sync?.pool
    if (!pool) return
    this.#lastRepair = this.now()
    const tags = this.subscriptionTags()
    if (tags.length === 0) return
    await Promise.all(
      pool.connected().map(async (relay) => {
        let until: number | undefined
        for (let page = 0; page < 1000; page++) {
          const f: Filter = { kinds: [WRAP_KIND], [`#${TAG}`]: tags, limit: BACKFILL_PAGE }
          if (until !== undefined) f.until = until
          const events = await pool.query([f], { relays: [relay] })
          if (events.length === 0) break
          let fresh = 0
          for (const e of events) if (this.ingestGated(relay, e) === 'new') fresh++
          const oldest = Math.min(...events.map((e) => e.created_at))
          if (fresh === 0 && until !== undefined && oldest >= until) until -= 1
          else until = oldest
          if (until <= 0) break
        }
      }),
    )
  }

  // ---- pruneOldEvents (NIP-09) ---------------------------------------------------------

  /** Envelope keys are derived from the device key + a random salt so they can sign deletions later. */
  protected override wrap(innerJson: string, tag: string, convKey: Uint8Array, signerSk?: Uint8Array): NostrEvent {
    if (!this.opts.pruneOldEvents || signerSk || this.opts.metadataProtection === 'none') return super.wrap(innerJson, tag, convKey, signerSk)
    const salt = randomHex(16)
    const ev = super.wrap(innerJson, tag, convKey, this.#pruneKey(salt))
    this.store.putPrunable(ev.id, salt, tag, ev.created_at)
    return ev
  }

  protected override resignEnvelope(e: NostrEvent): NostrEvent {
    if (!this.opts.pruneOldEvents || this.opts.metadataProtection === 'none') return super.resignEnvelope(e)
    const tag = e.tags.find((t) => t[0] === TAG)?.[1] ?? ''
    const salt = randomHex(16)
    const ev = signWith(this.#pruneKey(salt), { kind: e.kind, tags: e.tags, content: e.content, created_at: Math.floor(this.now() / 1000) })
    this.store.putPrunable(ev.id, salt, tag, ev.created_at)
    return ev
  }

  #pruneKey(salt: string): Uint8Array {
    return hexToBytes(sha256Hex(`anodb/v2/prune/${bytesToHex(this.deviceSk)}/${salt}`))
  }

  protected override afterSnapshot(space: string, before: number): void {
    if (!this.opts.pruneOldEvents || !this.sync) return
    const tags = (this.keysBySpace.get(space) ?? []).map((k) => k.tag)
    for (const p of this.store.prunable(tags, before)) {
      const del = signWith(this.#pruneKey(p.salt), {
        kind: 5,
        created_at: Math.floor(this.now() / 1000),
        tags: [['e', p.eventId], ['k', String(WRAP_KIND)]],
        content: '',
      })
      this.store.enqueue(del, false)
      this.store.forgetPrunable(p.eventId)
    }
    void this.sync.flush()
  }

  // ---- public tables ----------------------------------------------------------------------

  // ---- ephemeral events --------------------------------------------------------------

  /**
   * Send an ephemeral event to the members of `space` who are online ("typing…", presence).
   * Not stored, not synced later; delivered at most once per listener. Any member may send.
   */
  async emit(space: string, type: string, data: unknown = null): Promise<void> {
    this.assertOpen()
    if (!this.roleOf(space, this.pubkey)) throw new Error(`anoDB: not a member of space ${space}`)
    const pool = this.sync?.pool
    if (!pool) return
    const k = this.currentKey(space)
    const e = sealEvent(this.deviceSk, { v: 2, sp: space, ep: k.keyId, type, d: data, dlg: this.delegation }, k.tag, k.key, Math.floor(this.now() / 1000), TAG)
    await pool.publish(e)
  }

  /**
   * Listen to ephemeral events (from other devices; your own `emit` is not echoed). Filter by
   * space and / or type. Returns an unsubscribe function.
   */
  onEvent<T = unknown>(fn: (e: SpaceEvent<T>) => void, filter: { space?: string; type?: string } = {}): () => void {
    const entry = { fn: fn as (e: SpaceEvent) => void, ...filter }
    this.#eventListeners.add(entry)
    this.#refreshEvents()
    if (!this.#eventTimer) {
      this.#eventTimer = setInterval(() => this.#refreshEvents(), 2000) // epoch keys and spaces change
      ;(this.#eventTimer as { unref?: () => void }).unref?.()
    }
    return () => {
      this.#eventListeners.delete(entry)
      if (this.#eventListeners.size === 0) {
        this.#eventUnsub?.()
        this.#eventUnsub = null
        this.#eventKey = ''
        if (this.#eventTimer) clearInterval(this.#eventTimer)
        this.#eventTimer = null
      }
    }
  }

  /** The sync engine asks for its tags whenever spaces or keys change: follow with the event subscription. */
  protected override subscriptionTags(): string[] {
    const tags = super.subscriptionTags()
    if (this.#eventListeners.size > 0) queueMicrotask(() => this.#refreshEvents())
    return tags
  }

  #spaceTags(): string[] {
    const active = new Set(this.store.spaces().filter((s) => s.status === 'active').map((s) => s.id))
    return [...this.keysByTag.values()].filter((k) => active.has(k.space)).map((k) => k.tag)
  }

  #refreshEvents(): void {
    const pool = this.sync?.pool
    if (!pool || this.closed || this.#eventListeners.size === 0) return
    const tags = this.#spaceTags()
    const key = tags.sort().join(',')
    if (key === this.#eventKey) return
    this.#eventKey = key
    this.#eventUnsub?.()
    this.#eventUnsub = tags.length
      ? pool.subscribe(() => [{ kinds: [EVENT_KIND], [`#${TAG}`]: this.#spaceTags(), since: Math.floor(this.now() / 1000) - EVENT_MAX_AGE_SEC }], {
          onEvent: (_relay, e) => this.#onEphemeral(e),
        })
      : null
  }

  #onEphemeral(outer: NostrEvent): void {
    if (this.closed) return
    const tag = outer.tags.find((t) => t[0] === TAG)?.[1]
    const k = tag ? this.keysByTag.get(tag) : undefined
    if (!k) return
    const e = openEvent(outer, k.key, k.space, k.keyId, Math.floor(this.now() / 1000))
    if (!e || e.device === this.devicePubkey || this.#seenEvents.has(e.id)) return
    this.#seenEvents.add(e.id)
    if (this.#seenEvents.size > 2000) this.#seenEvents.delete(this.#seenEvents.values().next().value!)
    if (!this.roleOf(e.space, e.from) && e.from !== this.pubkey) return // members only
    const { id: _id, ...event } = e
    for (const l of [...this.#eventListeners]) {
      if ((l.space && l.space !== e.space) || (l.type && l.type !== e.type)) continue
      try {
        l.fn(event)
      } catch {}
    }
  }

  override async close(): Promise<void> {
    this.#eventUnsub?.()
    if (this.#eventTimer) clearInterval(this.#eventTimer)
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer)
    await this.#p2p?.close()
    await super.close()
  }
}

export async function createAnoDB<const S extends SchemaDefinition>(opts: AnoDBOptions<S>): Promise<AnoDB<S>> {
  const db = new AnoDB<S>(await prepare(opts))
  await db._init()
  return db
}
