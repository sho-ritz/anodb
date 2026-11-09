import { sha256Hex } from './crypto.js'
import { verifyRevocation } from './identity.js'

export type Role = 'owner' | 'admin' | 'writer' | 'reader'
export const ROLES: readonly Role[] = ['owner', 'admin', 'writer', 'reader']
const RANK: Record<Role, number> = { owner: 3, admin: 2, writer: 1, reader: 0 }
export const canWrite = (r: Role | undefined) => r !== undefined && RANK[r] >= RANK.writer
export const isAdmin = (r: Role | undefined) => r !== undefined && RANK[r] >= RANK.admin

/** device pubkey → highest accepted seq */
export type Cutoffs = Record<string, number>

export type MemberOp =
  | { type: 'create'; owner: string; nonce: string; name: string; personal?: boolean }
  | { type: 'add'; identity: string; role: Exclude<Role, 'owner'> }
  | { type: 'role'; identity: string; role: Exclude<Role, 'owner'>; cut?: Cutoffs }
  | { type: 'remove'; identity: string; cut: Cutoffs }
  | { type: 'leave'; cut: Cutoffs }
  | { type: 'transfer'; identity: string }
  | { type: 'revoke'; revocation: unknown; cut: Cutoffs }

export interface OpRecord {
  /** inner message id */
  id: string
  /** signing identity (from the delegation) */
  identity: string
  op: MemberOp
  par: string[]
}

export interface Membership {
  owner: string | null
  roles: Map<string, Role>
  /** device → cutoff; writes with a higher seq from that device are rejected */
  cut: Map<string, number>
  /** identities that held a write role at some point (so cut-off writes may still count) */
  everWriter: Set<string>
  revokedDevices: Set<string>
  /** ops that were valid, in evaluation order */
  valid: string[]
}

/** Space ids commit to their owner, so nobody else can forge the `create` op. */
export function spaceIdFor(owner: string, nonce: string): string {
  return sha256Hex(`anodb/v2/space-id/${owner}/${nonce}`).slice(0, 32)
}

const HEX64 = /^[0-9a-f]{64}$/
const isCut = (c: unknown): c is Cutoffs =>
  typeof c === 'object' && c !== null && Object.entries(c).every(([k, v]) => HEX64.test(k) && Number.isSafeInteger(v) && (v as number) >= 0)
const isRole = (r: unknown): r is Exclude<Role, 'owner'> => r === 'admin' || r === 'writer' || r === 'reader'

export function parseOp(o: unknown): MemberOp | null {
  if (typeof o !== 'object' || o === null) return null
  const x = o as Record<string, unknown>
  const id = typeof x.identity === 'string' && HEX64.test(x.identity)
  switch (x.type) {
    case 'create':
      return typeof x.owner === 'string' && HEX64.test(x.owner) && typeof x.nonce === 'string' && typeof x.name === 'string' ? (x as MemberOp) : null
    case 'add':
      return id && isRole(x.role) ? (x as MemberOp) : null
    case 'role':
      return id && isRole(x.role) && (x.cut === undefined || isCut(x.cut)) ? (x as MemberOp) : null
    case 'remove':
      return id && isCut(x.cut) ? (x as MemberOp) : null
    case 'leave':
      return isCut(x.cut) ? (x as MemberOp) : null
    case 'transfer':
      return id ? (x as MemberOp) : null
    case 'revoke':
      return isCut(x.cut) && verifyRevocation(x.revocation) ? (x as MemberOp) : null
    default:
      return null
  }
}

function empty(): Membership {
  return { owner: null, roles: new Map(), cut: new Map(), everWriter: new Set(), revokedDevices: new Set(), valid: [] }
}

function mergeCut(state: Membership, cut: Cutoffs): void {
  for (const [device, seq] of Object.entries(cut)) {
    const prev = state.cut.get(device)
    state.cut.set(device, prev === undefined ? seq : Math.min(prev, seq)) // stricter cut-off wins
  }
}

/**
 * Deterministically evaluate a membership log.
 *
 * - Ops form a DAG through `par` (the op ids the author had seen). An op whose parents are not all
 *   known is not evaluated yet.
 * - An op is valid iff its author was allowed to perform it in the state formed by its ancestors.
 * - A removal wins over every add / role change for the same identity that is not its descendant.
 * - Cut-offs from concurrent removals combine to the smaller value.
 */
export function evaluate(space: string, records: readonly OpRecord[], deviceIdentity: (device: string) => string | undefined): Membership {
  const byId = new Map(records.map((r) => [r.id, r]))
  // Resolve evaluable ops (all ancestors known) and a deterministic topological order.
  const anc = new Map<string, Set<string>>()
  const ancestors = (id: string, stack = new Set<string>()): Set<string> | null => {
    const memo = anc.get(id)
    if (memo) return memo
    const r = byId.get(id)
    if (!r || stack.has(id)) return null
    stack.add(id)
    const out = new Set<string>()
    for (const p of r.par) {
      const a = ancestors(p, stack)
      if (!a) return null
      out.add(p)
      for (const x of a) out.add(x)
    }
    stack.delete(id)
    anc.set(id, out)
    return out
  }
  const evaluable = records.filter((r) => ancestors(r.id) !== null)
  const order = [...evaluable].sort((a, b) => anc.get(a.id)!.size - anc.get(b.id)!.size || (a.id < b.id ? -1 : 1))
  // Sorting by ancestor count is a valid topological order (a parent always has fewer ancestors).

  const valid = new Set<string>()
  const fold = (ids: Iterable<string>): Membership => {
    const st = empty()
    const set = new Set(ids)
    for (const r of order) {
      if (!set.has(r.id) || !valid.has(r.id)) continue
      apply(st, r, anc.get(r.id)!, deviceIdentity)
    }
    return st
  }

  for (const r of order) {
    const before = fold(anc.get(r.id)!)
    if (allowed(space, before, r)) valid.add(r.id)
  }
  const final = fold(valid)
  final.valid = order.filter((r) => valid.has(r.id)).map((r) => r.id)
  return final
}

function allowed(space: string, st: Membership, r: OpRecord): boolean {
  const me = st.roles.get(r.identity)
  const op = r.op
  switch (op.type) {
    case 'create':
      return r.par.length === 0 && op.owner === r.identity && spaceIdFor(op.owner, op.nonce) === space
    case 'add': {
      if (st.owner === null || st.roles.has(op.identity)) return false
      return me === 'owner' || (me === 'admin' && op.role !== 'admin')
    }
    case 'role': {
      const target = st.roles.get(op.identity)
      if (!target || target === 'owner') return false
      return me === 'owner' || (me === 'admin' && target !== 'admin' && op.role !== 'admin')
    }
    case 'remove': {
      const target = st.roles.get(op.identity)
      if (!target || target === 'owner') return false
      return me === 'owner' || (me === 'admin' && target !== 'admin')
    }
    case 'leave':
      return me !== undefined && me !== 'owner'
    case 'transfer':
      return me === 'owner' && st.roles.has(op.identity) && op.identity !== r.identity
    case 'revoke': {
      const rv = verifyRevocation(op.revocation)
      return rv !== null && me !== undefined
    }
  }
}

function apply(st: Membership, r: OpRecord, ancestors: Set<string>, deviceIdentity: (d: string) => string | undefined): void {
  const op = r.op
  const removedConcurrently = (identity: string) =>
    [...(st as MembershipWithRemovals).removals?.get(identity) ?? []].some((rem) => !ancestors.has(rem))
  switch (op.type) {
    case 'create':
      st.owner = op.owner
      st.roles.set(op.owner, 'owner')
      st.everWriter.add(op.owner)
      break
    case 'add':
      if (removedConcurrently(op.identity)) break
      st.roles.set(op.identity, op.role)
      if (canWrite(op.role)) st.everWriter.add(op.identity)
      // a (re-)add after a removal lifts that identity's old cut-offs
      for (const [d] of st.cut) if (deviceIdentity(d) === op.identity) st.cut.delete(d)
      break
    case 'role': {
      if (removedConcurrently(op.identity)) break
      const prev = st.roles.get(op.identity)
      if (!prev) break
      st.roles.set(op.identity, op.role)
      if (canWrite(op.role)) {
        st.everWriter.add(op.identity)
        for (const [d] of st.cut) if (deviceIdentity(d) === op.identity) st.cut.delete(d)
      } else if (op.cut) mergeCut(st, op.cut)
      break
    }
    case 'remove': {
      st.roles.delete(op.identity)
      mergeCut(st, op.cut)
      const rm = ((st as MembershipWithRemovals).removals ??= new Map())
      rm.set(op.identity, [...(rm.get(op.identity) ?? []), r.id])
      break
    }
    case 'leave':
      st.roles.delete(r.identity)
      mergeCut(st, op.cut)
      break
    case 'transfer':
      if (st.owner) st.roles.set(st.owner, 'admin')
      st.owner = op.identity
      st.roles.set(op.identity, 'owner')
      st.everWriter.add(op.identity)
      break
    case 'revoke': {
      const rv = verifyRevocation(op.revocation)!
      st.revokedDevices.add(rv.device)
      mergeCut(st, op.cut)
      break
    }
  }
}

type MembershipWithRemovals = Membership & { removals?: Map<string, string[]> }

/** May `identity` (via `device`) have written message number `seq`? */
export function mayWrite(st: Membership, identity: string, device: string, seq: number): boolean {
  const cut = st.cut.get(device)
  if (cut !== undefined && seq > cut) return false
  if (st.revokedDevices.has(device) && cut === undefined) return false
  if (canWrite(st.roles.get(identity))) return true
  // No longer a writer: only messages up to the cut-off recorded when the role was lost count.
  return cut !== undefined && st.everWriter.has(identity)
}

/** May `identity` distribute keys / snapshots for the space? */
export function mayManage(st: Membership, identity: string): boolean {
  return isAdmin(st.roles.get(identity))
}
