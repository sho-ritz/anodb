import { describe, expect, it } from 'vitest'
import { BlobError, defineSchema, isBlobRef } from '../src/index.js'
import { MockBlossom } from './helpers/mock-blossom.js'
import { onCleanup, open, pairedDevice, relay } from './helpers/setup.js'
import { until } from './helpers/mock-relay.js'

const schema = defineSchema({ notes: { text: 'text', photo: 'json' } })
async function blossom(opts?: ConstructorParameters<typeof MockBlossom>[0]) {
  const b = await new MockBlossom(opts).start()
  onCleanup(() => b.stop())
  return b
}
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251)

describe('encrypted blobs on Blossom', () => {
  it('encrypts, mirrors to several servers, and servers only see ciphertext', async () => {
    const s1 = await blossom()
    const s2 = await blossom()
    const db = await open(schema, [], { blobServers: [s1.url, s2.url] })
    const secret = new TextEncoder().encode('TOP SECRET PHOTO BYTES '.repeat(200))
    const ref = await db.blobs.put(secret, { type: 'image/png', name: 'cat.png' })
    expect(isBlobRef(ref)).toBe(true)
    expect(ref.servers.sort()).toEqual([s1.url, s2.url].sort())
    for (const s of [s1, s2]) {
      const stored = s.blobs.get(ref.sha256)!.data
      expect(stored.toString('latin1')).not.toContain('TOP SECRET')
      expect(stored.length).toBeGreaterThan(secret.length) // iv + tag
    }
    expect(s1.blobs.get(ref.sha256)!.owner).not.toBe(db.pubkey) // throwaway upload key
    expect(s1.blobs.get(ref.sha256)!.owner).not.toBe(db.devicePubkey)
    const got = await db.blobs.get(ref)
    expect(got).toMatchObject({ type: 'image/png', name: 'cat.png' })
    expect(Buffer.from(got.data).equals(Buffer.from(secret))).toBe(true)
  })

  it('stores the reference in a json column; another device downloads it through sync', async () => {
    const r = await relay()
    const s1 = await blossom()
    const a = await open(schema, [r], { blobServers: [s1.url] })
    const dev = await pairedDevice(a, schema, [r], { blobServers: [s1.url] })
    const ref = await a.blobs.put(bytes(100_000), { type: 'application/pdf' }) // far above the 44KB cell limit
    await a.insertInto('notes').values({ text: 'invoice', photo: ref }).execute()
    await until(async () => (await dev.db.selectFrom('notes').select('photo').execute()).length === 1, 4000)
    const [row] = await dev.db.selectFrom('notes').select('photo').execute()
    const got = await dev.db.blobs.get(row!.photo) // the json column's value, as read
    expect(Buffer.from(got.data).equals(Buffer.from(bytes(100_000)))).toBe(true)
  })

  it('rejects tampered content and falls back to another server', async () => {
    const bad = await blossom({ corrupt: true })
    const good = await blossom()
    const db = await open(schema, [], { blobServers: [bad.url, good.url] })
    const ref = await db.blobs.put(bytes(5000))
    expect(Buffer.from((await db.blobs.get(ref)).data).equals(Buffer.from(bytes(5000)))).toBe(true)
    const onlyBad = await open(schema, [], { blobServers: [bad.url] })
    await expect(onlyBad.blobs.get({ ...ref, servers: [bad.url] })).rejects.toThrow(/does not match its hash/)
  })

  it('tolerates a failing server, reports when none accept, and enforces minServers', async () => {
    const ok = await blossom()
    const refuses = await blossom({ rejectUploads: 413 })
    const db = await open(schema, [], { blobServers: [ok.url, refuses.url, 'http://127.0.0.1:1'] })
    const ref = await db.blobs.put(bytes(10))
    expect(ref.servers).toEqual([ok.url])
    await expect(db.blobs.put(bytes(10), { minServers: 2 })).rejects.toBeInstanceOf(BlobError)
    const err = await db.blobs.put(bytes(10), { servers: [refuses.url] }).catch((e: BlobError) => e)
    expect((err as BlobError).reports[0]).toMatchObject({ ok: false, status: 413, reason: 'policy' })
  })

  it('sends spec-compliant auth (base64url, server-scoped) and falls back to base64 for old servers', async () => {
    const legacy = await blossom({ legacyBase64: true })
    const modern = await blossom()
    const db = await open(schema, [], { blobServers: [modern.url, legacy.url] })
    const ref = await db.blobs.put(bytes(64))
    expect(ref.servers.sort()).toEqual([modern.url, legacy.url].sort())
    expect(modern.authFailures).toEqual([])
  })

  it('only the uploading device can delete', async () => {
    const s = await blossom()
    const a = await open(schema, [], { blobServers: [s.url] })
    const other = await open(schema, [], { blobServers: [s.url] })
    const ref = await a.blobs.put(bytes(32))
    expect((await other.blobs.delete(ref))[0]).toMatchObject({ ok: false, status: 403 })
    expect(s.blobs.has(ref.sha256)).toBe(true)
    expect((await a.blobs.delete(ref))[0]).toMatchObject({ ok: true })
    expect(s.blobs.has(ref.sha256)).toBe(false)
  })
})
