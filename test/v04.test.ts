import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { WRAP_KIND, defineSchema, publicTable } from '../src/index.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { createQueryStore } from '../src/react.js'
import { until } from './helpers/mock-relay.js'
import { open, pairedDevice, relay, sleep } from './helpers/setup.js'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean' },
  posts: publicTable('note'),
  profiles: publicTable('profile'),
  follows: publicTable('follows'),
  reactions: publicTable('reaction'),
  articles: publicTable('longForm'),
})
type DB = Awaited<ReturnType<typeof open<typeof schema>>>
const titles = async (d: DB) => (await d.selectFrom('todo').select('title').orderBy('title').execute()).map((r) => r.title)

async function sibling(a: DB, relays: Awaited<ReturnType<typeof relay>>[]) {
  return (await pairedDevice(a, schema, relays)).db
}

describe('NIP-77 sync (v0.4)', () => {
  it('recovers messages that time-based paging cannot reach (one second over the relay limit)', async () => {
    for (const neg of [false, true]) {
      const r = await relay({ maxLimit: 3, negentropy: neg })
      const a = await open(schema, [r])
      const dev = await pairedDevice(a, schema, [r])
      await until(() => dev.db.status.state === 'synced', 4000)
      await dev.db.close()
      for (let i = 0; i < 10; i++) await a.insertInto('todo').values({ title: `s${i}` }).execute() // all within ~1 second
      await until(() => a.status.pendingEvents === 0, 4000)
      const b = await dev.reopen()
      await until(() => b.status.state === 'synced', 4000)
      const count = async () => (await titles(b)).filter((t) => t?.startsWith('s')).length
      if (neg) await until(async () => (await count()) === 10, 4000, 'NIP-77 recovers all')
      else {
        // NIP-01 cannot page inside one second, so this relay alone cannot deliver everything —
        // but the loss is no longer silent: sequence numbers expose it (layer 3).
        await until(() => b.syncHealth().gaps.length > 0, 4000, 'gap detected')
        expect(await count()).toBeLessThan(10)
      }
    }
  })

  it('re-uploads envelopes a NIP-77 relay lost', async () => {
    const r = await relay({ negentropy: true })
    const a = await open(schema, [r])
    for (let i = 0; i < 5; i++) await a.insertInto('todo').values({ title: `x${i}` }).execute()
    await until(() => a.status.pendingEvents === 0)
    const lost = [...r.events.values()].filter((e) => e.kind === WRAP_KIND).slice(0, 4)
    for (const e of lost) r.events.delete(e.id)
    expect(await a.reconcile(r.url)).toBe(true)
    await until(() => lost.every((e) => r.events.has(e.id)), 3000, 're-upload')
  })

  it('falls back to time-based sync on relays without NIP-77', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    const b = await sibling(a, [r])
    await until(() => b.status.state === 'synced', 4000)
    await a.insertInto('todo').values({ title: 'plain' }).execute()
    await until(async () => (await titles(b)).includes('plain'))
    expect(a.syncHealth().nip77[r.url]).toBe(false)
  })

  it('detects sequence gaps and repairs them', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    const dev = await pairedDevice(a, schema, [r])
    await until(() => dev.db.status.state === 'synced', 4000)
    await dev.db.close()
    const before = new Set(r.events.keys())
    for (const t of ['g1', 'g2', 'g3']) {
      await a.insertInto('todo').values({ title: t }).execute()
      await until(() => a.status.pendingEvents === 0)
    }
    const fresh = [...r.events.values()].filter((e) => !before.has(e.id))
    // remove the envelope carrying g2 (the middle sequence number) before B comes back
    const dropped = fresh.sort((x, y) => x.created_at - y.created_at || 0)[1]!
    r.events.delete(dropped.id)
    const b = await dev.reopen()
    await until(() => b.status.state === 'synced', 4000)
    await until(async () => (await titles(b)).filter((t) => t?.startsWith('g')).length === 2, 3000)
    const gaps = b.syncHealth().gaps
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.missing).toHaveLength(1)
    r.inject(dropped)
    await b.repair()
    expect(b.syncHealth().gaps).toEqual([])
    expect((await titles(b)).filter((t) => t?.startsWith('g'))).toHaveLength(3)
  })

  it('pruneOldEvents asks relays to delete envelopes superseded by a snapshot', async () => {
    const r = await relay()
    const a = await open(schema, [r], { pruneOldEvents: true })
    await a.insertInto('todo').values({ title: 'old' }).execute()
    await until(() => a.status.pendingEvents === 0)
    const old = [...r.events.values()].filter((e) => e.kind === WRAP_KIND)
    await sleep(1100)
    ;(a as unknown as { snapshot(s: string): void }).snapshot(a.personalSpace)
    await until(() => a.status.pendingEvents === 0)
    const deletions = r.received.filter((e) => e.kind === 5)
    for (const e of old) expect(deletions.some((d) => d.pubkey === e.pubkey && d.tags.some((t) => t[0] === 'e' && t[1] === e.id))).toBe(true)
  })
})

describe('public tables (v0.4)', () => {
  it('insert publishes standard events; another user syncs and JOINs them', async () => {
    const r = await relay()
    const alice = await open(schema, [r])
    await alice.insertInto('profiles').values({ name: 'alice', about: 'hi' }).execute()
    await alice.insertInto('posts').values({ content: 'hello nostr', tags: [['t', 'anodb']] }).execute()
    await until(() => alice.status.pendingEvents === 0)
    const kinds = [...r.events.values()].filter((e) => e.pubkey === alice.pubkey).map((e) => e.kind).sort()
    expect(kinds).toEqual([0, 1])

    const viewer = await open(schema, [r])
    await viewer.syncPublic('profiles', { authors: [alice.pubkey] })
    await viewer.syncPublic('posts', { authors: [alice.pubkey] })
    const rows = await viewer
      .selectFrom('posts')
      .innerJoin('profiles', 'profiles.author', 'posts.author')
      .select(['posts.content', 'profiles.name'])
      .execute()
    expect(rows).toEqual([{ content: 'hello nostr', name: 'alice' }])
  })

  it('reads events from any Nostr client and keeps the newest replaceable version', async () => {
    const r = await relay()
    const other = generateSecretKey()
    const ts = Math.floor(Date.now() / 1000)
    r.inject(finalizeEvent({ kind: 0, created_at: ts - 10, tags: [], content: '{"name":"old"}' }, other))
    r.inject(finalizeEvent({ kind: 0, created_at: ts, tags: [], content: '{"name":"new","display_name":"N"}' }, other))
    r.inject(finalizeEvent({ kind: 1, created_at: ts, tags: [], content: 'from another client' }, other))
    const d = await open(schema, [r])
    await d.syncPublic('profiles', {})
    await d.syncPublic('posts', {})
    expect(await d.selectFrom('profiles').select(['name', 'displayName']).execute()).toEqual([{ name: 'new', displayName: 'N' }])
    expect((await d.selectFrom('posts').select('content').execute()).map((x) => x.content)).toEqual(['from another client'])
  })

  it('follows / reactions / articles map to kind 3 / 7 / 30023; edits and deletes follow Nostr rules', async () => {
    const r = await relay()
    const d = await open(schema, [r])
    const t1 = 'a'.repeat(64)
    const t2 = 'b'.repeat(64)
    await d.insertInto('follows').values({ target: t1 }).execute()
    await d.insertInto('follows').values({ target: t2, petname: 'bob' }).execute()
    await d.deleteFrom('follows').where('target', '=', t1).execute()
    await until(() => d.status.pendingEvents === 0)
    const lists = [...r.events.values()].filter((e) => e.kind === 3)
    expect(lists).toHaveLength(1) // replaceable: the relay keeps the newest only
    expect(lists[0]!.tags).toEqual([['p', t2, '', 'bob']])
    expect(await d.selectFrom('follows').select('target').execute()).toEqual([{ target: t2 }])

    const [post] = await d.insertInto('posts').values({ content: 'x' }).returning('id').execute()
    const postId = (await d.selectFrom('posts').select('id').execute())[0]!.id
    void post
    await d.insertInto('reactions').values({ content: '+', eventId: postId, eventAuthor: d.pubkey }).execute()
    await expect(d.updateTable('posts').set({ content: 'edited' }).where('id', '=', postId).execute()).rejects.toThrow(/cannot be edited/)
    await d.deleteFrom('posts').where('id', '=', postId).execute()
    await d.insertInto('articles').values({ d: 'intro', title: 'Intro', content: '# hi' }).execute()
    await d.updateTable('articles').set({ title: 'Intro v2' }).where('d', '=', 'intro').execute()
    await until(() => d.status.pendingEvents === 0)
    const evs = [...r.events.values()]
    expect(evs.some((e) => e.kind === 7 && e.tags.some((t) => t[0] === 'e' && t[1] === postId))).toBe(true)
    expect(evs.some((e) => e.kind === 5 && e.tags.some((t) => t[0] === 'e' && t[1] === postId))).toBe(true)
    expect(await d.selectFrom('posts').selectAll().execute()).toEqual([])
    expect(await d.selectFrom('articles').select(['id', 'title']).execute()).toEqual([{ id: `${d.pubkey}:intro`, title: 'Intro v2' }])
  })

  it('live public sync and the identity requirement', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    const viewer = await open(schema, [r])
    const { stop } = await viewer.syncPublic('posts', { authors: [a.pubkey] }, { live: true })
    await a.insertInto('posts').values({ content: 'live!' }).execute()
    await until(async () => (await viewer.selectFrom('posts').select('content').execute()).length === 1, 3000, 'live post')
    stop()
    const rec = await open(schema, [r], { identity: 'recovery', onRecoveryKey: () => {} })
    await expect(rec.insertInto('posts').values({ content: 'x' }).execute()).rejects.toThrow(/identity key is not on this device/)
  })
})

describe('react store', () => {
  it('createQueryStore follows a live query', async () => {
    const d = await open(schema, [])
    const store = createQueryStore(d, d.selectFrom('todo').select('title'))
    const seen: unknown[] = []
    const unsub = store.subscribe(() => seen.push(store.getSnapshot()))
    await sleep(10)
    await d.insertInto('todo').values({ title: 'x' }).execute()
    await sleep(10)
    unsub()
    expect(seen).toEqual([[], [{ title: 'x' }]])
  })
})
