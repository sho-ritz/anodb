import { describe, expect, it } from 'vitest'
import { WRAP_KIND, defineSchema } from '../src/index.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { until } from './helpers/mock-relay.js'
import { open, relay, sleep } from './helpers/setup.js'

const schema = defineSchema({ todo: { title: 'text', done: 'boolean' } })
type DB = Awaited<ReturnType<typeof open<typeof schema>>>

/**
 * v0.2 has no pairing yet (v0.3), so tests give a second device of the same identity the
 * personal space key directly — exactly what pairing will deliver.
 */
async function secondDevice(a: DB, relays: Awaited<ReturnType<typeof relay>>[], extra = {}) {
  const ks = memoryKeyStore({ identity: a.exportIdentityKey().length ? hexIdentity(a) : '' })
  const b = await open(schema, relays, { keyStore: ks, ...extra })
  const ia = a as unknown as { keysBySpace: Map<string, Array<{ key: Uint8Array; num: number }>>; personal: string }
  const ib = b as unknown as {
    storeKey(s: string, k: Uint8Array, n: number): Promise<void>
    store: { upsertSpace(id: string, name: string, personal: boolean): void; setSpaceStatus(id: string, s: string): void }
    setPersonal(s: string): void
    sync: { refresh(): void } | null
  }
  const k = ia.keysBySpace.get(ia.personal)![0]!
  await ib.storeKey(ia.personal, k.key, k.num)
  ib.store.setSpaceStatus(b.personalSpace, 'left')
  ib.store.upsertSpace(ia.personal, 'personal', true)
  ib.setPersonal(ia.personal)
  ib.sync?.refresh()
  return b
}
function hexIdentity(a: DB): string {
  return (a as unknown as { identitySigner: { secretKey: Uint8Array } }).identitySigner.secretKey.reduce((s, x) => s + x.toString(16).padStart(2, '0'), '')
}
const titles = async (d: DB) => (await d.selectFrom('todo').select('title').orderBy('title').execute()).map((r) => r.title)

describe('sync (v0.2)', () => {
  it('replicates writes between two devices of one identity', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    const b = await secondDevice(a, [r])
    expect(b.pubkey).toBe(a.pubkey)
    expect(b.devicePubkey).not.toBe(a.devicePubkey)

    const [row] = await a.insertInto('todo').values({ title: 'from A' }).returning('id').execute()
    await until(async () => (await titles(b)).includes('from A'), 3000, 'B receives')
    await b.updateTable('todo').set({ done: true }).where('id', '=', row!.id).execute()
    await until(async () => (await a.selectFrom('todo').select('done').execute())[0]?.done === 1, 3000, 'A receives')
    await b.deleteFrom('todo').execute()
    await until(async () => (await titles(a)).length === 0, 3000, 'delete replicates')
  })

  it('hides authorship, tables and values from relays (envelopes with throwaway keys)', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    await a.insertInto('todo').values({ title: 'top secret plan' }).execute()
    await until(() => r.events.size >= 2)
    const all = JSON.stringify([...r.events.values()])
    for (const s of ['top secret', 'todo', 'test', a.pubkey, a.devicePubkey]) expect(all).not.toContain(s)
    const authors = new Set([...r.events.values()].map((e) => e.pubkey))
    expect(authors.size).toBe(r.events.size) // every envelope signed by a fresh key
    for (const e of r.events.values()) expect(e.kind).toBe(WRAP_KIND)
  })

  it("metadataProtection: 'none' signs envelopes with the device key", async () => {
    const r = await relay()
    const a = await open(schema, [r], { metadataProtection: 'none' })
    await a.insertInto('todo').values({ title: 'x' }).execute()
    await until(() => r.events.size >= 2)
    expect(new Set([...r.events.values()].map((e) => e.pubkey))).toEqual(new Set([a.devicePubkey]))
  })

  it('delivers offline writes after reconnect and re-signs stale envelopes', async () => {
    const r = await relay()
    let offset = 0
    const now = () => Date.now() + offset
    const a = await open(schema, [r], { now })
    const b = await secondDevice(a, [r], { now })
    await a.waitForSync()
    await b.waitForSync()
    await r.stop()
    await until(() => a.status.state === 'offline')
    await a.insertInto('todo').values({ title: 'offline write' }).execute()
    offset = 3 * 3600_000
    await r.start()
    await until(async () => (await titles(b)).includes('offline write'), 4000, 'late write arrives')
  })

  it('converges on concurrent conflicting writes (cell LWW)', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    const b = await secondDevice(a, [r])
    const [row] = await a.insertInto('todo').values({ title: 'base', done: false }).returning('id').execute()
    await until(async () => (await titles(b)).includes('base'))
    await r.stop()
    await a.updateTable('todo').set({ title: 'A' }).where('id', '=', row!.id).execute()
    await sleep(5)
    await b.updateTable('todo').set({ title: 'B', done: true }).where('id', '=', row!.id).execute()
    await r.start()
    const state = async (d: DB) => JSON.stringify(await d.selectFrom('todo').select(['title', 'done']).execute())
    await until(async () => (await state(a)) === (await state(b)) && a.status.pendingEvents + b.status.pendingEvents === 0, 4000)
    expect(JSON.parse(await state(a))).toEqual([{ title: 'B', done: 1 }])
  })

  it('applies writes that arrive before the op that authorizes them', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    await a.insertInto('todo').values({ title: 'early' }).execute()
    await until(() => a.status.pendingEvents === 0)
    // Re-order on the relay: drop the create op so B first sees only the write, then inject the op.
    const events = [...r.events.values()].sort((x, y) => x.created_at - y.created_at)
    const ops = events.slice(0, 1)
    for (const e of ops) r.events.delete(e.id)
    const b = await secondDevice(a, [r])
    await sleep(200)
    expect(await titles(b)).toEqual([])
    for (const e of ops) r.inject(e)
    await until(async () => (await titles(b)).includes('early'), 3000)
  })

  it('ignores envelopes from other keys and tampered messages', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    const mallory = await open(schema, [r])
    await mallory.insertInto('todo').values({ title: 'evil' }).execute()
    await until(() => mallory.status.pendingEvents === 0)
    const tampered = { ...[...r.events.values()][0]!, content: 'AAAA' }
    r.inject({ ...tampered, id: 'f'.repeat(64) })
    await sleep(150)
    expect(await titles(a)).toEqual([])
  })
})
