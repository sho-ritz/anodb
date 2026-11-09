import { verifySignedEvent } from './crypto.js'
import type { Signer } from './signer.js'
import { DEFAULT_DISCOVERY_RELAYS } from './defaults.js'
import { type Filter, type RelayPool, normalizeRelayUrl } from './relay-pool.js'
import type { Store } from './store.js'
import type { FetchStatus, NostrEvent } from './types.js'

export const KIND_PROFILE = 0
export const KIND_NOTE = 1
export const KIND_RELAY_LIST = 10002

/** NIP-01 kind 0 metadata. Unknown fields are preserved. */
export interface Profile {
  name?: string
  display_name?: string
  about?: string
  picture?: string
  banner?: string
  website?: string
  nip05?: string
  lud16?: string
  [key: string]: unknown
}

export interface RelayList {
  read: string[]
  write: string[]
}

export interface Fetched<T> {
  value: T | null
  event: NostrEvent | null
  /** `synced`: fresh from relays. `stale`: relays unreachable/empty, cached copy returned. `unavailable`: nothing anywhere. */
  status: FetchStatus
  /** When the cached copy was last confirmed (ms), or null. */
  fetchedAt: number | null
}

export interface FetchOptions {
  /** Return the cache without asking relays if it is younger than this. Default 10 min. */
  maxAgeMs?: number
  timeoutMs?: number
  /** Extra relays to ask. */
  relays?: readonly string[]
}

interface Deps {
  store: Store
  signer: () => Signer
  pool: RelayPool | null
  discoveryRelays: readonly string[] | undefined
  now: () => number
  enqueue: (event: NostrEvent) => void
}

/**
 * Standard Nostr events (profiles, notes, NIP-65 relay lists): readable and writable by any
 * Nostr client. Fetched data is cached in the local SQLite so it is available offline.
 */
export class PublicData {
  readonly #d: Deps

  constructor(deps: Deps) {
    this.#d = deps
  }

  // ---- read ------------------------------------------------------------------

  /** Cached kind 0 without touching the network. */
  cachedProfile(pubkey: string): Profile | null {
    const c = this.#d.store.getPublic(pubkey, KIND_PROFILE)
    return c ? parseProfile(c.event) : null
  }

  async getProfile(pubkey: string, opts: FetchOptions = {}): Promise<Fetched<Profile>> {
    const r = await this.#getReplaceable(pubkey, KIND_PROFILE, opts, true)
    return { ...r, value: r.event ? parseProfile(r.event) : null }
  }

  async getRelayList(pubkey: string, opts: FetchOptions = {}): Promise<Fetched<RelayList>> {
    const r = await this.#getReplaceable(pubkey, KIND_RELAY_LIST, opts, false)
    return { ...r, value: r.event ? parseRelayList(r.event) : null }
  }

  /** Recent kind 1 notes by `pubkey`, from the pool and the author's NIP-65 write relays. */
  async getNotes(pubkey: string, opts: { limit?: number; since?: number; timeoutMs?: number } = {}): Promise<NostrEvent[]> {
    const relays = await this.#authorRelays(pubkey, opts.timeoutMs)
    const filter: Filter = { kinds: [KIND_NOTE], authors: [pubkey], limit: opts.limit ?? 20 }
    if (opts.since !== undefined) filter.since = opts.since
    const events = await this.fetch([filter], { relays, timeoutMs: opts.timeoutMs })
    return events.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, filter.limit)
  }

  /** One-shot query; returns only events with valid signatures. */
  async fetch(filters: Filter[], opts: { relays?: readonly string[]; timeoutMs?: number | undefined } = {}): Promise<NostrEvent[]> {
    const pool = this.#d.pool
    if (!pool) return []
    const q: { relays?: readonly string[]; timeoutMs?: number } = {}
    if (opts.relays) q.relays = opts.relays
    if (opts.timeoutMs !== undefined) q.timeoutMs = opts.timeoutMs
    const events = await pool.query(filters, q)
    return events.filter(verifySignedEvent)
  }

  async #getReplaceable(pubkey: string, kind: number, opts: FetchOptions, discover: boolean): Promise<Omit<Fetched<never>, 'value'>> {
    const { store, now } = this.#d
    const cached = store.getPublic(pubkey, kind)
    const maxAge = opts.maxAgeMs ?? 10 * 60_000
    if (cached && now() - cached.fetchedAt < maxAge) {
      return { event: cached.event, status: 'synced', fetchedAt: cached.fetchedAt }
    }
    let relays = this.#baseRelays(opts.relays)
    if (discover) relays = unique([...relays, ...(await this.#authorRelays(pubkey, opts.timeoutMs))])
    const events = (await this.fetch([{ kinds: [kind], authors: [pubkey] }], { relays, timeoutMs: opts.timeoutMs }))
      .filter((e) => e.pubkey === pubkey && e.kind === kind)
    const best = newest(events)
    if (best) {
      const t = now()
      store.putPublic(best, pubkey, kind, t)
      const after = store.getPublic(pubkey, kind)!
      return { event: after.event, status: 'synced', fetchedAt: t }
    }
    if (cached) return { event: cached.event, status: 'stale', fetchedAt: cached.fetchedAt }
    return { event: null, status: 'unavailable', fetchedAt: null }
  }

  /** Pool relays + discovery relays + the author's NIP-65 write relays. */
  async #authorRelays(pubkey: string, timeoutMs: number | undefined): Promise<string[]> {
    const opts: FetchOptions = {}
    if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs
    const list = await this.getRelayList(pubkey, opts)
    return unique([...this.#baseRelays(), ...(list.value?.write ?? [])])
  }

  #baseRelays(extra: readonly string[] = []): string[] {
    const pool = this.#d.pool?.relays ?? []
    return unique([...pool, ...(this.#d.discoveryRelays ?? DEFAULT_DISCOVERY_RELAYS), ...extra])
  }

  // ---- write -----------------------------------------------------------------
  // Signed with the owner key and delivered through the durable outbox.

  async publishProfile(profile: Profile): Promise<NostrEvent> {
    const event = await this.#sign(KIND_PROFILE, JSON.stringify(profile), [])
    this.#d.store.putPublic(event, event.pubkey, KIND_PROFILE, this.#d.now())
    this.#d.enqueue(event)
    return event
  }

  async publishNote(content: string, tags: string[][] = []): Promise<NostrEvent> {
    const event = await this.#sign(KIND_NOTE, content, tags)
    this.#d.enqueue(event)
    return event
  }

  async publishRelayList(list: RelayList): Promise<NostrEvent> {
    const read = new Set(list.read.map(normalizeRelayUrl))
    const write = new Set(list.write.map(normalizeRelayUrl))
    const tags: string[][] = []
    for (const r of unique([...read, ...write])) {
      if (read.has(r) && write.has(r)) tags.push(['r', r])
      else tags.push(['r', r, read.has(r) ? 'read' : 'write'])
    }
    const event = await this.#sign(KIND_RELAY_LIST, '', tags)
    this.#d.store.putPublic(event, event.pubkey, KIND_RELAY_LIST, this.#d.now())
    this.#d.enqueue(event)
    return event
  }

  #sign(kind: number, content: string, tags: string[][]): Promise<NostrEvent> {
    return this.#d.signer().signEvent({ kind, content, tags, created_at: Math.floor(this.#d.now() / 1000) })
  }
}

function newest(events: NostrEvent[]): NostrEvent | undefined {
  // NIP-01: highest created_at wins; ties broken by lowest id.
  return events.reduce<NostrEvent | undefined>(
    (best, e) => (!best || e.created_at > best.created_at || (e.created_at === best.created_at && e.id < best.id) ? e : best),
    undefined,
  )
}

function unique(urls: readonly string[]): string[] {
  const out = new Set<string>()
  for (const u of urls) {
    try {
      out.add(normalizeRelayUrl(u))
    } catch {
      /* skip malformed relay URLs from untrusted relay lists */
    }
  }
  return [...out]
}

export function parseProfile(event: NostrEvent): Profile | null {
  try {
    const p = JSON.parse(event.content) as unknown
    return typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Profile) : null
  } catch {
    return null
  }
}

export function parseRelayList(event: NostrEvent): RelayList {
  const read: string[] = []
  const write: string[] = []
  for (const t of event.tags) {
    if (t[0] !== 'r' || typeof t[1] !== 'string') continue
    let url: string
    try {
      url = normalizeRelayUrl(t[1])
    } catch {
      continue
    }
    if (t[2] !== 'write') read.push(url)
    if (t[2] !== 'read') write.push(url)
  }
  return { read, write }
}
