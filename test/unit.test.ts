import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, inboxTag, keyId, parseSecretKey, randomBytes, spaceTag } from '../src/crypto.js'
import { Clock, decodeHlc, encodeHlc } from '../src/hlc.js'
import { createDelegation, createRevocation, verifyDelegation, verifyRevocation } from '../src/identity.js'
import { envKeyStore } from '../src/keystore/env.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { type Change, parseStreamPayload, splitChanges } from '../src/protocol.js'
import { defineSchema } from '../src/schema.js'
import { localSigner } from '../src/signer.js'

const NODE_A = 'aaaaaaaaaaaaaaaa'
const NODE_B = 'bbbbbbbbbbbbbbbb'

describe('HLC', () => {
  it('round-trips and sorts lexicographically', () => {
    const t = { millis: 1_762_000_000_000, counter: 7, node: NODE_A }
    expect(decodeHlc(encodeHlc(t))).toEqual(t)
    const a = encodeHlc({ millis: 1000, counter: 99, node: NODE_B })
    const b = encodeHlc({ millis: 1001, counter: 0, node: NODE_A })
    expect([b, a].sort()).toEqual([a, b])
  })

  it('is monotonic when the wall clock goes back, and orders after received stamps', () => {
    let wall = 5000
    const clock = new Clock(NODE_A, undefined, () => wall)
    const seen = [clock.tick(), clock.tick()]
    wall = 4000
    seen.push(clock.tick())
    expect([...seen].sort()).toEqual(seen)
    const remote = encodeHlc({ millis: 9000, counter: 3, node: NODE_B })
    clock.receive(remote)
    expect(clock.tick() > remote).toBe(true)
  })
})

describe('protocol v2', () => {
  const hlc = (i: number) => encodeHlc({ millis: 1, counter: i, node: NODE_A })
  const ch = (i: number, v: unknown = 'x'): Change => ['todo', `r${i}`, 'title', v, hlc(i)]
  const header = async () => {
    const id = localSigner(generateSecretKey())
    const dev = getPublicKey(generateSecretKey())
    return { v: 2, sp: 'a'.repeat(32), ep: 'b'.repeat(16), seq: 1, dlg: await createDelegation(id, dev, 'd', Date.now()) }
  }

  it('parses valid payloads and rejects malformed ones', async () => {
    const h = await header()
    expect(parseStreamPayload(JSON.stringify({ ...h, t: 'ch', c: [ch(1)] }))?.t).toBe('ch')
    expect(parseStreamPayload(JSON.stringify({ ...h, v: 1, t: 'ch', c: [] }))).toBeNull()
    expect(parseStreamPayload(JSON.stringify({ ...h, seq: 0, t: 'ch', c: [] }))).toBeNull()
    expect(parseStreamPayload(JSON.stringify({ ...h, t: 'ch', c: [['todo', 'r', 'x', 1, 'bad']] }))).toBeNull()
    expect(parseStreamPayload(JSON.stringify({ ...h, t: 'zz' }))).toBeNull()
    expect(parseStreamPayload(JSON.stringify({ ...h, dlg: { nope: 1 }, t: 'ch', c: [] }))).toBeNull()
  })

  it('splits large change sets', () => {
    const big = Array.from({ length: 200 }, (_, i) => ch(i, 'y'.repeat(500)))
    const parts = splitChanges(big, 20_000)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.flat()).toEqual(big)
    expect(() => splitChanges([ch(0, 'z'.repeat(30_000))], 20_000)).toThrow(/exceeds/)
  })
})

describe('identity', () => {
  it('verifies delegations and revocations', async () => {
    const id = localSigner(generateSecretKey())
    const dev = getPublicKey(generateSecretKey())
    const d = await createDelegation(id, dev, 'phone', Date.now())
    expect(verifyDelegation(d, dev)).toBe(await id.getPublicKey())
    expect(verifyDelegation(d, getPublicKey(generateSecretKey()))).toBeNull()
    expect(verifyDelegation({ ...d, content: 'tampered' }, dev)).toBeNull()
    const r = await createRevocation(id, dev, Date.now())
    expect(verifyRevocation(r)).toEqual({ identity: await id.getPublicKey(), device: dev })
  })

  it('derives distinct routing tags and key ids', () => {
    const k1 = randomBytes(32)
    const k2 = randomBytes(32)
    expect(spaceTag(k1)).not.toBe(spaceTag(k2))
    expect(spaceTag(k1)).toHaveLength(32)
    expect(keyId(k1)).toHaveLength(16)
    expect(inboxTag('a'.repeat(64))).not.toBe(spaceTag(k1))
  })
})

describe('key stores', () => {
  it('memory store seals and opens', async () => {
    const ks = memoryKeyStore()
    await ks.set('device', 'abc')
    expect(await ks.get('device')).toBe('abc')
    const sealed = await ks.seal(new Uint8Array([1, 2, 3]))
    expect([...(await ks.open(sealed))]).toEqual([1, 2, 3])
    await expect(memoryKeyStore().open(sealed)).rejects.toThrow()
  })

  it('env store is read-only, needs both variables and accepts base64 delegations', async () => {
    expect(() => envKeyStore({})).toThrow(/npx @anodb\/cli init/)
    const sk = generateSecretKey()
    const dlg = JSON.stringify(await createDelegation(localSigner(generateSecretKey()), getPublicKey(sk), 'srv', Date.now()))
    const ks = envKeyStore({ ANODB_DEVICE_KEY: Buffer.from(sk).toString('hex'), ANODB_DELEGATION: btoa(dlg) })
    expect(await ks.get('delegation')).toBe(dlg)
    expect(parseSecretKey((await ks.get('device'))!)).toEqual(sk)
    await expect(ks.set('identity', 'x')).rejects.toThrow(/read-only/)
  })
})

describe('schema', () => {
  it('rejects reserved or invalid names', () => {
    expect(() => defineSchema({ todo: { id: 'text' } })).toThrow(/reserved/)
    expect(() => defineSchema({ todo: { space: 'text' } })).toThrow(/reserved/)
    expect(() => defineSchema({ anodb_x: { a: 'text' } })).toThrow(/reserved/)
    expect(() => defineSchema({ 'bad name': { a: 'text' } })).toThrow(/invalid/)
  })
})
