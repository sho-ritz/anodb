import {
  bytesToHex,
  conversationKey,
  decrypt,
  hexToBytes,
  inboxTag,
  keyId,
  npubEncode,
  parsePubkey,
  randomBytes,
  randomHex,
  secretKeyFor,
  secretTag,
  sha256Hex,
  signWith,
  spaceTag,
  verifySignedEvent,
} from './crypto.js'
import { AnoDBCore, AnoDBError, type EpochKey } from './db.js'
import { KEY_PACKAGE_KIND, createDelegation, createKeyPackage, createRevocation, delegationName, isEvent, parseKeyPackage, verifyDelegation } from './identity.js'
import {
  type MemberOp,
  type Membership,
  type OpRecord,
  type Role,
  canWrite,
  evaluate,
  mayManage,
  mayWrite,
  parseOp,
} from './membership.js'
import { type Change, MAX_BODY_BYTES, MESSAGE_KIND, byteLength, parseInboxPayload, parseStreamPayload } from './protocol.js'
import { changeAllowed } from './policy.js'
import { SYS_DELETED } from './schema.js'
import type { Store } from './store.js'
import type { IngestResult } from './sync.js'
import type { NostrEvent, SchemaDefinition } from './types.js'

/** Keys rotate after this long even without membership changes (Q11). */
export const KEY_MAX_AGE_MS = 30 * 24 * 3600_000
/** A writer posts a snapshot after this many change messages since the last one (Q19). */
export const SNAPSHOT_EVERY = 1000

export interface Member {
  identity: string
  npub: string
  role: Role
}

export interface Invitation {
  space: string
  name: string
  role: Role
  from: string
}

export interface PairingOffer {
  uri: string
  /** Show this; the approving device shows the same code. */
  code: string
}

export interface Device {
  device: string
  name: string
  revoked: boolean
  current: boolean
}

interface KeyGrant {
  sp: string
  name: string
  personal: boolean
  num: number
  key: string
  ops: string[]
}

/**
 * Cells for a snapshot. Deleted rows keep only their tombstone (so late writes cannot resurrect
 * them) — their former values never reach new members or devices.
 */
export function snapshotCells(cells: Change[]): Change[] {
  const deleted = new Set(cells.filter((c) => c[2] === SYS_DELETED && c[3] === true).map((c) => `${c[0]}\u0000${c[1]}`))
  return cells.filter((c) => !deleted.has(`${c[0]}\u0000${c[1]}`) || c[2] === SYS_DELETED)
}

const pairingCode = (devicePk: string, secret: string) => String(parseInt(sha256Hex(`anodb/v2/pair-code/${devicePk}/${secret}`).slice(0, 8), 16) % 1_000_000).padStart(6, '0')

/** Adds multi-user spaces, roles, invitations, key rotation, snapshots and device pairing. */
export class AnoDBSharing<S extends SchemaDefinition> extends AnoDBCore<S> {
  readonly #membership = new Map<string, Membership>()
  readonly #inviteListeners = new Set<(i: Invitation) => void>()
  #pairing: { secret: string; resolve: () => void; promise: Promise<void> } | null = null

  protected override async afterInit(): Promise<void> {
    await this.store.putDevice(this.devicePubkey, this.pubkey, JSON.stringify(this.delegation), delegationName(this.delegation))
    const secret = await this.store.getMeta('pairing_secret')
    if (secret) this.#armPairing(secret)
    await this.#rotateStaleKeys()
  }

  // ---- authorization -------------------------------------------------------------

  /** Membership of a space, evaluated from its signed op log (kept in memory, see `reloadMembership`). */
  protected membership(space: string): Membership {
    return this.#membership.get(space) ?? evaluate(space, [], () => undefined)
  }

  protected override async reloadMembership(s: Store, space: string): Promise<void> {
    await super.reloadMembership(s, space)
    const records: OpRecord[] = []
    for (const r of await s.opRecords(space)) {
      const p = JSON.parse(r.payload) as { op: unknown; par: string[] }
      const op = parseOp(p.op)
      if (op) records.push({ id: r.msgId, identity: r.identity, op, par: p.par })
    }
    const devices = new Map(s.devices().map((d) => [d.device, d.identity]))
    this.#membership.set(space, evaluate(space, records, (d) => devices.get(d)))
  }

  protected override isAuthorizedWriter(space: string, identity: string, device: string, seq: number): boolean {
    return mayWrite(this.membership(space), identity, device, seq)
  }

  protected override roleOf(space: string, identity: string): Role | undefined {
    return this.membership(space).roles.get(identity)
  }

  protected override async rebuildSpace(s: Store, space: string): Promise<Set<string>> {
    const touched = await super.rebuildSpace(s, space)
    for (const snap of await this.#completeSnapshots(s, space)) {
      // Cells that name their signer must still pass the row rule for that signer.
      const cells = snap.cells.filter((c) => {
        const by = (c as readonly unknown[])[5]
        return typeof by !== 'string' || changeAllowed(this.schema, c, by, this.roleOf(space, by))
      })
      for (const t of await s.applyChanges(space, cells)) touched.add(t)
    }
    return touched
  }

  // ---- spaces & members ------------------------------------------------------------

  /** Create a shared space owned by this identity. */
  async createSpace(name: string): Promise<string> {
    this.assertOpen()
    return this.createSpaceInternal(name, false)
  }

  members(space: string): Member[] {
    return [...this.membership(space).roles].map(([identity, role]) => ({ identity, npub: npubEncode(identity), role }))
  }

  roleIn(space: string): Role | undefined {
    return this.membership(space).roles.get(this.pubkey)
  }

  /**
   * Add a member by npub / pubkey and deliver the space key to their devices (owners / admins).
   * Who may join is decided outside anoDB (e.g. anoAuth): this is the primitive it calls.
   * `devices`: the member's device delegations; when omitted, the devices this database already
   * knows for that identity (e.g. a member of another shared space) or their published key package
   * (`db.publishKeyPackage()`) are used. The new member sees an invitation and must accept it.
   */
  async addMember(space: string, who: string, role: Exclude<Role, 'owner'>, opts: { devices?: NostrEvent[] } = {}): Promise<void> {
    const identity = parsePubkey(who)
    const known = this.store.devices(identity).filter((d) => !d.revoked).map((d) => JSON.parse(d.delegation) as NostrEvent)
    const given = opts.devices ?? (known.length > 0 ? known : (await this.#fetchKeyPackage(identity)).map((d) => d.delegation))
    const delegations = given.filter((d) => {
      const device = d.tags.find((t) => t[0] === 'device')?.[1]
      return !!device && verifyDelegation(d, device) === identity
    })
    if (delegations.length === 0) {
      throw new Error(
        opts.devices
          ? `anoDB: none of the given devices is delegated by ${npubEncode(identity)}`
          : `anoDB: ${npubEncode(identity)} has not published a key package (db.publishKeyPackage())`,
      )
    }
    await this.#addMember(space, identity, role, delegations)
  }

  async setRole(space: string, who: string, role: Exclude<Role, 'owner'>): Promise<void> {
    const identity = parsePubkey(who)
    const cut = canWrite(role) ? undefined : await this.store.deviceMaxSeqs(space, identity)
    await this.#postOp(space, cut ? { type: 'role', identity, role, cut } : { type: 'role', identity, role })
  }

  async removeMember(space: string, who: string): Promise<void> {
    const identity = parsePubkey(who)
    await this.#postOp(space, { type: 'remove', identity, cut: await this.store.deviceMaxSeqs(space, identity) })
    await this.rotateKey(space)
  }

  async transferOwnership(space: string, who: string): Promise<void> {
    await this.#postOp(space, { type: 'transfer', identity: parsePubkey(who) })
  }

  async leaveSpace(space: string): Promise<void> {
    await this.#postOp(space, { type: 'leave', cut: await this.store.deviceMaxSeqs(space, this.pubkey) })
    await this.store.setSpaceStatus(space, 'left')
    this.sync?.refresh()
  }

  async #postOp(space: string, op: MemberOp): Promise<void> {
    this.assertOpen()
    await this.gate.idle()
    const changed = await this.store.transaction(async (s) => {
      const before = this.membership(space)
      const records = await s.opRecords(space)
      const referenced = new Set(records.flatMap((r) => (JSON.parse(r.payload) as { par: string[] }).par))
      const par = records.map((r) => r.msgId).filter((id) => !referenced.has(id) && before.valid.includes(id))
      try {
        const { msgId } = await this.sendToSpace(s, space, 'op', { op, par })
        if (!this.membership(space).valid.includes(msgId)) throw new Error(`anoDB: not allowed: ${op.type} in space ${space}`)
        return await this.rebuildSpace(s, space)
      } catch (e) {
        // The op is rolled back: restore the membership it was evaluated with.
        this.#membership.set(space, before)
        throw e
      }
    })
    this.notify(changed, 'local')
    void this.sync?.flush()
  }

  async #addMember(space: string, identity: string, role: Exclude<Role, 'owner'>, delegations: NostrEvent[]): Promise<void> {
    for (const d of delegations) {
      const device = d.tags.find((t) => t[0] === 'device')?.[1]
      if (device && verifyDelegation(d, device) === identity) await this.store.putDevice(device, identity, JSON.stringify(d), delegationName(d))
    }
    if (!this.membership(space).roles.has(identity)) await this.#postOp(space, { type: 'add', identity, role })
    await this.rotateKey(space, new Set([identity]))
  }

  // ---- key rotation & snapshots -------------------------------------------------------

  /**
   * New epoch key: delivered to every active device of every member (new members get an
   * invitation instead), then a snapshot of the current state is posted in the new epoch.
   */
  async rotateKey(space: string, invitees: ReadonlySet<string> = new Set()): Promise<void> {
    this.assertOpen()
    const m = this.membership(space)
    const s = this.store.space(space)
    if (!s) throw new Error(`anoDB: unknown space ${space}`)
    if (!mayManage(m, this.pubkey)) throw new Error('anoDB: only owners and admins can rotate keys')
    const key = randomBytes(32)
    const ek = await this.storeKey(space, key, this.currentKey(space).num + 1)
    await this.gate.idle()
    const ops = await this.store.inners(space, 'op')
    const grant: KeyGrant = { sp: space, name: s.name, personal: s.personal, num: ek.num, key: bytesToHex(key), ops }
    await this.store.transaction(async (tx) => {
      for (const [identity] of m.roles) {
        for (const d of tx.devices(identity)) {
          if (d.revoked || d.device === this.devicePubkey || m.revokedDevices.has(d.device)) continue
          const body = invitees.has(identity) ? { ...grant, t: 'invite', role: m.roles.get(identity) } : { ...grant, t: 'key' }
          await this.#sendInbox(tx, d.device, body)
        }
      }
    })
    await this.#snapshot(space, ek)
    this.sync?.refresh()
    void this.sync?.flush()
  }

  /** Post the current state of a space as a (multi-part) snapshot message. */
  protected snapshot(space: string): Promise<void> {
    return this.#snapshot(space, this.currentKey(space))
  }

  async #snapshot(space: string, key: EpochKey): Promise<void> {
    const startedAt = Math.floor(this.now() / 1000)
    await this.store.transaction(async (s) => {
      const items: Array<{ op?: string; cell?: Change }> = [
        ...(await s.inners(space, 'op')).map((op) => ({ op })),
        ...snapshotCells(await s.cells(space)).map((cell) => ({ cell })),
      ]
      const parts: Array<{ ops: string[]; cells: Change[] }> = [{ ops: [], cells: [] }]
      let size = 0
      for (const it of items) {
        const n = byteLength(JSON.stringify(it.op ?? it.cell)) + 1
        if (size + n > MAX_BODY_BYTES && size > 0) {
          parts.push({ ops: [], cells: [] })
          size = 0
        }
        const p = parts[parts.length - 1]!
        if (it.op) p.ops.push(it.op)
        else p.cells.push(it.cell!)
        size += n
      }
      const sid = randomHex(8)
      const heads = await s.deviceMaxSeqs(space)
      for (const [i, body] of parts.entries()) {
        await this.sendToSpace(s, space, 'snap', { sid, i, n: parts.length, body: i === 0 ? { ...body, heads } : body }, key)
      }
      await s.setMeta(`snap:${space}`, String(Date.now()))
    })
    await this.afterSnapshot(space, startedAt)
    void this.sync?.flush()
  }

  /** Hook (v0.4: prune superseded envelopes). */
  protected async afterSnapshot(_space: string, _before: number): Promise<void> {}

  /** Sequence numbers covered by complete, authorized snapshots: device → seq. */
  protected async snapshotCoverage(s: Store, space: string): Promise<Map<string, number>> {
    const cover = new Map<string, number>()
    for (const snap of await this.#completeSnapshots(s, space)) {
      for (const [d, seq] of Object.entries(snap.heads)) if (seq > (cover.get(d) ?? 0)) cover.set(d, seq)
    }
    return cover
  }

  /** Snapshots whose parts all arrived and whose author may write. */
  async #completeSnapshots(s: Store, space: string): Promise<Array<{ cells: Change[]; heads: Record<string, number> }>> {
    const groups = new Map<string, Array<{ i: number; n: number; seq: number; identity: string; device: string; body: { ops?: unknown; cells?: unknown } }>>()
    for (const m of await s.messages(space, 'snap')) {
      const p = JSON.parse(m.payload) as { sid: string; i: number; n: number; body: { ops?: unknown; cells?: unknown } }
      const k = `${m.device}/${p.sid}`
      const list = groups.get(k) ?? []
      list.push({ i: p.i, n: p.n, seq: m.seq, identity: m.identity, device: m.device, body: p.body })
      groups.set(k, list)
    }
    const out: Array<{ cells: Change[]; heads: Record<string, number> }> = []
    for (const parts of groups.values()) {
      const n = parts[0]!.n
      if (parts.length !== n || new Set(parts.map((p) => p.i)).size !== n || parts.some((p) => p.n !== n)) continue
      const last = Math.max(...parts.map((p) => p.seq))
      const author = parts[0]!.identity
      if (!this.isAuthorizedWriter(space, author, parts[0]!.device, last)) continue
      // A snapshot restates every cell, including other members' rows, so it is only trusted from
      // someone who may manage the space (owner / admin) — or from this identity's own devices.
      // A plain writer's snapshot could otherwise rewrite or impersonate anyone's rows.
      const role = this.roleOf(space, author)
      if (author !== this.pubkey && role !== 'owner' && role !== 'admin') continue
      const cells = parts.flatMap((p) => (Array.isArray(p.body?.cells) ? (p.body.cells as Change[]) : []))
      const h = parts.find((p) => p.i === 0)?.body as { heads?: unknown } | undefined
      const heads: Record<string, number> = {}
      if (h?.heads && typeof h.heads === 'object') {
        for (const [d, v] of Object.entries(h.heads as Record<string, unknown>)) if (typeof v === 'number' && Number.isSafeInteger(v)) heads[d] = v
      }
      const valid = (c: unknown) => Array.isArray(c) && (c.length === 5 || (c.length === 6 && typeof c[5] === 'string' && /^[0-9a-f]{64}$/.test(c[5])))
      out.push({ cells: cells.filter(valid), heads })
    }
    return out
  }

  protected override async afterLocalWrite(spaces: string[]): Promise<void> {
    for (const space of spaces) await this.#maybeSnapshot(space)
  }

  async #maybeSnapshot(space: string): Promise<void> {
    const role = this.membership(space).roles.get(this.pubkey)
    if (role !== 'owner' && role !== 'admin') return // others would not trust it (see #completeSnapshots)
    const since = Number((await this.store.getMeta(`snap:${space}`)) ?? '0')
    if ((await this.store.countMessages(space, 'ch', since)) < SNAPSHOT_EVERY) return
    await this.snapshot(space)
  }

  async #rotateStaleKeys(): Promise<void> {
    for (const s of this.store.spaces()) {
      if (s.status !== 'active') continue
      const k = this.keysBySpace.get(s.id)?.[0]
      if (!k || this.now() - k.createdAt < KEY_MAX_AGE_MS) continue
      if (mayManage(this.membership(s.id), this.pubkey)) await this.rotateKey(s.id)
    }
  }

  // ---- receiving membership effects ------------------------------------------------------

  protected override async onMessage(s: Store, space: string, identity: string, device: string, p: Parameters<AnoDBCore<S>['onMessage']>[4]): Promise<Set<string>> {
    if (p.t === 'snap') {
      // Import portable ops carried by the snapshot, then re-evaluate everything.
      const ops = (p.body as { ops?: unknown }).ops
      if (Array.isArray(ops)) for (const o of ops) if (typeof o === 'string') await this.#importInner(s, space, o)
      await this.reloadMembership(s, space)
      return this.rebuildSpace(s, space)
    }
    return super.onMessage(s, space, identity, device, p)
  }

  protected override async afterRemoteMessage(space: string, identity: string, device: string, p: Parameters<AnoDBCore<S>['afterRemoteMessage']>[3]): Promise<void> {
    await this.store.putDevice(device, identity, JSON.stringify(p.dlg), delegationName(p.dlg))
    if (p.t !== 'op') return
    const m = this.membership(space)
    const s = this.store.space(space)
    if (s?.status === 'active' && !m.roles.has(this.pubkey) && m.owner !== null) {
      await this.store.setSpaceStatus(space, 'removed')
      this.sync?.refresh()
      return
    }
    // A member left: the owner rotates so they cannot read what comes next.
    const op = parseOp((p as { op: unknown }).op)
    if (op?.type === 'leave' && m.owner === this.pubkey && m.valid.length > 0) void this.rotateKey(space).catch(() => {})
  }

  /** Store a portable signed op (from an invitation or snapshot) after verifying it. */
  async #importInner(s: Store, space: string, innerJson: string): Promise<boolean> {
    let inner: unknown
    try {
      inner = JSON.parse(innerJson)
    } catch {
      return false
    }
    if (!isEvent(inner) || inner.kind !== MESSAGE_KIND || !verifySignedEvent(inner)) return false
    const p = parseStreamPayload(inner.content)
    if (!p || p.sp !== space || p.t !== 'op') return false
    const identity = verifyDelegation(p.dlg, inner.pubkey)
    if (!identity) return false
    if (await s.hasMessage(space, inner.pubkey, p.seq)) return true
    await s.putMessage({ space, device: inner.pubkey, seq: p.seq, identity, type: 'op', payload: inner.content }, inner.id, innerJson)
    await s.putDevice(inner.pubkey, identity, JSON.stringify(p.dlg), delegationName(p.dlg))
    return true
  }

  // ---- inbox & secrets ---------------------------------------------------------------------

  protected override subscriptionTags(): string[] {
    const tags = [...super.subscriptionTags(), inboxTag(this.devicePubkey)]
    const now = this.now()
    if (this.#pairing) tags.push(secretTag(this.#pairing.secret))
    return tags
  }

  protected override routeSeed(tag: string): ReturnType<AnoDBCore<S>['routeSeed']> {
    if (this.#pairing && tag === secretTag(this.#pairing.secret)) return { seed: this.#pairing.secret, prio: 0 }
    return super.routeSeed(tag)
  }

  async #sendInbox(s: Store, device: string, body: Record<string, unknown>): Promise<void> {
    const inner = signWith(this.deviceSk, {
      kind: MESSAGE_KIND,
      created_at: Math.floor(this.now() / 1000),
      tags: [],
      content: JSON.stringify({ v: 2, dlg: this.delegation, ...body }),
    })
    const outer = await this.wrapToDevice(s, JSON.stringify(inner), device)
    if (this.sync) await s.enqueue(outer, false)
  }

  async #sendSecret(secret: string, body: Record<string, unknown>): Promise<void> {
    const inner = signWith(this.deviceSk, {
      kind: MESSAGE_KIND,
      created_at: Math.floor(this.now() / 1000),
      tags: [],
      content: JSON.stringify({ v: 2, dlg: this.delegation, ...body }),
    })
    if (!this.sync) throw new Error('anoDB: no relays configured')
    const outer = await this.wrap(this.store, JSON.stringify(inner), secretTag(secret), secretKeyFor(secret))
    await this.store.enqueue(outer, false)
    void this.sync.flush()
  }

  protected override async ingestOther(tag: string, outer: NostrEvent): Promise<IngestResult> {
    let convKey: Uint8Array | null = null
    let secret: string | null = null
    if (tag === inboxTag(this.devicePubkey)) {
      try {
        convKey = conversationKey(this.deviceSk, outer.pubkey)
      } catch {
        return 'invalid'
      }
    } else {
      secret = this.#pairing && secretTag(this.#pairing.secret) === tag ? this.#pairing.secret : null
      if (!secret) return 'invalid'
      convKey = secretKeyFor(secret)
    }
    if (outer.content.length > 200_000 || !verifySignedEvent(outer)) return 'invalid'
    let inner: unknown
    try {
      inner = JSON.parse(decrypt(outer.content, convKey))
    } catch {
      return 'invalid'
    }
    if (!isEvent(inner) || inner.kind !== MESSAGE_KIND || !verifySignedEvent(inner)) return 'invalid'
    const p = parseInboxPayload(inner.content)
    if (!p) return 'invalid'
    const sender = verifyDelegation(p.dlg, inner.pubkey)
    if (!sender) return 'invalid'
    await this.store.putRaw(outer, tag)
    try {
      if (secret === null) await this.#onInbox(sender, inner.pubkey, p)
      else if (this.#pairing?.secret === secret && p.t === 'pair') void this.#onPaired(sender, p).catch(() => {})
    } catch {
      return 'invalid'
    }
    return 'new'
  }

  async #onInbox(sender: string, senderDevice: string, p: Record<string, unknown>): Promise<void> {
    if (p.t !== 'key' && p.t !== 'invite') return
    const g = p as unknown as KeyGrant & { role?: Role }
    if (typeof g.sp !== 'string' || typeof g.key !== 'string' || !/^[0-9a-f]{64}$/.test(g.key) || !Array.isArray(g.ops)) return
    // Validate against the ops carried in the grant (plus what we know).
    await this.store.transaction(async (s) => {
      const before = (await s.opRecords(g.sp)).length
      for (const o of g.ops) if (typeof o === 'string') await this.#importInner(s, g.sp, o)
      if ((await s.opRecords(g.sp)).length !== before || !this.#membership.has(g.sp)) await this.reloadMembership(s, g.sp)
    })
    const m = this.membership(g.sp)
    const fromManager = mayManage(m, sender) || sender === this.pubkey
    if (!fromManager || !m.roles.has(this.pubkey)) return
    await this.store.putDevice(senderDevice, sender, JSON.stringify(p.dlg), delegationName(p.dlg as NostrEvent))
    const known = this.store.space(g.sp)
    if (p.t === 'invite' && known?.status !== 'active') {
      await this.store.putInviteIn(g.sp, sender, m.roles.get(this.pubkey)!, String(g.name ?? ''), JSON.stringify(g))
      const inv: Invitation = { space: g.sp, name: String(g.name ?? ''), role: m.roles.get(this.pubkey)!, from: sender }
      for (const fn of this.#inviteListeners) fn(inv)
      return
    }
    if (known?.status !== 'active') return
    await this.#acceptKey(g, sender !== this.pubkey)
  }

  async #acceptKey(g: KeyGrant, forward: boolean): Promise<void> {
    const added = !this.keysByTag.has(spaceTag(hexToBytes(g.key)))
    await this.storeKey(g.sp, hexToBytes(g.key), g.num)
    if (!added) return
    this.sync?.refresh()
    // Share with my other devices (they may not be known to the sender).
    if (forward) {
      await this.store.transaction(async (s) => {
        for (const d of s.devices(this.pubkey)) {
          if (!d.revoked && d.device !== this.devicePubkey) await this.#sendInbox(s, d.device, { ...g, t: 'key' })
        }
      })
      void this.sync?.flush()
    }
  }

  // ---- invitations (invitee side) ----------------------------------------------------------

  invitations(): Invitation[] {
    return this.store
      .invitesIn('pending')
      .map((i) => ({ space: i.space, name: i.name, role: i.role as Role, from: i.sender }))
  }

  onInvitation(fn: (i: Invitation) => void): () => void {
    this.#inviteListeners.add(fn)
    return () => this.#inviteListeners.delete(fn)
  }

  /** Join a space you were invited to. Nothing is synced for a space until you accept. */
  async acceptInvitation(space: string): Promise<void> {
    const inv = this.store.invitesIn().find((i) => i.space === space)
    if (!inv) throw new Error('anoDB: no such invitation')
    const g = JSON.parse(inv.payload) as KeyGrant
    await this.storeKey(g.sp, hexToBytes(g.key), g.num)
    await this.gate.idle()
    await this.store.transaction(async (s) => {
      await s.upsertSpace(g.sp, g.name, false)
      await s.setInviteInStatus(space, 'accepted')
      await this.reloadMembership(s, space)
    })
    this.sync?.refresh()
  }

  declineInvitation(space: string): Promise<void> {
    return this.store.setInviteInStatus(space, 'declined')
  }

  /**
   * This identity's current device delegations (signed by the identity). Hand them to whoever adds
   * you (`addMember(space, npub, role, { devices })`) when you have not published a key package.
   */
  deviceDelegations(): NostrEvent[] {
    return this.store.devices(this.pubkey).filter((d) => !d.revoked).map((d) => JSON.parse(d.delegation) as NostrEvent)
  }

  /** Publish the list of this identity's devices so others can add it by npub (needs the identity key). */
  async publishKeyPackage(): Promise<NostrEvent> {
    const signer = this.requireIdentitySigner()
    const delegations = this.store.devices(this.pubkey).filter((d) => !d.revoked).map((d) => JSON.parse(d.delegation) as NostrEvent)
    const ev = await createKeyPackage(signer, delegations, this.now())
    await this.enqueuePlain(ev)
    return ev
  }

  async #fetchKeyPackage(identity: string): Promise<Array<{ device: string; delegation: NostrEvent }>> {
    if (!this.sync) return []
    const events = (await this.sync.pool.query([{ kinds: [KEY_PACKAGE_KIND], authors: [identity] }], { timeoutMs: 5000 })).filter(
      (e) => e.pubkey === identity && verifySignedEvent(e),
    )
    const newest = events.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0]
    return newest ? parseKeyPackage(newest) : []
  }

  // ---- devices: pairing & revocation -----------------------------------------------------------

  devices(): Device[] {
    return this.store.devices(this.pubkey).map((d) => ({ device: d.device, name: d.name, revoked: d.revoked, current: d.device === this.devicePubkey }))
  }

  /**
   * New device: show `uri` as a QR code and wait. After an existing device approves, this device
   * adopts that identity and its spaces; reopen the database afterwards.
   */
  async startPairing(): Promise<PairingOffer & { done: Promise<void> }> {
    const secret = randomHex(16)
    await this.store.setMeta('pairing_secret', secret)
    this.#armPairing(secret)
    return {
      uri: `anodb://pair?app=${encodeURIComponent(this.appId)}&d=${this.devicePubkey}&s=${secret}`,
      code: pairingCode(this.devicePubkey, secret),
      done: this.#pairing!.promise,
    }
  }

  #armPairing(secret: string): void {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    this.#pairing = { secret, resolve, promise }
    this.sync?.refresh()
  }

  /** Existing device: inspect a pairing QR code. Compare `code` with the new device, then `approve()`. */
  parsePairing(uri: string): { device: string; code: string; approve(name?: string): Promise<void> } {
    const u = new URL(uri)
    const device = u.searchParams.get('d') ?? ''
    const secret = u.searchParams.get('s') ?? ''
    if (u.protocol !== 'anodb:' || u.host !== 'pair' || !/^[0-9a-f]{64}$/.test(device) || !/^[0-9a-f]{32}$/.test(secret)) {
      throw new Error('anoDB: invalid pairing code')
    }
    if (u.searchParams.get('app') !== this.appId) throw new Error('anoDB: pairing code is for another app')
    return {
      device,
      code: pairingCode(device, secret),
      approve: async (name = 'device') => {
        const signer = this.requireIdentitySigner()
        const delegation = await createDelegation(signer, device, name, this.now())
        await this.gate.idle()
        await this.store.putDevice(device, this.pubkey, JSON.stringify(delegation), name)
        const spaces: KeyGrant[] = []
        for (const s of this.store.spaces()) {
          if (s.status !== 'active') continue
          const k = this.currentKey(s.id)
          spaces.push({ sp: s.id, name: s.name, personal: s.personal, num: k.num, key: bytesToHex(k.key), ops: await this.store.inners(s.id, 'op') })
        }
        await this.#sendSecret(secret, { t: 'pair', delegation, spaces })
        // The new device catches up from a fresh snapshot of each space (not the full history).
        for (const s of spaces) await this.snapshot(s.sp)
        void this.sync?.flush()
      },
    }
  }

  async #onPaired(sender: string, p: Record<string, unknown>): Promise<void> {
    const delegation = p.delegation
    if (verifyDelegation(delegation, this.devicePubkey) !== sender || !Array.isArray(p.spaces)) return
    const grants = (p.spaces as KeyGrant[]).filter((g) => typeof g.sp === 'string' && typeof g.key === 'string' && /^[0-9a-f]{64}$/.test(g.key))
    await this.gate.idle()
    // Adopt the identity: drop this device's provisional identity and all its data.
    await this.keyStore.set('delegation', JSON.stringify(delegation))
    await this.keyStore.remove('identity')
    this.identitySigner = null
    await this.store.wipe()
    await this.store.setMeta('identity', sender)
    await this.store.deleteMeta('pairing_secret')
    for (const g of grants) {
      const sealed = await this.keyStore.seal(hexToBytes(g.key))
      await this.store.transaction(async (s) => {
        await s.putKey(g.sp, keyId(hexToBytes(g.key)), g.num, sealed)
        await s.upsertSpace(g.sp, g.name, g.personal)
        for (const o of g.ops) if (typeof o === 'string') await this.#importInner(s, g.sp, o)
      })
    }
    this.#pairing?.resolve()
    this.#pairing = null
  }

  /** Revoke one of this identity's devices (lost or stolen). Needs the identity key or a signer. */
  async revokeDevice(device: string): Promise<void> {
    const signer = this.requireIdentitySigner()
    if (device === this.devicePubkey) throw new Error('anoDB: cannot revoke the current device')
    const revocation = await createRevocation(signer, device, this.now())
    await this.store.revokeDevice(device)
    for (const s of this.store.spaces()) {
      if (s.status !== 'active' || !this.membership(s.id).roles.has(this.pubkey)) continue
      await this.#postOp(s.id, { type: 'revoke', revocation, cut: { [device]: (await this.store.deviceMaxSeqs(s.id, undefined, device))[device] ?? 0 } })
      if (mayManage(this.membership(s.id), this.pubkey)) await this.rotateKey(s.id)
    }
  }

  // ---- write permission check uses roles ---------------------------------------------------------

  protected override assertCanWrite(space: string): void {
    const s = this.store.space(space)
    if (!s || s.status !== 'active') throw new Error(`anoDB: unknown or inactive space "${space}"`)
    if (!canWrite(this.membership(space).roles.get(this.pubkey))) throw new Error(`anoDB: no write permission in space ${space}`)
  }
}
