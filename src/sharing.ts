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

export interface JoinRequest {
  id: string
  space: string
  role: Role
  identity: string
  npub: string
  name: string
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
  readonly #joinListeners = new Set<(r: JoinRequest) => void>()
  readonly #inviteListeners = new Set<(i: Invitation) => void>()
  #pairing: { secret: string; resolve: () => void; promise: Promise<void> } | null = null

  protected override async afterInit(): Promise<void> {
    this.store.putDevice(this.devicePubkey, this.pubkey, JSON.stringify(this.delegation), delegationName(this.delegation))
    const secret = this.store.getMeta('pairing_secret')
    if (secret) this.#armPairing(secret)
    await this.#rotateStaleKeys()
  }

  // ---- authorization -------------------------------------------------------------

  /** Membership of a space, evaluated from its signed op log. */
  protected membership(space: string): Membership {
    let m = this.#membership.get(space)
    if (!m) {
      const records: OpRecord[] = []
      for (const r of this.store.opRecords(space)) {
        const p = JSON.parse(r.payload) as { op: unknown; par: string[] }
        const op = parseOp(p.op)
        if (op) records.push({ id: r.msgId, identity: r.identity, op, par: p.par })
      }
      const devices = new Map(this.store.devices().map((d) => [d.device, d.identity]))
      m = evaluate(space, records, (d) => devices.get(d))
      this.#membership.set(space, m)
    }
    return m
  }

  protected override invalidateMembership(space: string): void {
    this.#membership.delete(space)
  }

  protected override isAuthorizedWriter(space: string, identity: string, device: string, seq: number): boolean {
    // App space: anyone, except devices this device knows to be revoked (revocations are
    // published in the identity's own spaces, so other users may not know about them).
    if (space === this.appSpace) return !this.store.devices(identity).some((d) => d.device === device && d.revoked)
    return mayWrite(this.membership(space), identity, device, seq)
  }

  protected override roleOf(space: string, identity: string): Role | undefined {
    if (space === this.appSpace) return 'writer'
    return this.membership(space).roles.get(identity)
  }

  protected override rebuildSpace(space: string): Set<string> {
    const touched = super.rebuildSpace(space)
    for (const snap of this.#completeSnapshots(space)) {
      // Cells that name their signer must still pass the row rule for that signer.
      const cells = snap.cells.filter((c) => {
        const by = (c as readonly unknown[])[5]
        return typeof by !== 'string' || changeAllowed(this.schema, c, by, this.roleOf(space, by))
      })
      for (const t of this.store.applyChanges(space, cells)) touched.add(t)
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

  /** Invite by npub / pubkey. The invitee must have published a key package. */
  async invite(space: string, who: string, role: Exclude<Role, 'owner'>): Promise<void> {
    this.#notAppSpace(space)
    const identity = parsePubkey(who)
    const devices = await this.#fetchKeyPackage(identity)
    if (devices.length === 0) throw new Error(`anoDB: ${npubEncode(identity)} has not published a key package (db.publishKeyPackage())`)
    await this.#addMember(space, identity, role, devices.map((d) => d.delegation))
  }

  async setRole(space: string, who: string, role: Exclude<Role, 'owner'>): Promise<void> {
    const identity = parsePubkey(who)
    const cut = canWrite(role) ? undefined : this.store.deviceMaxSeqs(space, identity)
    await this.#postOp(space, cut ? { type: 'role', identity, role, cut } : { type: 'role', identity, role })
  }

  async removeMember(space: string, who: string): Promise<void> {
    const identity = parsePubkey(who)
    await this.#postOp(space, { type: 'remove', identity, cut: this.store.deviceMaxSeqs(space, identity) })
    await this.rotateKey(space)
  }

  async transferOwnership(space: string, who: string): Promise<void> {
    await this.#postOp(space, { type: 'transfer', identity: parsePubkey(who) })
  }

  async leaveSpace(space: string): Promise<void> {
    await this.#postOp(space, { type: 'leave', cut: this.store.deviceMaxSeqs(space, this.pubkey) })
    this.store.setSpaceStatus(space, 'left')
    this.sync?.refresh()
  }

  async #postOp(space: string, op: MemberOp): Promise<void> {
    this.assertOpen()
    this.#notAppSpace(space)
    await this.gate.idle()
    const before = this.membership(space)
    const records = this.store.opRecords(space)
    const referenced = new Set(records.flatMap((r) => (JSON.parse(r.payload) as { par: string[] }).par))
    const par = records.map((r) => r.msgId).filter((id) => !referenced.has(id) && before.valid.includes(id))
    let changed = new Set<string>()
    this.store.transaction(() => {
      const { msgId } = this.sendToSpace(space, 'op', { op, par })
      this.invalidateMembership(space)
      if (!this.membership(space).valid.includes(msgId)) throw new Error(`anoDB: not allowed: ${op.type} in space ${space}`)
      changed = this.rebuildSpace(space)
    })
    this.notify(changed, 'local')
    void this.sync?.flush()
  }

  async #addMember(space: string, identity: string, role: Exclude<Role, 'owner'>, delegations: NostrEvent[], req?: string): Promise<void> {
    for (const d of delegations) {
      const device = d.tags.find((t) => t[0] === 'device')?.[1]
      if (device && verifyDelegation(d, device) === identity) this.store.putDevice(device, identity, JSON.stringify(d), delegationName(d))
    }
    if (!this.membership(space).roles.has(identity)) await this.#postOp(space, { type: 'add', identity, role })
    await this.rotateKey(space, new Map([[identity, req]]))
  }

  // ---- key rotation & snapshots -------------------------------------------------------

  /**
   * New epoch key: delivered to every active device of every member (new members get an
   * invitation instead), then a snapshot of the current state is posted in the new epoch.
   */
  async rotateKey(space: string, invitees = new Map<string, string | undefined>()): Promise<void> {
    this.#notAppSpace(space)
    this.assertOpen()
    const m = this.membership(space)
    const s = this.store.spaces().find((x) => x.id === space)
    if (!s) throw new Error(`anoDB: unknown space ${space}`)
    if (!mayManage(m, this.pubkey)) throw new Error('anoDB: only owners and admins can rotate keys')
    const key = randomBytes(32)
    const ek = await this.storeKey(space, key, this.currentKey(space).num + 1)
    await this.gate.idle()
    const ops = this.store.inners(space, 'op')
    const grant: KeyGrant = { sp: space, name: s.name, personal: s.personal, num: ek.num, key: bytesToHex(key), ops }
    this.store.transaction(() => {
      for (const [identity] of m.roles) {
        for (const d of this.store.devices(identity)) {
          if (d.revoked || d.device === this.devicePubkey || m.revokedDevices.has(d.device)) continue
          const invite = invitees.has(identity)
          const body = invite
            ? { ...grant, t: 'invite', role: m.roles.get(identity), ...(invitees.get(identity) ? { req: invitees.get(identity) } : {}) }
            : { ...grant, t: 'key' }
          this.#sendInbox(d.device, body)
        }
      }
    })
    this.#snapshot(space, ek)
    this.sync?.refresh()
    void this.sync?.flush()
  }

  /** Post the current state of a space as a (multi-part) snapshot message. */
  protected snapshot(space: string): void {
    this.#snapshot(space, this.currentKey(space))
  }

  #snapshot(space: string, key: EpochKey): void {
    const items: Array<{ op?: string; cell?: Change }> = [
      ...this.store.inners(space, 'op').map((op) => ({ op })),
      ...snapshotCells(this.store.cells(space)).map((cell) => ({ cell })),
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
    const heads = this.store.deviceMaxSeqs(space)
    const startedAt = Math.floor(this.now() / 1000)
    this.store.transaction(() => {
      parts.forEach((body, i) => this.sendToSpace(space, 'snap', { sid, i, n: parts.length, body: i === 0 ? { ...body, heads } : body }, key))
      this.store.setMeta(`snap:${space}`, String(Date.now()))
    })
    this.afterSnapshot(space, startedAt)
    void this.sync?.flush()
  }

  /** Hook (v0.4: prune superseded envelopes). */
  protected afterSnapshot(_space: string, _before: number): void {}

  /** Sequence numbers covered by complete, authorized snapshots: device → seq. */
  protected snapshotCoverage(space: string): Map<string, number> {
    const cover = new Map<string, number>()
    for (const snap of this.#completeSnapshots(space)) {
      for (const [d, seq] of Object.entries(snap.heads)) if (seq > (cover.get(d) ?? 0)) cover.set(d, seq)
    }
    return cover
  }

  /** Snapshots whose parts all arrived and whose author may write. */
  #completeSnapshots(space: string): Array<{ cells: Change[]; heads: Record<string, number> }> {
    const groups = new Map<string, Array<{ i: number; n: number; seq: number; identity: string; device: string; body: { ops?: unknown; cells?: unknown } }>>()
    for (const m of this.store.messages(space, 'snap')) {
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

  protected override afterLocalWrite(spaces: string[]): void {
    for (const space of spaces) this.#maybeSnapshot(space)
  }

  #maybeSnapshot(space: string): void {
    const since = Number(this.store.getMeta(`snap:${space}`) ?? '0')
    if (this.store.countMessages(space, 'ch', since) < SNAPSHOT_EVERY) return
    const role = this.membership(space).roles.get(this.pubkey)
    if (role !== 'owner' && role !== 'admin') return // others would not trust it (see #completeSnapshots)
    this.snapshot(space)
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

  protected override onMessage(space: string, identity: string, device: string, p: Parameters<AnoDBCore<S>['onMessage']>[3]): Set<string> {
    if (p.t === 'snap' && space !== this.appSpace) {
      // Import portable ops carried by the snapshot, then re-evaluate everything.
      const ops = (p.body as { ops?: unknown }).ops
      if (Array.isArray(ops)) for (const o of ops) if (typeof o === 'string') this.#importInner(space, o)
      this.invalidateMembership(space)
      return this.rebuildSpace(space)
    }
    return super.onMessage(space, identity, device, p)
  }

  protected override afterRemoteMessage(space: string, identity: string, device: string, p: Parameters<AnoDBCore<S>['afterRemoteMessage']>[3]): void {
    this.store.putDevice(device, identity, JSON.stringify(p.dlg), delegationName(p.dlg))
    if (p.t !== 'op' || space === this.appSpace) return
    const m = this.membership(space)
    const s = this.store.spaces().find((x) => x.id === space)
    if (s?.status === 'active' && !m.roles.has(this.pubkey) && m.owner !== null) {
      this.store.setSpaceStatus(space, 'removed')
      this.sync?.refresh()
      return
    }
    // A member left: the owner rotates so they cannot read what comes next.
    const op = parseOp((p as { op: unknown }).op)
    if (op?.type === 'leave' && m.owner === this.pubkey && m.valid.length > 0) void this.rotateKey(space).catch(() => {})
  }

  /** Store a portable signed op (from an invitation or snapshot) after verifying it. */
  #importInner(space: string, innerJson: string): boolean {
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
    if (this.store.hasMessage(space, inner.pubkey, p.seq)) return true
    this.store.putMessage({ space, device: inner.pubkey, seq: p.seq, identity, type: 'op', payload: inner.content }, inner.id, innerJson)
    this.store.putDevice(inner.pubkey, identity, JSON.stringify(p.dlg), delegationName(p.dlg))
    return true
  }

  // ---- inbox & secrets ---------------------------------------------------------------------

  protected override subscriptionTags(): string[] {
    const tags = [...super.subscriptionTags(), inboxTag(this.devicePubkey)]
    const now = this.now()
    for (const i of this.store.invitesOut()) if (!i.used && i.expires > now) tags.push(secretTag(i.secret))
    if (this.#pairing) tags.push(secretTag(this.#pairing.secret))
    return tags
  }

  #sendInbox(device: string, body: Record<string, unknown>): void {
    const inner = signWith(this.deviceSk, {
      kind: MESSAGE_KIND,
      created_at: Math.floor(this.now() / 1000),
      tags: [],
      content: JSON.stringify({ v: 2, dlg: this.delegation, ...body }),
    })
    const outer = this.wrapToDevice(JSON.stringify(inner), device)
    this.sync?.enqueue(outer, false)
  }

  #sendSecret(secret: string, body: Record<string, unknown>): void {
    const inner = signWith(this.deviceSk, {
      kind: MESSAGE_KIND,
      created_at: Math.floor(this.now() / 1000),
      tags: [],
      content: JSON.stringify({ v: 2, dlg: this.delegation, ...body }),
    })
    const outer = this.wrap(JSON.stringify(inner), secretTag(secret), secretKeyFor(secret))
    if (!this.sync) throw new Error('anoDB: no relays configured')
    this.sync.enqueue(outer, false)
    void this.sync.flush()
  }

  protected override ingestOther(tag: string, outer: NostrEvent): IngestResult {
    let convKey: Uint8Array | null = null
    let secret: string | null = null
    if (tag === inboxTag(this.devicePubkey)) {
      try {
        convKey = conversationKey(this.deviceSk, outer.pubkey)
      } catch {
        return 'invalid'
      }
    } else {
      secret = this.store.invitesOut().find((i) => secretTag(i.secret) === tag)?.secret ?? (this.#pairing && secretTag(this.#pairing.secret) === tag ? this.#pairing.secret : null)
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
    this.store.putRaw(outer, tag)
    try {
      if (secret === null) this.#onInbox(sender, inner.pubkey, p)
      else if (this.#pairing?.secret === secret && p.t === 'pair') void this.#onPaired(sender, p)
      else if (p.t === 'joinreq') this.#onJoinRequest(secret, sender, inner.pubkey, p)
    } catch {
      return 'invalid'
    }
    return 'new'
  }

  #onInbox(sender: string, senderDevice: string, p: Record<string, unknown>): void {
    if (p.t !== 'key' && p.t !== 'invite') return
    const g = p as unknown as KeyGrant & { role?: Role; req?: string }
    if (typeof g.sp !== 'string' || typeof g.key !== 'string' || !/^[0-9a-f]{64}$/.test(g.key) || !Array.isArray(g.ops)) return
    // Validate against the ops carried in the grant (plus what we know).
    const before = this.store.opRecords(g.sp).length
    this.store.transaction(() => {
      for (const o of g.ops) if (typeof o === 'string') this.#importInner(g.sp, o)
    })
    if (this.store.opRecords(g.sp).length !== before) this.invalidateMembership(g.sp)
    const m = this.membership(g.sp)
    const fromManager = mayManage(m, sender) || sender === this.pubkey
    if (!fromManager || !m.roles.has(this.pubkey)) return
    this.store.putDevice(senderDevice, sender, JSON.stringify(p.dlg), delegationName(p.dlg as NostrEvent))
    const known = this.store.spaces().find((s) => s.id === g.sp)
    if (p.t === 'invite' && known?.status !== 'active') {
      const requested = g.req && this.store.getMeta(`joinreq:${g.req}`)
      this.store.putInviteIn(g.sp, sender, m.roles.get(this.pubkey)!, String(g.name ?? ''), JSON.stringify(g))
      if (requested) {
        void this.acceptInvitation(g.sp)
        return
      }
      const inv: Invitation = { space: g.sp, name: String(g.name ?? ''), role: m.roles.get(this.pubkey)!, from: sender }
      for (const fn of this.#inviteListeners) fn(inv)
      return
    }
    if (known?.status !== 'active') return
    void this.#acceptKey(g, sender !== this.pubkey)
  }

  async #acceptKey(g: KeyGrant, forward: boolean): Promise<void> {
    const added = !this.keysByTag.has(spaceTag(hexToBytes(g.key)))
    await this.storeKey(g.sp, hexToBytes(g.key), g.num)
    if (!added) return
    this.sync?.refresh()
    // Share with my other devices (they may not be known to the sender).
    if (forward) {
      this.store.transaction(() => {
        for (const d of this.store.devices(this.pubkey)) {
          if (!d.revoked && d.device !== this.devicePubkey) this.#sendInbox(d.device, { ...g, t: 'key' })
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
    this.store.transaction(() => {
      this.store.upsertSpace(g.sp, g.name, false)
      this.store.setInviteInStatus(space, 'accepted')
    })
    this.invalidateMembership(space)
    this.sync?.refresh()
  }

  declineInvitation(space: string): void {
    this.store.setInviteInStatus(space, 'declined')
  }

  // ---- invite links ---------------------------------------------------------------------------

  /** One-time, expiring link. Whoever opens it can only *ask* to join; an admin must approve. */
  async createInviteLink(space: string, opts: { role?: Exclude<Role, 'owner'>; expiresInMs?: number } = {}): Promise<string> {
    this.#notAppSpace(space)
    if (!mayManage(this.membership(space), this.pubkey)) throw new Error('anoDB: only owners and admins can invite')
    const secret = randomHex(16)
    const role = opts.role ?? 'writer'
    this.store.putInviteOut(secret, space, role, this.now() + (opts.expiresInMs ?? 24 * 3600_000))
    this.sync?.refresh()
    return `anodb://join?app=${encodeURIComponent(this.appId)}&s=${secret}`
  }

  /** Invitee: ask to join via a link. The invitation that follows is accepted automatically. */
  async requestJoin(link: string, name = ''): Promise<void> {
    const u = new URL(link)
    const secret = u.searchParams.get('s')
    if (u.protocol !== 'anodb:' || !secret || !/^[0-9a-f]{32}$/.test(secret)) throw new Error('anoDB: invalid invite link')
    if (u.searchParams.get('app') !== this.appId) throw new Error('anoDB: invite link is for another app')
    if (this.store.invitesOut().some((i) => i.secret === secret))
      throw new AnoDBError('own-invite', 'This is your own invite link. Open it in another browser, a private window or on the other person’s device.')
    this.store.setMeta(`joinreq:${sha256Hex(secret)}`, '1')
    const devices = this.store.devices(this.pubkey).filter((d) => !d.revoked).map((d) => JSON.parse(d.delegation) as NostrEvent)
    this.#sendSecret(secret, { t: 'joinreq', devices, name })
  }

  #onJoinRequest(secret: string, identity: string, _device: string, p: Record<string, unknown>): void {
    const inv = this.store.invitesOut().find((i) => i.secret === secret)
    if (!inv || inv.used || inv.expires <= this.now()) return
    const id = sha256Hex(`${secret}/${identity}`).slice(0, 32)
    this.store.putJoinRequest(id, secret, identity, JSON.stringify(p))
    const req = this.#toJoinRequest({ id, secret, identity, payload: JSON.stringify(p) })
    if (req) for (const fn of this.#joinListeners) fn(req)
  }

  #toJoinRequest(r: { id: string; secret: string; identity: string; payload: string }): JoinRequest | null {
    const inv = this.store.invitesOut().find((i) => i.secret === r.secret)
    if (!inv) return null
    const p = JSON.parse(r.payload) as { name?: unknown }
    return { id: r.id, space: inv.space, role: inv.role as Role, identity: r.identity, npub: npubEncode(r.identity), name: typeof p.name === 'string' ? p.name.slice(0, 64) : '' }
  }

  joinRequests(): JoinRequest[] {
    return this.store.joinRequests().map((r) => this.#toJoinRequest(r)).filter((r) => r !== null)
  }

  onJoinRequest(fn: (r: JoinRequest) => void): () => void {
    this.#joinListeners.add(fn)
    return () => this.#joinListeners.delete(fn)
  }

  async approveJoinRequest(id: string): Promise<void> {
    const r = this.store.joinRequests().find((x) => x.id === id)
    if (!r) throw new Error('anoDB: no such join request')
    const inv = this.store.invitesOut().find((i) => i.secret === r.secret)
    if (!inv || inv.used || inv.expires <= this.now()) throw new Error('anoDB: invite link expired or already used')
    const p = JSON.parse(r.payload) as { devices?: unknown[] }
    const delegations = (p.devices ?? []).filter(isEvent)
    this.store.transaction(() => {
      this.store.markInviteUsed(r.secret)
      this.store.setJoinRequestStatus(id, 'approved')
    })
    await this.#addMember(inv.space, r.identity, inv.role as Exclude<Role, 'owner'>, delegations, sha256Hex(r.secret))
    this.sync?.refresh()
  }

  rejectJoinRequest(id: string): void {
    this.store.setJoinRequestStatus(id, 'rejected')
  }

  // ---- key packages ----------------------------------------------------------------------------

  /** Publish the list of this identity's devices so others can invite it by npub (needs the identity key). */
  async publishKeyPackage(): Promise<NostrEvent> {
    const signer = this.requireIdentitySigner()
    const delegations = this.store.devices(this.pubkey).filter((d) => !d.revoked).map((d) => JSON.parse(d.delegation) as NostrEvent)
    const ev = await createKeyPackage(signer, delegations, this.now())
    this.enqueuePlain(ev)
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
    this.store.setMeta('pairing_secret', secret)
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
        this.store.putDevice(device, this.pubkey, JSON.stringify(delegation), name)
        const spaces: KeyGrant[] = []
        for (const s of this.store.spaces()) {
          if (s.status !== 'active' || s.id === this.appSpace) continue // derived from the appId
          const k = this.currentKey(s.id)
          spaces.push({ sp: s.id, name: s.name, personal: s.personal, num: k.num, key: bytesToHex(k.key), ops: this.store.inners(s.id, 'op') })
        }
        this.#sendSecret(secret, { t: 'pair', delegation, spaces })
        // The new device catches up from a fresh snapshot of each space (not the full history).
        for (const s of spaces) this.snapshot(s.sp)
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
    this.store.wipe()
    this.store.setMeta('identity', sender)
    this.store.deleteMeta('pairing_secret')
    for (const g of grants) {
      const sealed = await this.keyStore.seal(hexToBytes(g.key))
      this.store.transaction(() => {
        this.store.putKey(g.sp, keyId(hexToBytes(g.key)), g.num, sealed)
        this.store.upsertSpace(g.sp, g.name, g.personal)
        for (const o of g.ops) if (typeof o === 'string') this.#importInner(g.sp, o)
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
    this.store.revokeDevice(device)
    for (const s of this.store.spaces()) {
      if (s.status !== 'active' || !this.membership(s.id).roles.has(this.pubkey)) continue
      await this.#postOp(s.id, { type: 'revoke', revocation, cut: { [device]: this.store.deviceMaxSeqs(s.id, undefined, device)[device] ?? 0 } })
      if (mayManage(this.membership(s.id), this.pubkey)) await this.rotateKey(s.id)
    }
  }

  // ---- write permission check uses roles ---------------------------------------------------------

  #notAppSpace(space: string): void {
    if (space === this.appSpace) throw new Error('anoDB: the app space is open to every user of the app; it has no members. Create a space for invite-only data.')
  }

  protected override assertCanWrite(space: string): void {
    if (space === this.appSpace) return
    const s = this.store.spaces().find((x) => x.id === space)
    if (!s || s.status !== 'active') throw new Error(`anoDB: unknown or inactive space "${space}"`)
    if (!canWrite(this.membership(space).roles.get(this.pubkey))) throw new Error(`anoDB: no write permission in space ${space}`)
  }
}
