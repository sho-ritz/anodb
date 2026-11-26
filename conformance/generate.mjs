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
import { spaceIdFor } from '../dist/membership.js'
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

console.log(`wrote ${out}`)
