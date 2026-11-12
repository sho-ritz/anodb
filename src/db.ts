import { CompiledQuery, type Compilable, type Kysely, type RootOperationNode } from 'kysely'
import { BlobStore, DEFAULT_BLOB_SERVERS } from './blob.js'
import { type CapturedCell, beginCapture, endCapture, fromCaptured, installCapture } from './capture.js'
import {
  bytesToHex,
  conversationKey,
  decrypt,
  encrypt,
  generateSecretKey,
  getPublicKey,
  inboxTag,
  keyId,
  npubEncode,
  nsecEncode,
  parseSecretKey,
  randomBytes,
  randomHex,
  signWith,
  spaceTag,
  verifySignedEvent,
} from './crypto.js'
import { DEFAULT_RELAYS } from './defaults.js'
import { Clock } from './hlc.js'
import { createDelegation, isEvent, verifyDelegation } from './identity.js'
import { type Role, spaceIdFor } from './membership.js'
import { browserKeyStore } from './keystore/browser.js'
import { envKeyStore } from './keystore/env.js'
import type { KeyStore } from './keystore/types.js'
import { type KyselyDatabase, type SqlExecutor, createKysely } from './kysely.js'
import { resultConverter } from './result-types.js'
import { type Change, MESSAGE_KIND, type StreamPayload, TAG, WRAP_KIND, byteLength, parseStreamPayload, splitChanges } from './protocol.js'
import type { P2POptions } from './p2p.js'
import { PublicData } from './public.js'
import { presetOf } from './public-tables.js'
import { changeAllowed, policyMessage } from './policy.js'
import { RelayPool, type RelayPoolOptions } from './relay-pool.js'
import { SYS_CREATED, SYS_DELETED, validateSchema } from './schema.js'
import { type Signer, localSigner } from './signer.js'
import { Store } from './store.js'
import { type IngestResult, SyncEngine, type SyncHost } from './sync.js'
import type { NostrEvent, SchemaDefinition, SqlValue, SqliteDriver, SyncStatus } from './types.js'

export interface AnoDBOptions<S extends SchemaDefinition> {
  /** Application namespace. Different appIds never share spaces. */
  appId: string
  schema: S
  driver: SqliteDriver
  /**
   * Where keys live. Default: browserKeyStore() when IndexedDB exists (browsers, Tauri), otherwise
   * envKeyStore() (Node: ANODB_DEVICE_KEY / ANODB_DELEGATION from `npx @anodb/cli init`).
   */
  keyStore?: KeyStore
  /**
   * `'stored'` (default): the identity key is kept in the key store (encrypted).
   * `'recovery'`: the identity key is handed to `onRecoveryKey` once and never stored on the device.
   */
  identity?: 'stored' | 'recovery'
  onRecoveryKey?: (nsec: string) => void
  /** External identity signer (NIP-07 / NIP-46 / NIP-55). Only needed for identity operations. */
  signer?: Signer
  /** Human-readable name of this device, shown to the owner. */
  deviceName?: string
  /** `'wrap'` (default): envelopes are signed by throwaway keys. `'none'`: signed by the device key. */
  metadataProtection?: 'wrap' | 'none'
  relays?: readonly string[]
  discoveryRelays?: readonly string[]
  /** A write leaves the outbox after this many relays accepted it. Default: min(2, relays.length). */
  minAcks?: number
  retryIntervalMs?: number
  relayOptions?: RelayPoolOptions
  /**
   * Ask relays (NIP-09) to delete own envelopes that a snapshot superseded. Off by default: relays
   * may ignore it, and old envelopes are unreadable without old keys anyway.
   */
  pruneOldEvents?: boolean
  /**
   * Direct WebRTC sync between devices (via nostr-p2p). Default where WebRTC exists:
   * `{ mode: 'own-devices' }`. `'members'` also connects to other members (they see your IP).
   */
  p2p?: P2POptions
  /** Blossom servers for encrypted files (`db.blobs`). Default: DEFAULT_BLOB_SERVERS. */
  blobServers?: readonly string[]
  /** fetch implementation for Blossom (tests / custom networking). */
  fetch?: typeof fetch
  /** How often to run NIP-77 reconciliation with connected relays. Default 10 min. */
  reconcileIntervalMs?: number
  /** Wall clock in ms. For tests. */
  now?: () => number
}

export type ChangeListener = (tables: ReadonlySet<string>, origin: 'local' | 'remote') => void
export type ErrorListener = (error: AnoDBError) => void
export type StatusListener = (status: SyncStatus) => void

export type AnoDBErrorCode = 'publish-rejected' | 'invalid-event' | 'unauthorized' | 'decrypt-failed' | 'unsupported-protocol' | 'tab-locked' | 'own-invite'

export class AnoDBError extends Error {
  readonly code: AnoDBErrorCode
  readonly eventId: string | undefined
  constructor(code: AnoDBErrorCode, message: string, eventId?: string) {
    super(message)
    this.name = 'AnoDBError'
    this.code = code
    this.eventId = eventId
  }
}

export interface EpochKey {
  space: string
  keyId: string
  num: number
  key: Uint8Array
  tag: string
  createdAt: number
}

export interface SpaceInfo {
  id: string
  name: string
  personal: boolean
  status: string
}

type Query = Compilable | { sql: string; parameters?: readonly unknown[] } | string

/** Defers work while a capture transaction is open across awaits (Kysely transactions). */
class Gate {
  #busy = false
  #waiters: Array<() => void> = []
  get busy(): boolean {
    return this.#busy
  }
  close(): void {
    this.#busy = true
  }
  open(): void {
    this.#busy = false
    for (const w of this.#waiters.splice(0)) w()
  }
  idle(): Promise<void> {
    return this.#busy ? new Promise((r) => this.#waiters.push(r)) : Promise.resolve()
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Resolve keys (device, delegation, identity) and open the store. Shared with subclasses. */
export async function prepare<S extends SchemaDefinition>(opts: AnoDBOptions<S>): Promise<Internals<S>> {
  if (!opts.appId) throw new Error('anoDB: appId is required')
  validateSchema(opts.schema)
  const now = opts.now ?? Date.now
  const store = new Store(opts.driver)
  const keyStore = opts.keyStore ?? defaultKeyStore(opts.appId)
  const mode = opts.identity ?? 'stored'

  let deviceHex = await keyStore.get('device')
  let delegationJson = await keyStore.get('delegation')
  const storedIdentity = await keyStore.get('identity')
  let identitySigner: Signer | null = opts.signer ?? (storedIdentity ? localSigner(storedIdentity) : null)

  if (!deviceHex || !delegationJson) {
    let newIdentity: Uint8Array | null = null
    if (!identitySigner) {
      if (mode === 'recovery' && !opts.onRecoveryKey) {
        throw new Error("anoDB: identity: 'recovery' requires onRecoveryKey to hand the key to the user")
      }
      newIdentity = generateSecretKey()
      identitySigner = localSigner(newIdentity)
    }
    const deviceSk = generateSecretKey()
    const delegation = await createDelegation(identitySigner, getPublicKey(deviceSk), opts.deviceName ?? 'device', now())
    deviceHex = bytesToHex(deviceSk)
    delegationJson = JSON.stringify(delegation)
    await keyStore.set('device', deviceHex)
    await keyStore.set('delegation', delegationJson)
    if (newIdentity) {
      if (mode === 'recovery') {
        opts.onRecoveryKey!(nsecEncode(newIdentity))
        identitySigner = null // never kept on this device
      } else {
        await keyStore.set('identity', bytesToHex(newIdentity))
      }
    }
  }
  const deviceSk = parseSecretKey(deviceHex)
  const devicePk = getPublicKey(deviceSk)
  const delegation = JSON.parse(delegationJson) as unknown
  const identity = verifyDelegation(delegation, devicePk)
  if (!identity || !isEvent(delegation)) throw new Error('anoDB: stored delegation does not match the device key')
  if (identitySigner && (await identitySigner.getPublicKey()) !== identity) {
    throw new Error('anoDB: signer / identity key does not belong to this device’s identity')
  }
  const owner = store.getMeta('identity')
  if (owner && owner !== identity) throw new Error('anoDB: this database belongs to a different identity')
  store.setMeta('identity', identity)
  return { opts, store, keyStore, deviceSk, devicePk, identity, delegation, identitySigner, now }
}

function defaultKeyStore(appId: string): KeyStore {
  if (typeof indexedDB !== 'undefined') return browserKeyStore(`anodb-${appId}`)
  return envKeyStore()
}

export interface Internals<S extends SchemaDefinition> {
  opts: AnoDBOptions<S>
  store: Store
  keyStore: KeyStore
  deviceSk: Uint8Array
  devicePk: string
  identity: string
  delegation: NostrEvent
  identitySigner: Signer | null
  now: () => number
}

export class AnoDBCore<S extends SchemaDefinition> {
  readonly appId: string
  readonly schema: S
  /** Identity public key (hex). */
  readonly pubkey: string
  readonly npub: string
  readonly devicePubkey: string
  /** Public Nostr data (profiles, notes, relay lists). */
  readonly nostr: PublicData
  /** Encrypted files on Blossom servers; store the returned reference in a `json` column. */
  readonly blobs: BlobStore

  protected readonly store: Store
  protected readonly keyStore: KeyStore
  protected readonly deviceSk: Uint8Array
  protected readonly delegation: NostrEvent
  protected identitySigner: Signer | null
  protected readonly now: () => number
  protected readonly clock: Clock
  protected readonly sync: SyncEngine | null
  protected readonly gate = new Gate()
  protected readonly keysByTag = new Map<string, EpochKey>()
  protected readonly keysBySpace = new Map<string, EpochKey[]>()
  protected readonly opts: AnoDBOptions<S>
  protected readonly kysely: Kysely<KyselyDatabase<S>>
  protected personal = ''
  readonly #changeListeners = new Set<ChangeListener>()
  readonly #errorListeners = new Set<ErrorListener>()
  readonly #statusListeners = new Set<StatusListener>()
  readonly #deferred: Array<() => void> = []
  readonly #pendingNotify = new Set<string>()
  #closed = false
  #lastStatus = ''

  constructor(i: Internals<S>) {
    this.opts = i.opts
    this.appId = i.opts.appId
    this.schema = i.opts.schema
    this.store = i.store
    this.keyStore = i.keyStore
    this.deviceSk = i.deviceSk
    this.devicePubkey = i.devicePk
    this.pubkey = i.identity
    this.npub = npubEncode(i.identity)
    this.delegation = i.delegation
    this.identitySigner = i.identitySigner
    this.now = i.now
    let nodeId = this.store.getMeta('node_id')
    if (!nodeId) {
      nodeId = randomHex(8)
      this.store.setMeta('node_id', nodeId)
    }
    this.clock = new Clock(nodeId, this.store.getMeta('hlc'), this.now)
    const relays = i.opts.relays ?? DEFAULT_RELAYS
    const pool = relays.length > 0 ? new RelayPool(relays, i.opts.relayOptions) : null
    this.sync = pool
      ? new SyncEngine(this.store, pool, this.syncHost(), {
          minAcks: Math.max(1, Math.min(i.opts.minAcks ?? 2, relays.length)),
          retryIntervalMs: i.opts.retryIntervalMs ?? 30_000,
        })
      : null
    this.kysely = createKysely<S>(this.executor(), this.schema)
    this.blobs = new BlobStore({
      deviceSk: i.deviceSk,
      servers: i.opts.blobServers ?? DEFAULT_BLOB_SERVERS,
      ...(i.opts.fetch ? { fetch: i.opts.fetch } : {}),
    })
    this.nostr = new PublicData({
      store: this.store,
      signer: () => this.requireIdentitySigner(),
      pool,
      discoveryRelays: i.opts.discoveryRelays,
      now: this.now,
      enqueue: (event) => this.enqueuePlain(event),
    })
  }

  /** @internal */
  async _init(): Promise<void> {
    await this.loadKeys()
    let personal = this.store.spaces().find((s) => s.personal && s.status === 'active')
    if (!personal) {
      const id = await this.createSpaceInternal('personal', true)
      personal = { id, name: 'personal', personal: true, status: 'active' }
    }
    this.setPersonal(personal.id)
    await this.afterInit()
    this.sync?.start()
  }

  /** Extension point for subclasses. */
  protected async afterInit(): Promise<void> {}

  /** Switch the default (personal) space; rebuilds projections and their capture triggers. */
  protected setPersonal(space: string): void {
    this.personal = space
    this.store.applySchema(this.schema, space, this.pubkey)
    installCapture(this.store.driver, this.schema)
  }

  // ---- SQL-like API (Kysely) ------------------------------------------------

  get selectFrom(): Kysely<KyselyDatabase<S>>['selectFrom'] {
    return this.kysely.selectFrom.bind(this.kysely)
  }
  get insertInto(): Kysely<KyselyDatabase<S>>['insertInto'] {
    return this.kysely.insertInto.bind(this.kysely)
  }
  get updateTable(): Kysely<KyselyDatabase<S>>['updateTable'] {
    return this.kysely.updateTable.bind(this.kysely)
  }
  get deleteFrom(): Kysely<KyselyDatabase<S>>['deleteFrom'] {
    return this.kysely.deleteFrom.bind(this.kysely)
  }
  get with(): Kysely<KyselyDatabase<S>>['with'] {
    return this.kysely.with.bind(this.kysely)
  }
  get transaction(): Kysely<KyselyDatabase<S>>['transaction'] {
    return this.kysely.transaction.bind(this.kysely)
  }
  /** The underlying Kysely instance (for `sql` template tags, `fn`, …). */
  get db(): Kysely<KyselyDatabase<S>> {
    return this.kysely
  }

  /** Raw SQL (read or write). Writes are captured, permission-checked and synced. */
  async execute<R = Record<string, SqlValue>>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    const r = await this.kysely.executeQuery<R>(CompiledQuery.raw(sql, [...params]))
    return r.rows
  }

  /** Re-runs `query` whenever a table it mentions changes (locally or from sync). */
  subscribe<R>(
    query: Compilable<R> | { sql: string; parameters?: readonly unknown[] } | string,
    cb: (rows: R[]) => void,
    onError?: (e: unknown) => void,
  ): () => void {
    const compiled = compileQuery(query)
    // Kysely queries keep typed results (booleans, JSON) even though they re-run as raw SQL here.
    const node = (compiled as { query?: RootOperationNode }).query
    const convert = node ? resultConverter(this.schema, node) : null
    const tables = new Set(Object.keys(this.schema).filter((t) => compiled.sql.includes(`"${t}"`) || new RegExp(`\\b${t}\\b`).test(compiled.sql)))
    let alive = true
    const run = () => {
      this.kysely
        .executeQuery<R>(CompiledQuery.raw(compiled.sql, [...compiled.parameters]))
        .then((r) => alive && cb(convert ? (r.rows.map((row) => convert(row as Record<string, unknown>)) as R[]) : r.rows))
        .catch((e) => onError?.(e))
    }
    const listener: ChangeListener = (changed) => {
      for (const t of changed) if (tables.has(t)) return run()
    }
    this.#changeListeners.add(listener)
    run()
    return () => {
      alive = false
      this.#changeListeners.delete(listener)
    }
  }

  protected executor(): SqlExecutor {
    const drv = () => this.store.driver
    return {
      execute: async (sql, params) => {
        this.assertOpen()
        await this.gate.idle()
        beginCapture(drv())
        let rows: Record<string, SqlValue>[]
        let cells: CapturedCell[]
        try {
          rows = drv().all<Record<string, SqlValue>>(sql, params)
        } finally {
          cells = endCapture(drv())
        }
        if (cells.length > 0) await this.commitCaptured(cells)
        return { rows, changedRows: countRows(cells) }
      },
      begin: async () => {
        this.assertOpen()
        await this.gate.idle()
        this.gate.close()
        beginCapture(drv())
      },
      executeInTransaction: (sql, params) => {
        const count = () => drv().all<{ n: number }>('SELECT COUNT(*) AS n FROM temp.anodb_cap')[0]!.n
        const before = count()
        const rows = drv().all<Record<string, SqlValue>>(sql, params)
        return { rows, changedRows: count() > before ? 1 : 0 }
      },
      commit: async () => {
        const cells = endCapture(drv())
        this.reopenGate()
        if (cells.length > 0) await this.commitCaptured(cells)
      },
      rollback: async () => {
        endCapture(drv())
        this.reopenGate()
      },
    }
  }

  protected reopenGate(): void {
    this.gate.open()
    for (const fn of this.#deferred.splice(0)) fn()
    if (this.#pendingNotify.size > 0) this.notify(new Set(), 'remote')
  }

  /** Validate captured cells and commit them as signed, encrypted messages. */
  protected async commitCaptured(cells: CapturedCell[]): Promise<void> {
    const bySpace = new Map<string, Change[]>()
    const touched = new Set<string>()
    const nowMs = this.now()
    const writable = new Set<string>()
    const publicCells: CapturedCell[] = []
    for (const c of cells) {
      const def = this.schema[c.table]
      if (!def) continue
      if (presetOf(def)) {
        publicCells.push(c)
        continue
      }
      if (!ID_RE.test(c.rowId)) throw new Error(`anoDB: invalid row id "${c.rowId}" (1–128 chars of A-Z a-z 0-9 _ -)`)
      if (!writable.has(c.space)) {
        this.assertCanWrite(c.space)
        writable.add(c.space)
      }
      let value: unknown
      if (c.column === SYS_DELETED) value = true
      else if (c.column === SYS_CREATED) value = nowMs
      else value = fromCaptured(c.table, c.column, def[c.column]!, c.value)
      let list = bySpace.get(c.space)
      if (!list) bySpace.set(c.space, (list = []))
      const change: Change = [c.table, c.rowId, c.column, value, this.clock.tick()]
      // Same row-level rule every other device applies: refuse here instead of sending a change they would drop.
      if (!changeAllowed(this.schema, change, this.pubkey, this.roleOf(c.space, this.pubkey))) throw new AnoDBError('unauthorized', policyMessage(change))
      list.push(change)
      touched.add(c.table)
    }
    await this.gate.idle()
    this.store.transaction(() => {
      for (const [space, changes] of bySpace) {
        this.store.applyChanges(space, changes, this.pubkey)
        for (const batch of splitChanges(changes)) this.sendToSpace(space, 'ch', { c: batch })
      }
      this.store.setMeta('hlc', this.clock.current())
    })
    this.notify(touched, 'local')
    this.afterLocalWrite([...bySpace.keys()])
    if (publicCells.length > 0) await this.commitPublic(publicCells)
    void this.sync?.flush()
  }

  /** Writes to public tables become signed standard Nostr events (implemented by AnoDB). */
  protected async commitPublic(_cells: CapturedCell[]): Promise<void> {
    throw new Error('anoDB: public tables are not supported by this build')
  }

  /** Hook (v0.3: automatic snapshots / key rotation). */
  protected afterLocalWrite(_spaces: string[]): void {}

  /** Throws unless this device may write to `space`. */
  protected assertCanWrite(space: string): void {
    const s = this.store.spaces().find((x) => x.id === space)
    if (!s || s.status !== 'active') throw new Error(`anoDB: unknown or inactive space "${space}"`)
    if (!this.isAuthorizedWriter(space, this.pubkey, this.devicePubkey, Number.MAX_SAFE_INTEGER)) {
      throw new Error(`anoDB: no write permission in space ${space}`)
    }
  }

  // ---- spaces & keys ----------------------------------------------------------

  /** Id of this identity's personal space (default for inserts). */
  get personalSpace(): string {
    return this.personal
  }

  spaces(): SpaceInfo[] {
    return this.store.spaces()
  }

  protected async loadKeys(): Promise<void> {
    for (const k of this.store.keys()) {
      const key = await this.keyStore.open(k.sealed)
      this.addKey({ space: k.space, keyId: k.keyId, num: k.num, key, tag: spaceTag(key), createdAt: k.createdAt })
    }
  }

  protected addKey(k: EpochKey): boolean {
    if (this.keysByTag.has(k.tag)) return false
    this.keysByTag.set(k.tag, k)
    const list = this.keysBySpace.get(k.space) ?? []
    list.push(k)
    list.sort((a, b) => b.num - a.num || (a.keyId < b.keyId ? -1 : 1))
    this.keysBySpace.set(k.space, list)
    return true
  }

  protected async storeKey(space: string, key: Uint8Array, num: number): Promise<EpochKey> {
    const k: EpochKey = { space, keyId: keyId(key), num, key, tag: spaceTag(key), createdAt: Date.now() }
    if (this.keysByTag.has(k.tag)) return this.keysByTag.get(k.tag)!
    const sealed = await this.keyStore.seal(key)
    await this.gate.idle()
    this.store.putKey(space, k.keyId, num, sealed)
    this.addKey(k)
    return k
  }

  /** Current epoch key of a space: highest number, ties by lowest key id. */
  protected currentKey(space: string): EpochKey {
    const k = this.keysBySpace.get(space)?.[0]
    if (!k) throw new Error(`anoDB: no key for space ${space}`)
    return k
  }

  /** Create a space whose id commits to this identity (so nobody else can claim to own it). */
  protected async createSpaceInternal(name: string, personal: boolean): Promise<string> {
    const nonce = randomHex(16)
    const id = spaceIdFor(this.pubkey, nonce)
    await this.storeKey(id, randomBytes(32), 1)
    await this.gate.idle()
    this.store.transaction(() => {
      this.store.upsertSpace(id, name, personal)
      this.sendToSpace(id, 'op', { op: { type: 'create', owner: this.pubkey, nonce, name, personal }, par: [] })
    })
    this.sync?.refresh()
    return id
  }

  // ---- outgoing messages --------------------------------------------------------

  /** Sign, store, wrap and enqueue a stream message. Must run inside `store.transaction`. */
  protected sendToSpace(space: string, type: StreamPayload['t'], body: Record<string, unknown>, key = this.currentKey(space)): { seq: number; msgId: string } {
    const seq = this.store.nextSeq(space)
    const payload = { v: 2, t: type, sp: space, ep: key.keyId, seq, dlg: this.delegation, ...body }
    const content = JSON.stringify(payload)
    const inner = signWith(this.deviceSk, { kind: MESSAGE_KIND, created_at: Math.floor(this.now() / 1000), tags: [], content })
    const innerJson = JSON.stringify(inner)
    this.store.putMessage({ space, device: this.devicePubkey, seq, identity: this.pubkey, type, payload: content }, inner.id, innerJson)
    const outer = this.wrap(innerJson, key.tag, key.key)
    this.store.putRaw(outer, key.tag)
    const hold = this.holdForPeers(space, outer)
    this.sync?.enqueue(outer, true, hold > 0 ? Date.now() + hold : 0)
    this.afterEnvelope(space, outer, hold > 0)
    return { seq, msgId: inner.id }
  }

  /** P2P hook: how long (ms) to keep a new envelope out of relays while peers acknowledge it. */
  protected holdForPeers(_space: string, _outer: NostrEvent): number {
    return 0
  }

  /** P2P hook: a new envelope was stored (called inside the write transaction). */
  protected afterEnvelope(_space: string, _outer: NostrEvent, _held: boolean): void {}

  /** Seal an inner message into an envelope with the given routing tag and conversation key. */
  protected wrap(innerJson: string, tag: string, convKey: Uint8Array, signerSk?: Uint8Array): NostrEvent {
    if (byteLength(innerJson) > 65_000) throw new Error('anoDB: message too large')
    const sk = signerSk ?? this.envelopeKey(tag)
    return signWith(sk, {
      kind: WRAP_KIND,
      created_at: Math.floor(this.now() / 1000),
      tags: [[TAG, tag]],
      content: encrypt(innerJson, convKey),
    })
  }

  /** Key that signs a space-stream envelope (throwaway by default). */
  protected envelopeKey(_tag: string): Uint8Array {
    return this.opts.metadataProtection === 'none' ? this.deviceSk : generateSecretKey()
  }

  /** Envelope to another device's inbox (pairwise NIP-44 with a throwaway key). */
  protected wrapToDevice(innerJson: string, devicePk: string): NostrEvent {
    const eph = this.opts.metadataProtection === 'none' ? this.deviceSk : generateSecretKey()
    return this.wrap(innerJson, inboxTag(devicePk), conversationKey(eph, devicePk), eph)
  }

  protected enqueuePlain(event: NostrEvent): void {
    this.assertOpen()
    if (!this.sync) throw new Error('anoDB: no relays configured')
    this.store.enqueue(event, false)
    this.emitStatus()
    void this.sync.flush()
  }

  protected requireIdentitySigner(): Signer {
    if (!this.identitySigner) {
      throw new Error('anoDB: the identity key is not on this device; pass `signer` (NIP-07/46/55) or the recovery key')
    }
    return this.identitySigner
  }

  /** The identity secret as nsec, when stored on this device (identity: 'stored'). */
  exportIdentityKey(): string {
    const s = this.identitySigner as (Signer & { secretKey?: Uint8Array }) | null
    if (!s?.secretKey) throw new Error('anoDB: the identity key is not stored on this device')
    return nsecEncode(s.secretKey)
  }

  // ---- incoming -------------------------------------------------------------------

  protected syncHost(): SyncHost {
    return {
      tags: () => this.subscriptionTags(),
      ingest: (relay, e) => this.ingestGated(relay, e),
      resign: (e) => this.resignEnvelope(e),
      statusChanged: () => this.emitStatus(),
      publishRejected: (id) => this.error('publish-rejected', `every relay rejected event ${id}; call db.flush() to retry`, id),
      now: () => this.now(),
      afterCatchUp: (relay) => this.afterCatchUp(relay),
    }
  }

  protected async afterCatchUp(_relay: string): Promise<void> {}

  /** Same content, fresh created_at, new envelope key. */
  protected resignEnvelope(e: NostrEvent): NostrEvent {
    const tag = e.tags.find((t) => t[0] === TAG)?.[1] ?? ''
    return signWith(this.envelopeKey(tag), { kind: e.kind, tags: e.tags, content: e.content, created_at: Math.floor(this.now() / 1000) })
  }

  protected subscriptionTags(): string[] {
    const active = new Set(this.store.spaces().filter((s) => s.status === 'active').map((s) => s.id))
    return [...this.keysByTag.values()].filter((k) => active.has(k.space)).map((k) => k.tag)
  }

  protected ingestGated(relay: string, e: NostrEvent): IngestResult {
    if (this.gate.busy) {
      this.#deferred.push(() => void this.ingest(relay, e))
      return 'seen'
    }
    return this.ingest(relay, e)
  }

  /** Verify and apply one envelope. */
  protected ingest(source: string, outer: NostrEvent): IngestResult {
    if (this.#closed || outer.kind !== WRAP_KIND) return 'invalid'
    const tag = outer.tags.find((t) => t[0] === TAG)?.[1]
    if (!tag) return 'invalid'
    if (this.store.hasRaw(outer.id)) {
      if (source !== 'p2p') this.store.putRaw(outer, tag, true) // now known to be on a relay
      return 'seen'
    }
    const ek = this.keysByTag.get(tag)
    if (!ek) return this.ingestOther(tag, outer)
    if (outer.content.length > 120_000 || !verifySignedEvent(outer)) return 'invalid'
    let inner: unknown
    try {
      inner = JSON.parse(decrypt(outer.content, ek.key))
    } catch {
      this.error('decrypt-failed', 'could not decrypt envelope', outer.id)
      return 'invalid'
    }
    if (!isEvent(inner) || inner.kind !== MESSAGE_KIND || !verifySignedEvent(inner)) {
      this.error('invalid-event', 'inner message is malformed or badly signed', outer.id)
      return 'invalid'
    }
    const payload = parseStreamPayload(inner.content)
    if (!payload) {
      this.error('unsupported-protocol', 'unknown message format or newer protocol version', outer.id)
      return 'invalid'
    }
    if (payload.sp !== ek.space || payload.ep !== ek.keyId) {
      this.error('invalid-event', 'message header does not match its envelope', outer.id)
      return 'invalid'
    }
    const identity = verifyDelegation(payload.dlg, inner.pubkey)
    if (!identity) {
      this.error('invalid-event', 'message has no valid delegation', outer.id)
      return 'invalid'
    }
    let result = 'seen' as IngestResult
    const msgId = inner.id
    const device = inner.pubkey
    const changed = this.store.transaction(() => {
      this.store.putRaw(outer, tag, source !== 'p2p')
      if (this.store.hasMessage(ek.space, device, payload.seq)) return new Set<string>()
      this.store.putMessage({ space: ek.space, device, seq: payload.seq, identity, type: payload.t, payload: inner.content }, msgId, JSON.stringify(inner))
      result = 'new'
      return this.onMessage(ek.space, identity, device, payload)
    })
    this.notify(changed, 'remote')
    if (result === 'new') this.afterRemoteMessage(ek.space, identity, device, payload)
    return result
  }

  /** Hook after a new remote message was stored (v0.3: membership handling). */
  protected afterRemoteMessage(_space: string, _identity: string, _device: string, _p: StreamPayload): void {}

  /** Envelope for a tag that is not a space key (inbox, invite secrets). Implemented in v0.3. */
  protected ingestOther(_tag: string, _outer: NostrEvent): IngestResult {
    return 'invalid'
  }

  /** Apply a newly stored, signature-valid message. Returns changed tables. Runs inside a transaction. */
  protected onMessage(space: string, identity: string, device: string, p: StreamPayload): Set<string> {
    if (p.t === 'op') {
      this.invalidateMembership(space)
      return this.rebuildSpace(space)
    }
    if (p.t !== 'ch') return new Set()
    if (!this.isAuthorizedWriter(space, identity, device, p.seq)) return new Set() // kept; re-evaluated on membership change
    let maxHlc = ''
    for (const c of p.c) if (c[4] > maxHlc) maxHlc = c[4]
    if (maxHlc) this.clock.receive(maxHlc)
    this.store.setMeta('hlc', this.clock.current())
    return this.store.applyChanges(space, this.allowedChanges(space, identity, p.c), identity)
  }

  /** The changes of one signed message that pass the row-level rule (see policy.ts). */
  protected allowedChanges(space: string, identity: string, changes: readonly Change[]): Change[] {
    const role = this.roleOf(space, identity)
    return changes.filter((c) => changeAllowed(this.schema, c, identity, role))
  }

  /** Role of an identity in a space (v0.2: the creator is the only member). */
  protected roleOf(space: string, identity: string): Role | undefined {
    return this.isAuthorizedWriter(space, identity, '', Number.MAX_SAFE_INTEGER) ? 'owner' : undefined
  }

  readonly #ownerCache = new Map<string, string | null>()

  protected invalidateMembership(space: string): void {
    this.#ownerCache.delete(space)
  }

  /** v0.2: only the space creator (owner) may write. Generalised to roles in v0.3. */
  protected isAuthorizedWriter(space: string, identity: string, _device: string, _seq: number): boolean {
    if (!this.#ownerCache.has(space)) {
      let owner: string | null = null
      for (const m of this.store.messages(space, 'op')) {
        const p = JSON.parse(m.payload) as { op: { type?: string; owner?: string } }
        if (p.op.type === 'create' && p.op.owner === m.identity) owner = m.identity
      }
      this.#ownerCache.set(space, owner)
    }
    return this.#ownerCache.get(space) === identity
  }

  /** Recompute a space's cells from the message log under the current authorization rules. */
  protected rebuildSpace(space: string): Set<string> {
    const touched = this.store.clearSpace(space)
    for (const m of this.store.messages(space, 'ch')) {
      if (!this.isAuthorizedWriter(space, m.identity, m.device, m.seq)) continue
      const p = JSON.parse(m.payload) as { c: Change[] }
      for (const t of this.store.applyChanges(space, this.allowedChanges(space, m.identity, p.c), m.identity)) touched.add(t)
    }
    return touched
  }

  // ---- events & status -------------------------------------------------------------

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
    return this.sync?.status ?? { state: 'offline', connectedRelays: [], pendingEvents: 0 }
  }

  async waitForSync(timeoutMs = 10_000): Promise<SyncStatus> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const s = this.status
      if (s.state === 'synced' || Date.now() >= deadline) return s
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** Retry relays that rejected pending events and flush the outbox now. */
  async flush(): Promise<void> {
    await this.gate.idle()
    this.store.clearRejections()
    await this.sync?.flush()
  }

  /** Forget cursors and re-download everything from relays. */
  resync(): void {
    this.sync?.resync()
  }

  protected notify(tables: ReadonlySet<string>, origin: 'local' | 'remote'): void {
    if (this.gate.busy) {
      for (const t of tables) this.#pendingNotify.add(t)
      return
    }
    const all = new Set([...this.#pendingNotify, ...tables])
    this.#pendingNotify.clear()
    if (all.size === 0) return
    for (const fn of [...this.#changeListeners]) fn(all, origin)
  }

  protected error(code: AnoDBErrorCode, message: string, eventId?: string): void {
    const err = new AnoDBError(code, message, eventId)
    for (const fn of this.#errorListeners) fn(err)
  }

  protected emitStatus(): void {
    if (this.#closed) return
    const s = this.status
    const key = JSON.stringify(s)
    if (key === this.#lastStatus) return
    this.#lastStatus = key
    for (const fn of this.#statusListeners) fn(s)
  }

  protected assertOpen(): void {
    if (this.#closed) throw new Error('anoDB: database is closed')
  }

  get closed(): boolean {
    return this.#closed
  }

  async close(): Promise<void> {
    if (this.#closed) return
    await this.gate.idle()
    this.#closed = true
    this.sync?.close()
    this.#changeListeners.clear()
    this.#statusListeners.clear()
    this.store.driver.close()
  }
}

function compileQuery(q: Query): { sql: string; parameters: readonly unknown[] } {
  if (typeof q === 'string') return { sql: q, parameters: [] }
  if ('compile' in q && typeof q.compile === 'function') return q.compile()
  const raw = q as { sql: string; parameters?: readonly unknown[] }
  return { sql: raw.sql, parameters: raw.parameters ?? [] }
}

function countRows(cells: CapturedCell[]): number {
  return new Set(cells.map((c) => `${c.space}\u0000${c.table}\u0000${c.rowId}`)).size
}
