// Writes the protocol v2 conformance vectors from the TypeScript reference implementation.
//   npm run build && node conformance/generate.mjs
// Every implementation (Rust core, …) must reproduce these results. Keys, Schnorr auxiliary data and
// NIP-44 nonces are derived from fixed seeds, so the output is byte-for-byte stable and only changes
// when behaviour changes (CI regenerates and diffs it).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schnorr } from '@noble/curves/secp256k1.js'
import * as nip44 from 'nostr-tools/nip44'
import { getEventHash } from 'nostr-tools/pure'
import {
  bytesToHex,
  conversationKey,
  getPublicKey,
  hexToBytes,
  inboxTag,
  keyId,
  npubEncode,
  nsecEncode,
  secretKeyFor,
  secretTag,
  sha256Hex,
  spaceTag,
  verifySignedEvent,
} from '../dist/crypto.js'
import { Clock, decodeHlc, encodeHlc } from '../dist/hlc.js'
import { DELEGATION_KIND, verifyDelegation } from '../dist/identity.js'
import { evaluate, mayManage, mayWrite, parseOp, spaceIdFor } from '../dist/membership.js'
import { changeAllowed } from '../dist/policy.js'
import { MESSAGE_KIND, TAG, WRAP_KIND, isChange, parseStreamPayload } from '../dist/protocol.js'
import { owned } from '../dist/schema.js'

const out = join(dirname(fileURLToPath(import.meta.url)), 'v2')
mkdirSync(out, { recursive: true })
const write = (name, data) => writeFileSync(join(out, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`)

const sk = (n) => hexToBytes(sha256Hex(`anodb/conformance/key/${n}`))

// Deterministic stand-ins for signWith / encrypt / createDelegation (same output shape; randomness
// replaced by a counter-derived seed). Verification below always uses the real implementation.
let seed = 0
const next = (what) => hexToBytes(sha256Hex(`anodb/conformance/${what}/${seed++}`))
const signWith = (key, t) => {
  const ev = { kind: t.kind, created_at: t.created_at, tags: t.tags, content: t.content, pubkey: getPublicKey(key) }
  const id = getEventHash(ev)
  return { ...ev, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), key, next('aux'))) }
}
const encrypt = (plaintext, key) => nip44.encrypt(plaintext, key, next('nonce'))
const createDelegation = (key, devicePubkey, name, nowMs) =>
  signWith(key, { kind: DELEGATION_KIND, created_at: Math.floor(nowMs / 1000), tags: [['device', devicePubkey]], content: JSON.stringify({ name }) })
const identitySk = sk('identity')
const deviceSk = sk('device')
const otherSk = sk('other')
const identity = getPublicKey(identitySk)
const device = getPublicKey(deviceSk)
const other = getPublicKey(otherSk)
const epochKey = hexToBytes(sha256Hex('anodb/conformance/epoch'))
const T = 1_790_000_000

// ---- keys -----------------------------------------------------------------------------
write('keys', {
  description: 'secret key → x-only public key and NIP-19 encodings',
  cases: ['identity', 'device', 'other', 'a', 'b'].map((n) => {
    const s = sk(n)
    return { secret: bytesToHex(s), pubkey: getPublicKey(s), nsec: nsecEncode(s), npub: npubEncode(getPublicKey(s)) }
  }),
})

// ---- tags & ids -----------------------------------------------------------------------
write('derivations', {
  description: 'routing tags, key ids and space ids (PROTOCOL.md §2, §5)',
  epoch: [0, 1, 2].map((i) => {
    const k = hexToBytes(sha256Hex(`anodb/conformance/epoch/${i}`))
    return { epochKey: bytesToHex(k), spaceTag: spaceTag(k), keyId: keyId(k) }
  }),
  inbox: [device, other].map((d) => ({ devicePubkey: d, inboxTag: inboxTag(d) })),
  secret: ['s3cret', 'ab12cd34'].map((s) => ({ secret: s, secretTag: secretTag(s), secretKey: bytesToHex(secretKeyFor(s)) })),
  spaceId: [['personal-nonce'], ['0123456789abcdef']].map(([nonce]) => ({ owner: identity, nonce, spaceId: spaceIdFor(identity, nonce) })),
})

// ---- NIP-44 v2 ------------------------------------------------------------------------
const nonce = (i) => sha256Hex(`anodb/conformance/nonce/${i}`)
write('nip44', {
  description: 'NIP-44 v2 conversation keys and encryption with a fixed nonce',
  conversationKeys: [
    { secret: bytesToHex(deviceSk), pubkey: other, conversationKey: bytesToHex(conversationKey(deviceSk, other)) },
    { secret: bytesToHex(otherSk), pubkey: device, conversationKey: bytesToHex(conversationKey(otherSk, device)) },
  ],
  encrypt: ['a', 'こんにちは anoDB', 'x'.repeat(1000), JSON.stringify({ v: 2, t: 'ch' })].map((plaintext, i) => ({
    conversationKey: bytesToHex(epochKey),
    nonce: nonce(i),
    plaintext,
    payload: nip44.encrypt(plaintext, epochKey, hexToBytes(nonce(i))),
  })),
})

// ---- events ---------------------------------------------------------------------------
const signed = signWith(identitySk, { kind: 1, created_at: T, tags: [['t', 'x'], ['e', 'a'.repeat(64), '', 'root']], content: 'hello "quoted"\n\ttab \u0001 ü 🎉' })
write('events', {
  description: 'NIP-01 event id + Schnorr signature verification',
  cases: [
    { name: 'valid', event: signed, valid: true },
    { name: 'tampered content', event: { ...signed, content: 'changed' }, valid: false },
    { name: 'tampered tags', event: { ...signed, tags: [] }, valid: false },
    { name: 'wrong pubkey', event: { ...signed, pubkey: other }, valid: false },
    { name: 'bad sig', event: { ...signed, sig: '0'.repeat(128) }, valid: false },
  ].map((c) => ({ ...c, valid: verifySignedEvent(c.event) })),
})

// ---- delegations ----------------------------------------------------------------------
const dlg = createDelegation(identitySk, device, 'phone', T * 1000)
const otherDlg = createDelegation(otherSk, device, 'x', T * 1000)
write('delegations', {
  description: 'verifyDelegation(event, devicePubkey) → identity or null (PROTOCOL.md §1.1)',
  cases: [
    { name: 'valid', event: dlg, device, identity },
    { name: 'other identity', event: otherDlg, device, identity: other },
    { name: 'wrong device', event: dlg, device: other, identity: null },
    { name: 'wrong kind', event: signWith(identitySk, { kind: 1, created_at: T, tags: [['device', device]], content: '' }), device, identity: null },
    { name: 'tampered', event: { ...dlg, tags: [['device', other]] }, device: other, identity: null },
  ].map((c) => ({ ...c, identity: verifyDelegation(c.event, c.device) })),
})

// ---- envelopes ------------------------------------------------------------------------
const space = spaceIdFor(identity, 'personal-nonce')
const kid = keyId(epochKey)
const tag = spaceTag(epochKey)
const inner = (payload, key = deviceSk) => signWith(key, { kind: MESSAGE_KIND, created_at: T, tags: [], content: typeof payload === 'string' ? payload : JSON.stringify(payload) })
const wrap = (innerEv, opts = {}) =>
  signWith(opts.signer ?? sk('throwaway'), {
    kind: opts.kind ?? WRAP_KIND,
    created_at: T,
    tags: [[TAG, opts.tag ?? tag]],
    content: encrypt(typeof innerEv === 'string' ? innerEv : JSON.stringify(innerEv), opts.key ?? epochKey),
  })
const hlc = (ms, c = 0) => encodeHlc({ millis: ms, counter: c, node: '0123456789abcdef' })
const ch = { v: 2, t: 'ch', sp: space, ep: kid, seq: 1, dlg, c: [['todo', `${identity}-row1`, 'title', 'milk', hlc(T * 1000)], ['todo', `${identity}-row1`, '$createdAt', T * 1000, hlc(T * 1000)]] }
const op = { v: 2, t: 'op', sp: space, ep: kid, seq: 2, dlg, op: { type: 'create', owner: identity, nonce: 'personal-nonce', name: 'personal' }, par: [] }
const snap = { v: 2, t: 'snap', sp: space, ep: kid, seq: 3, dlg, sid: 'abc', i: 0, n: 1, body: { cells: [] } }
const tamperedInner = { ...inner(ch), content: JSON.stringify({ ...ch, seq: 9 }) }
const envelopes = [
  { name: 'ch', outer: wrap(inner(ch)), result: 'ok' },
  { name: 'op', outer: wrap(inner(op)), result: 'ok' },
  { name: 'snap', outer: wrap(inner(snap)), result: 'ok' },
  { name: 'rp flag is ignored', outer: wrap(inner({ ...ch, rp: 1 })), result: 'ok' },
  { name: 'envelope not signed', outer: { ...wrap(inner(ch)), sig: '0'.repeat(128) }, result: 'invalid' },
  { name: 'wrong outer kind', outer: wrap(inner(ch), { kind: 1 }), result: 'invalid' },
  { name: 'unknown tag', outer: wrap(inner(ch), { tag: 'f'.repeat(32) }), result: 'unknown-tag' },
  { name: 'encrypted with another key', outer: wrap(inner(ch), { key: hexToBytes(sha256Hex('nope')) }), result: 'decrypt-failed' },
  { name: 'inner not an event', outer: wrap('{"hello":1}'), result: 'invalid-event' },
  { name: 'inner badly signed', outer: wrap(tamperedInner), result: 'invalid-event' },
  { name: 'inner wrong kind', outer: wrap(signWith(deviceSk, { kind: 1, created_at: T, tags: [], content: JSON.stringify(ch) })), result: 'invalid-event' },
  { name: 'protocol v3', outer: wrap(inner({ ...ch, v: 3 })), result: 'unsupported-protocol' },
  { name: 'unknown type', outer: wrap(inner({ ...ch, t: 'zz' })), result: 'unsupported-protocol' },
  { name: 'bad change', outer: wrap(inner({ ...ch, c: [['$todo', 'r', 'title', 1, hlc(1)]] })), result: 'unsupported-protocol' },
  { name: 'seq 0', outer: wrap(inner({ ...ch, seq: 0 })), result: 'unsupported-protocol' },
  { name: 'space mismatch', outer: wrap(inner({ ...ch, sp: 'a'.repeat(32) })), result: 'invalid-event' },
  { name: 'key id mismatch', outer: wrap(inner({ ...ch, ep: 'b'.repeat(16) })), result: 'invalid-event' },
  { name: 'delegation for another device', outer: wrap(inner(ch, otherSk)), result: 'invalid-event' },
]
write('envelopes', {
  description:
    'Opening a space-stream envelope (PROTOCOL.md §2–3), in this order: outer kind/tag, outer signature, NIP-44 decrypt, inner event + kind + signature, payload shape and version, sp/ep match, delegation. Results: ok | invalid | unknown-tag | decrypt-failed | invalid-event | unsupported-protocol.',
  key: { epochKey: bytesToHex(epochKey), space, keyId: kid, tag },
  cases: envelopes.map((e) => {
    const r = { name: e.name, outer: e.outer, result: e.result }
    if (e.result === 'ok') {
      const innerEv = JSON.parse(nip44.decrypt(e.outer.content, epochKey))
      const p = parseStreamPayload(innerEv.content)
      Object.assign(r, { device, identity: verifyDelegation(p.dlg, innerEv.pubkey), seq: p.seq, type: p.t, msgId: innerEv.id })
    }
    return r
  }),
})

// ---- payload shapes --------------------------------------------------------------------
const pl = (o) => JSON.stringify(o)
write('payloads', {
  description: 'parseStreamPayload: structural validation of a decrypted inner payload (§3)',
  cases: [
    ['ch', pl(ch)],
    ['op', pl(op)],
    ['snap', pl(snap)],
    ['not json', '{'],
    ['v1', pl({ ...ch, v: 1 })],
    ['space not 32 hex', pl({ ...ch, sp: 'xyz' })],
    ['key id not 16 hex', pl({ ...ch, ep: 'ABCDEF0123456789' })],
    ['seq float', pl({ ...ch, seq: 1.5 })],
    ['seq too large', pl({ ...ch, seq: 2 ** 53 })],
    ['no dlg', pl({ ...ch, dlg: undefined })],
    ['ch not array', pl({ ...ch, c: {} })],
    ['change table starts with $', pl({ ...ch, c: [['$x', 'r', 'c', 1, hlc(1)]] })],
    ['system column', pl({ ...ch, c: [['todo', 'r', '$deleted', true, hlc(1)]] })],
    ['row id empty', pl({ ...ch, c: [['todo', '', 'c', 1, hlc(1)]] })],
    ['row id 129 chars', pl({ ...ch, c: [['todo', 'r'.repeat(129), 'c', 1, hlc(1)]] })],
    ['bad hlc', pl({ ...ch, c: [['todo', 'r', 'c', 1, 'nope']] })],
    ['change with 6 elements', pl({ ...ch, c: [['todo', 'r', 'c', 1, hlc(1), identity]] })],
    ['op par not strings', pl({ ...op, par: [1] })],
    ['snap i >= n', pl({ ...snap, i: 1, n: 1 })],
    ['snap n too large', pl({ ...snap, i: 0, n: 10_001 })],
    ['unknown t', pl({ ...ch, t: 'zz' })],
  ].map(([name, json]) => ({ name, json, valid: parseStreamPayload(json) !== null })),
  changes: [
    ['todo', 'r', 'title', 'x', hlc(1)],
    ['todo', 'r', 'title', null, hlc(1)],
    ['Todo_2', 'r-1', 'col_9', { a: [1] }, hlc(5, 3)],
    ['todo', 'r', '$createdAt', 1, hlc(1)],
    ['1todo', 'r', 'c', 1, hlc(1)],
    ['todo', 'r', 'c-x', 1, hlc(1)],
    ['todo', 'r', 'c', 1],
  ].map((c) => ({ change: c, valid: isChange(c) })),
})

// ---- HLC ------------------------------------------------------------------------------
const steps = []
let wall = 1000
const clock = new Clock('0123456789abcdef', undefined, () => wall)
const step = (op, arg) => {
  if (op === 'wall') wall = arg
  else if (op === 'tick') steps.push({ op, wall, result: clock.tick() })
  else if (op === 'receive') {
    clock.receive(arg)
    steps.push({ op, wall, remote: arg, result: clock.current() })
  }
}
step('tick')
step('tick')
step('wall', 2000)
step('tick')
step('receive', encodeHlc({ millis: 5000, counter: 7, node: 'ffffffffffffffff' }))
step('tick')
step('receive', encodeHlc({ millis: 5000, counter: 20, node: 'ffffffffffffffff' }))
step('receive', encodeHlc({ millis: 100, counter: 99, node: 'ffffffffffffffff' }))
step('wall', 9000)
step('receive', encodeHlc({ millis: 3000, counter: 1, node: 'ffffffffffffffff' }))
step('tick')
const maxed = new Clock('0123456789abcdef', encodeHlc({ millis: 50, counter: 36 ** 5 - 1, node: 'ffffffffffffffff' }), () => 10)
write('hlc', {
  description: 'Hybrid logical clock: encoding (base36 millis[10] + counter[5] + "-" + node[16]) and tick/receive with a controlled wall clock (§4)',
  encode: [
    { millis: 0, counter: 0, node: '0123456789abcdef' },
    { millis: 1_790_000_000_000, counter: 42, node: 'fedcba9876543210' },
    { millis: 36 ** 10 - 1, counter: 36 ** 5 - 1, node: 'ffffffffffffffff' },
  ].map((t) => ({ ...t, hlc: encodeHlc(t) })),
  invalid: ['', 'ABC', '0000000000000000-0123456789abcdef', '000000000000000-0123456789ABCDEF', '000000000000000_0123456789abcdef'].map((s) => {
    try {
      decodeHlc(s)
      return { hlc: s, valid: true }
    } catch {
      return { hlc: s, valid: false }
    }
  }),
  clock: { node: '0123456789abcdef', steps },
  counterOverflow: { node: '0123456789abcdef', start: encodeHlc({ millis: 50, counter: 36 ** 5 - 1, node: 'ffffffffffffffff' }), wall: 10, tick: maxed.tick() },
})

// ---- merge ----------------------------------------------------------------------------
const mergeCase = (name, changes) => {
  const state = new Map()
  for (const c of changes) {
    const k = `${c[0]}\u0000${c[1]}\u0000${c[2]}`
    const cur = state.get(k)
    if (cur && cur[4] >= c[4]) continue // a change wins iff its HLC is greater
    state.set(k, c)
  }
  return { name, changes, result: [...state.values()].sort((a, b) => (a.slice(0, 3).join('\u0000') < b.slice(0, 3).join('\u0000') ? -1 : 1)) }
}
const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const h = (ms, c, n) => encodeHlc({ millis: ms, counter: c, node: n })
write('merge', {
  description: 'Last-writer-wins per (table, rowId, column): a change replaces the cell iff its HLC string is strictly greater (§4). Applying the changes in any order gives the same result.',
  cases: [
    mergeCase('later wins', [['t', 'r', 'c', 1, h(10, 0, A)], ['t', 'r', 'c', 2, h(20, 0, A)]]),
    mergeCase('arrival order does not matter', [['t', 'r', 'c', 2, h(20, 0, A)], ['t', 'r', 'c', 1, h(10, 0, A)]]),
    mergeCase('counter breaks ties', [['t', 'r', 'c', 'x', h(10, 2, A)], ['t', 'r', 'c', 'y', h(10, 1, B)]]),
    mergeCase('node breaks ties', [['t', 'r', 'c', 'x', h(10, 0, B)], ['t', 'r', 'c', 'y', h(10, 0, A)]]),
    mergeCase('equal hlc keeps first', [['t', 'r', 'c', 'first', h(10, 0, A)], ['t', 'r', 'c', 'second', h(10, 0, A)]]),
    mergeCase('columns merge independently', [['t', 'r', 'a', 1, h(10, 0, A)], ['t', 'r', 'b', 2, h(5, 0, B)], ['t', 'r', 'a', 3, h(4, 0, B)]]),
    mergeCase('tombstone is a cell', [['t', 'r', 'title', 'x', h(10, 0, A)], ['t', 'r', '$deleted', true, h(20, 0, B)], ['t', 'r', 'title', 'late', h(15, 0, A)]]),
  ],
})

// ---- row rule -------------------------------------------------------------------------
const schema = { plain: { title: 'text' }, mine: owned({ title: 'text' }) }
const rows = { byWriter: `${identity}-r1`, byOther: `${other}-r1`, identityOnly: identity, noCreator: 'customid' }
const policy = []
for (const table of ['plain', 'mine', 'unknown'])
  for (const [rowKind, rowId] of Object.entries(rows))
    for (const column of ['title', '$createdAt', '$deleted'])
      for (const role of ['owner', 'admin', 'writer', null]) {
        const change = [table, rowId, column, column === '$deleted' ? true : 'v', h(1, 0, A)]
        policy.push({ table, row: rowKind, rowId, column, writer: identity, role, allowed: changeAllowed(schema, change, identity, role ?? undefined) })
      }
write('policy', {
  description: 'Row rule (§4.1) for writer = identity. Tables: plain, owned ("mine"), and a table the schema does not know ("unknown").',
  identity,
  other,
  tables: { plain: 'plain', mine: 'owned', unknown: 'not in schema' },
  cases: policy,
})

// ---- membership (§5.1) ------------------------------------------------------------------
// Identities and their devices. Op ids are stand-ins for inner message ids (any distinct hex).
const who = Object.fromEntries(['owner', 'admin', 'admin2', 'writer', 'reader', 'stranger'].map((n) => [n, getPublicKey(sk(`member/${n}`))]))
const dev = Object.fromEntries(Object.keys(who).map((n) => [n, getPublicKey(sk(`member-device/${n}`))]))
const devices = Object.fromEntries(Object.keys(who).map((n) => [dev[n], who[n]]))
const mSpace = spaceIdFor(who.owner, 'n1')
const opId = (label) => sha256Hex(`anodb/conformance/op/${label}`)
const revocation = (idName, devName) =>
  signWith(sk(`member/${idName}`), { kind: DELEGATION_KIND, created_at: T, tags: [['revoke', dev[devName]]], content: '' })
const sortObj = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1)))

/** `log`: [label, author, op, parentLabels]. Builds the records the way sharing.ts does (parseOp, drop invalid). */
const membershipCase = (name, log, { space: sp = mSpace, extraIds = {} } = {}) => {
  const records = log.map(([label, author, op, par]) => ({ id: extraIds[label] ?? opId(label), identity: who[author], op, par: par.map((p) => extraIds[p] ?? opId(p)) }))
  const parsed = records.flatMap((r) => {
    const op = parseOp(r.op)
    return op ? [{ ...r, op }] : []
  })
  const m = evaluate(sp, parsed, (d) => devices[d])
  const writes = []
  for (const n of Object.keys(who)) {
    const c = m.cut.get(dev[n])
    for (const seq of [...new Set([1, c ?? 5, (c ?? 5) + 1])].sort((a, b) => a - b))
      writes.push({ identity: who[n], device: dev[n], seq, mayWrite: mayWrite(m, who[n], dev[n], seq) })
  }
  return {
    name,
    space: sp,
    records,
    labels: Object.fromEntries(records.map((r, i) => [log[i][0], r.id])),
    result: {
      owner: m.owner,
      roles: sortObj(m.roles),
      cut: sortObj(m.cut),
      everWriter: [...m.everWriter].sort(),
      revokedDevices: [...m.revokedDevices].sort(),
      valid: m.valid,
    },
    manage: Object.fromEntries(Object.keys(who).map((n) => [who[n], mayManage(m, who[n])])),
    writes,
  }
}

const create = (nonce = 'n1', owner = who.owner) => ({ type: 'create', owner, nonce, name: 'Family' })
const add = (n, role) => ({ type: 'add', identity: who[n], role })
const cutOf = (n, seq) => ({ [dev[n]]: seq })
const membership = [
  membershipCase('create only', [['c', 'owner', create(), []]]),
  membershipCase('create: wrong nonce for the space id', [['c', 'owner', create('other'), []]]),
  membershipCase('create: signed by someone other than the owner', [['c', 'stranger', create(), []]]),
  membershipCase('create: with parents', [['c0', 'owner', create(), []], ['c', 'owner', create(), ['c0']]]),
  membershipCase('add: owner adds any role, admin adds writer/reader only', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    ['a2', 'admin', add('writer', 'writer'), ['a1']],
    ['a3', 'admin', add('admin2', 'admin'), ['a2']],
    ['a4', 'writer', add('reader', 'reader'), ['a2']],
    ['a5', 'admin', add('reader', 'reader'), ['a2']],
  ]),
  membershipCase('add: an existing member cannot be added again', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('writer', 'writer'), ['c']],
    ['a2', 'owner', add('writer', 'admin'), ['a1']],
  ]),
  membershipCase('add: needs the author to be in the state of its ancestors', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    // admin adds writer without having seen its own add op
    ['a2', 'admin', add('writer', 'writer'), ['c']],
  ]),
  membershipCase('role: demote with a cut-off, admin may not touch admins', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    ['a2', 'owner', add('admin2', 'admin'), ['a1']],
    ['a3', 'owner', add('writer', 'writer'), ['a2']],
    ['r1', 'admin', { type: 'role', identity: who.writer, role: 'reader', cut: cutOf('writer', 7) }, ['a3']],
    ['r2', 'admin', { type: 'role', identity: who.admin2, role: 'writer' }, ['a3']],
    ['r3', 'admin', { type: 'role', identity: who.writer, role: 'admin' }, ['a3']],
    ['r4', 'admin', { type: 'role', identity: who.owner, role: 'writer' }, ['a3']],
  ]),
  membershipCase('role: promoting back to writer lifts the cut-off', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('writer', 'writer'), ['c']],
    ['r1', 'owner', { type: 'role', identity: who.writer, role: 'reader', cut: cutOf('writer', 3) }, ['a1']],
    ['r2', 'owner', { type: 'role', identity: who.writer, role: 'writer' }, ['r1']],
  ]),
  membershipCase('remove: cut-off applies, the owner cannot be removed', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    ['a2', 'owner', add('writer', 'writer'), ['a1']],
    ['x1', 'admin', { type: 'remove', identity: who.writer, cut: cutOf('writer', 4) }, ['a2']],
    ['x2', 'admin', { type: 'remove', identity: who.owner, cut: {} }, ['a2']],
  ]),
  membershipCase('remove: admin cannot remove an admin', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    ['a2', 'owner', add('admin2', 'admin'), ['a1']],
    ['x1', 'admin', { type: 'remove', identity: who.admin2, cut: {} }, ['a2']],
  ]),
  membershipCase('remove wins over a concurrent role change', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    ['a2', 'owner', add('writer', 'reader'), ['a1']],
    ['x1', 'owner', { type: 'remove', identity: who.writer, cut: cutOf('writer', 2) }, ['a2']],
    ['r1', 'admin', { type: 'role', identity: who.writer, role: 'writer' }, ['a2']],
  ]),
  membershipCase('a re-add that has seen only one of two removals is overridden by the other', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    ['a2', 'owner', add('writer', 'writer'), ['a1']],
    ['x1', 'owner', { type: 'remove', identity: who.writer, cut: cutOf('writer', 6) }, ['a2']],
    ['x2', 'admin', { type: 'remove', identity: who.writer, cut: cutOf('writer', 8) }, ['a2']],
    ['a3', 'admin', add('writer', 'reader'), ['x2']],
  ]),
  membershipCase('re-add after every removal', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('writer', 'writer'), ['c']],
    ['x1', 'owner', { type: 'remove', identity: who.writer, cut: cutOf('writer', 6) }, ['a1']],
    ['a2', 'owner', add('writer', 'writer'), ['x1']],
  ]),
  membershipCase('concurrent removals combine cut-offs to the minimum', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    ['a2', 'owner', add('writer', 'writer'), ['a1']],
    ['x1', 'owner', { type: 'remove', identity: who.writer, cut: cutOf('writer', 9) }, ['a2']],
    ['x2', 'admin', { type: 'remove', identity: who.writer, cut: cutOf('writer', 5) }, ['a2']],
  ]),
  membershipCase('leave: members may leave, the owner may not', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('writer', 'writer'), ['c']],
    ['l1', 'writer', { type: 'leave', cut: cutOf('writer', 3) }, ['a1']],
    ['l2', 'owner', { type: 'leave', cut: {} }, ['a1']],
    ['l3', 'stranger', { type: 'leave', cut: {} }, ['a1']],
  ]),
  membershipCase('transfer: old owner becomes admin; only the owner, only to a member', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('admin', 'admin'), ['c']],
    ['t1', 'owner', { type: 'transfer', identity: who.admin }, ['a1']],
    ['t2', 'owner', { type: 'transfer', identity: who.admin }, ['t1']],
    ['t3', 'admin', { type: 'transfer', identity: who.stranger }, ['t1']],
    ['t4', 'owner', { type: 'transfer', identity: who.owner }, ['a1']],
  ]),
  membershipCase('revoke: any member relays a valid revocation', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('writer', 'writer'), ['c']],
    ['a2', 'owner', add('reader', 'reader'), ['a1']],
    ['v1', 'reader', { type: 'revoke', revocation: revocation('writer', 'writer'), cut: {} }, ['a2']],
    ['v2', 'stranger', { type: 'revoke', revocation: revocation('reader', 'reader'), cut: {} }, ['a2']],
    ['v3', 'owner', { type: 'revoke', revocation: revocation('owner', 'owner'), cut: cutOf('owner', 10) }, ['a2']],
  ]),
  membershipCase('revoke: a forged revocation is not an op', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('writer', 'writer'), ['c']],
    ['v1', 'owner', { type: 'revoke', revocation: { ...revocation('writer', 'writer'), content: 'x' }, cut: {} }, ['a1']],
  ]),
  membershipCase('missing parents and cycles are not evaluated', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('writer', 'writer'), ['missing']],
    ['a2', 'owner', add('reader', 'reader'), ['c', 'loop2']],
    ['loop2', 'owner', add('admin', 'admin'), ['a2']],
    ['self', 'owner', add('admin2', 'admin'), ['self']],
    ['a3', 'owner', add('admin', 'admin'), ['c', 'c']],
  ]),
  membershipCase('a writer that was never removed has no cut-off', [
    ['c', 'owner', create(), []],
    ['a1', 'owner', add('writer', 'writer'), ['c']],
    ['a2', 'owner', add('reader', 'reader'), ['a1']],
  ]),
]

const opShapes = [
  [create(), true],
  [{ type: 'create', owner: who.owner.toUpperCase(), nonce: 'n', name: 'x' }, false],
  [{ type: 'create', owner: who.owner, nonce: 1, name: 'x' }, false],
  [{ type: 'create', owner: who.owner, nonce: 'n' }, false],
  [add('writer', 'writer'), true],
  [add('writer', 'owner'), false],
  [add('writer', 'boss'), false],
  [{ type: 'add', identity: 'x', role: 'reader' }, false],
  [{ type: 'role', identity: who.writer, role: 'reader' }, true],
  [{ type: 'role', identity: who.writer, role: 'reader', cut: {} }, true],
  [{ type: 'role', identity: who.writer, role: 'reader', cut: { [dev.writer]: -1 } }, false],
  [{ type: 'role', identity: who.writer, role: 'reader', cut: null }, false],
  [{ type: 'remove', identity: who.writer, cut: cutOf('writer', 3) }, true],
  [{ type: 'remove', identity: who.writer }, false],
  [{ type: 'remove', identity: who.writer, cut: { [dev.writer]: 1.5 } }, false],
  [{ type: 'remove', identity: who.writer, cut: { [dev.writer]: 2 ** 53 } }, false],
  [{ type: 'remove', identity: who.writer, cut: { [dev.writer]: 2 ** 53 - 1 } }, true],
  [{ type: 'remove', identity: who.writer, cut: { short: 1 } }, false],
  [{ type: 'remove', identity: who.writer, cut: [] }, true],
  [{ type: 'remove', identity: who.writer, cut: [1] }, false],
  [{ type: 'remove', identity: who.writer, cut: { [dev.writer]: '3' } }, false],
  [{ type: 'leave', cut: {} }, true],
  [{ type: 'leave' }, false],
  [{ type: 'transfer', identity: who.admin }, true],
  [{ type: 'transfer' }, false],
  [{ type: 'revoke', revocation: revocation('writer', 'writer'), cut: {} }, true],
  [{ type: 'revoke', revocation: { ...revocation('writer', 'writer'), kind: 1 }, cut: {} }, false],
  [{ type: 'revoke', revocation: revocation('writer', 'writer') }, false],
  [{ type: 'join', identity: who.admin }, false],
  [[], false],
  ['create', false],
]
for (const [op, valid] of opShapes)
  if ((parseOp(op) !== null) !== valid) throw new Error(`op shape expectation is wrong: ${JSON.stringify(op)}`)

write('membership', {
  description:
    'Membership evaluation (§5.1). Each case lists op records {id, identity, op, par}; records whose op does not parse are dropped (like sharing.ts) before evaluate(). `devices` maps device → identity for cut-off lifting. `writes` are mayWrite(identity, device, seq) and `manage` mayManage(identity) under the result.',
  identities: who,
  devices,
  ops: opShapes.map(([op, valid]) => ({ op, valid })),
  cases: membership,
})

console.log(`wrote ${out}`)
