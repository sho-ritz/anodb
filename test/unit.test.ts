import { describe, expect, it } from 'vitest'
import { Clock, decodeHlc, encodeHlc } from '../src/hlc.js'
import { type Change, decodePayload, encodePayload, splitChanges } from '../src/protocol.js'
import { defineSchema } from '../src/schema.js'
import { OwnerKey, namespaceTag, parseSecretKey } from '../src/crypto.js'

const NODE_A = 'aaaaaaaaaaaaaaaa'
const NODE_B = 'bbbbbbbbbbbbbbbb'

describe('HLC', () => {
  it('round-trips and sorts lexicographically by time, counter, node', () => {
    const t = { millis: 1_762_000_000_000, counter: 7, node: NODE_A }
    expect(decodeHlc(encodeHlc(t))).toEqual(t)
    const a = encodeHlc({ millis: 1000, counter: 99, node: NODE_B })
    const b = encodeHlc({ millis: 1001, counter: 0, node: NODE_A })
    const c = encodeHlc({ millis: 1001, counter: 0, node: NODE_B })
    expect([c, b, a].sort()).toEqual([a, b, c])
  })

  it('is strictly monotonic even when the wall clock stalls or goes back', () => {
    let wall = 5000
    const clock = new Clock(NODE_A, undefined, () => wall)
    const seen: string[] = []
    for (let i = 0; i < 5; i++) seen.push(clock.tick())
    wall = 4000
    for (let i = 0; i < 5; i++) seen.push(clock.tick())
    expect([...seen].sort()).toEqual(seen)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('orders local writes after received remote timestamps', () => {
    const clock = new Clock(NODE_A, undefined, () => 1000)
    const remote = encodeHlc({ millis: 9000, counter: 3, node: NODE_B })
    clock.receive(remote)
    expect(clock.tick() > remote).toBe(true)
  })
})

describe('protocol', () => {
  const ch = (i: number, v: unknown = 'x'): Change => ['todo', `r${i}`, 'title', v, encodeHlc({ millis: 1, counter: i, node: NODE_A })]

  it('encodes, decodes and rejects malformed payloads', () => {
    const changes = [ch(1), ch(2, { nested: [1, 2] })]
    expect(decodePayload(encodePayload(changes))?.changes).toEqual(changes)
    expect(decodePayload('nope')).toBeNull()
    expect(decodePayload(JSON.stringify({ v: 99, changes: [] }))).toBeNull()
    expect(decodePayload(JSON.stringify({ v: 1, changes: [['todo', 'r', 'title', 1, 'bad-hlc']] }))).toBeNull()
    expect(decodePayload(JSON.stringify({ v: 1, changes: [['$x', 'r', 'title', 1, ch(1)[4]]] }))).toBeNull()
  })

  it('splits large transactions under the byte limit', () => {
    const big = Array.from({ length: 200 }, (_, i) => ch(i, 'y'.repeat(500)))
    const parts = splitChanges(big, 20_000)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.flat()).toEqual(big)
    for (const p of parts) expect(new TextEncoder().encode(encodePayload(p)).length).toBeLessThanOrEqual(20_000)
    expect(() => splitChanges([ch(0, 'z'.repeat(30_000))], 20_000)).toThrow(/exceeds/)
  })
})

describe('schema', () => {
  it('rejects reserved or invalid names', () => {
    expect(() => defineSchema({ todo: { id: 'text' } })).toThrow(/reserved/)
    expect(() => defineSchema({ anodb_x: { a: 'text' } })).toThrow(/reserved/)
    expect(() => defineSchema({ 'bad name': { a: 'text' } })).toThrow(/invalid/)
    expect(() => defineSchema({ t: { a: 'blob' as 'text' } })).toThrow(/unknown column type/)
  })
})

describe('crypto', () => {
  it('parses nsec/hex/bytes and self-encrypts', () => {
    const k = OwnerKey.generate()
    expect(new OwnerKey(parseSecretKey(k.nsec)).pubkey).toBe(k.pubkey)
    expect(new OwnerKey(parseSecretKey(k.hex)).pubkey).toBe(k.pubkey)
    const ct = k.encryptToSelf('secret')
    expect(ct).not.toContain('secret')
    expect(k.decryptFromSelf(ct)).toBe('secret')
    expect(() => OwnerKey.generate().decryptFromSelf(ct)).toThrow()
  })

  it('namespace tag differs per app and per owner', () => {
    expect(namespaceTag('a', 'p1')).not.toBe(namespaceTag('b', 'p1'))
    expect(namespaceTag('a', 'p1')).not.toBe(namespaceTag('a', 'p2'))
    expect(namespaceTag('a', 'p1')).toHaveLength(32)
  })
})
