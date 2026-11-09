import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { type AnoDBOptions, CHANGE_KIND, createAnoDB, defineSchema } from '../src/index.js'
import { nodeSqlite } from '../src/node.js'
import { MockRelay, until } from './helpers/mock-relay.js'

const schema = defineSchema({ todo: { title: 'text', done: 'boolean' } })
type S = typeof schema

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function relay(opts?: ConstructorParameters<typeof MockRelay>[0]) {
  const r = await new MockRelay(opts).start()
  cleanup.push(() => r.stop())
  return r
}

function device(relays: MockRelay[], extra: Partial<AnoDBOptions<S>> = {}) {
  const db = createAnoDB({
    appId: 'sync-test',
    schema,
    driver: nodeSqlite(':memory:'),
    relays: relays.map((r) => r.url),
    discoveryRelays: [],
    relayOptions: { reconnectMinMs: 30, reconnectMaxMs: 100, publishTimeoutMs: 500 },
    retryIntervalMs: 100,
    ...extra,
  })
  cleanup.push(() => db.close())
  return db
}

describe('multi-device sync', () => {
  it('replicates writes between devices sharing an owner key, in real time', async () => {
    const r = await relay()
    const a = device([r])
    const b = device([r], { secretKey: a.exportSecretKey() })
    await a.waitForSync()
    await b.waitForSync()

    const id = a.table('todo').insert({ title: 'from A', done: false })
    await until(() => b.table('todo').findById(id)?.title === 'from A', 3000, 'B to receive')
    b.table('todo').update(id, { done: true })
    await until(() => a.table('todo').findById(id)?.done === true, 3000, 'A to receive')
    b.table('todo').delete(id)
    await until(() => a.table('todo').count() === 0, 3000, 'delete to replicate')
    expect((await a.waitForSync()).state).toBe('synced')
  })

  it('stores only encrypted, namespaced events on the relay', async () => {
    const r = await relay()
    const a = device([r])
    a.table('todo').insert({ title: 'top secret plan' })
    await until(() => r.events.size === 1)
    const [e] = [...r.events.values()]
    expect(e!.kind).toBe(CHANGE_KIND)
    expect(e!.pubkey).toBe(a.pubkey)
    expect(JSON.stringify(e)).not.toContain('top secret')
    expect(JSON.stringify(e)).not.toContain('todo')
    expect(JSON.stringify(e)).not.toContain('sync-test')
  })

  it('queues offline writes in the outbox and delivers them after reconnect', async () => {
    const r = await relay()
    const url = r.url
    await r.stop()
    const a = device([r])
    const id = a.table('todo').insert({ title: 'written offline' })
    expect(a.status).toMatchObject({ state: 'offline', pendingEvents: 1 })

    await r.start()
    expect(r.url).toBe(url)
    await until(() => a.status.pendingEvents === 0, 3000, 'outbox flush')
    const b = device([r], { secretKey: a.exportSecretKey() })
    await until(() => b.table('todo').findById(id)?.title === 'written offline', 3000, 'B catch-up')
  })

  it('re-signs stale outbox events so other devices with a since-cursor still see them', async () => {
    const r = await relay()
    let offset = 0
    const now = () => Date.now() + offset
    const a = device([r], { now })
    const b = device([r], { secretKey: a.exportSecretKey(), now })
    await a.waitForSync()
    await b.waitForSync()
    a.table('todo').insert({ title: 'warm-up' })
    await until(() => b.table('todo').count() === 1)

    await r.stop()
    const id = a.table('todo').insert({ title: 'old offline write' })
    const queuedAt = Math.floor(now() / 1000)
    offset = 3 * 3600_000 // three hours pass before the network comes back
    await r.start()
    await until(() => b.table('todo').findById(id) !== undefined, 4000, 'B to get the late write')
    const stored = [...r.events.values()].filter((e) => e.created_at > queuedAt + 3600)
    expect(stored).toHaveLength(1)
  })

  it('converges deterministically on concurrent conflicting writes (cell-level LWW)', async () => {
    const r = await relay()
    const a = device([r])
    const b = device([r], { secretKey: a.exportSecretKey() })
    const id = a.table('todo').insert({ title: 'base', done: false })
    await until(() => b.table('todo').findById(id) !== undefined)

    await r.stop()
    a.table('todo').update(id, { title: 'A title' })
    b.table('todo').update(id, { title: 'B title', done: true })
    await r.start()
    await until(
      () => a.table('todo').findById(id)?.title === b.table('todo').findById(id)?.title && a.status.pendingEvents + b.status.pendingEvents === 0,
      4000,
      'convergence',
    )
    await until(() => a.table('todo').findById(id)?.done === true, 4000)
    const ra = a.table('todo').findById(id)!
    const rb = b.table('todo').findById(id)!
    expect({ title: ra.title, done: ra.done }).toEqual({ title: rb.title, done: rb.done })
    // B's later write wins `title`; `done` was only changed by B and is merged independently.
    expect(ra.title).toBe('B title')
  })

  it('pages through relays that cap REQ results', async () => {
    const r = await relay({ maxLimit: 5 })
    let offset = -3600_000
    const a = device([r], { now: () => Date.now() + offset })
    for (let i = 0; i < 23; i++) {
      a.table('todo').insert({ title: `t${i}` })
      offset += 1000 // one write per second so `until` paging is exercised
    }
    await until(() => a.status.pendingEvents === 0, 4000)
    const b = device([r], { secretKey: a.exportSecretKey() })
    await until(() => b.table('todo').count() === 23, 4000, 'full backfill')
    expect((await b.waitForSync()).state).toBe('synced')
  })

  it('does not get stuck when one second saturates the relay limit', async () => {
    const r = await relay({ maxLimit: 5 })
    let offset = -3600_000
    const a = device([r], { now: () => Date.now() + offset })
    for (let i = 0; i < 3; i++) a.table('todo').insert({ title: `old${i}` })
    offset += 5000
    for (let i = 0; i < 8; i++) a.table('todo').insert({ title: `burst${i}` }) // 8 events in one second
    offset += 5000
    a.table('todo').insert({ title: 'newest' })
    await until(() => a.status.pendingEvents === 0, 4000)
    const b = device([r], { secretKey: a.exportSecretKey() })
    await until(() => b.status.state === 'synced', 4000)
    const titles = b.table('todo').findMany().map((t) => t.title)
    // Older seconds are still reached; up to (8 - limit) events of the saturated second may be missed.
    expect(titles).toEqual(expect.arrayContaining(['newest', 'old0', 'old1', 'old2']))
  })

  it('survives a relay that loses data by using a second relay', async () => {
    const lossy = await relay({ blackhole: true })
    const good = await relay()
    const a = device([lossy, good])
    const id = a.table('todo').insert({ title: 'redundant' })
    await until(() => a.status.pendingEvents === 0)
    const b = device([lossy, good], { secretKey: a.exportSecretKey() })
    await until(() => b.table('todo').findById(id) !== undefined)
  })

  it('keeps events in the outbox until minAcks relays accept them', async () => {
    const r1 = await relay()
    const r2 = await relay({ reject: () => 'blocked: not today' })
    const a = device([r1, r2], { minAcks: 2 })
    const errors: string[] = []
    a.onError((e) => errors.push(e.code))
    a.table('todo').insert({ title: 'needs two' })
    await until(() => r1.events.size === 1 && r2.received.length >= 1)
    await new Promise((res) => setTimeout(res, 150))
    // one OK + one rejection from all relays → best-effort dequeue
    expect(a.status.pendingEvents).toBe(0)

    const r3 = await relay({ reject: () => 'blocked: no' })
    const c = device([r3])
    c.onError((e) => errors.push(e.code))
    c.table('todo').insert({ title: 'nobody wants this' })
    await until(() => errors.includes('publish-rejected'))
    expect(c.status.pendingEvents).toBe(1)
  })

  it('ignores forged and foreign events', async () => {
    const r = await relay()
    const a = device([r])
    const other = device([r], { appId: 'another-app', secretKey: a.exportSecretKey() })
    other.table('todo').insert({ title: 'other app' })
    await until(() => r.events.size === 1)

    const mallory = generateSecretKey()
    const ns = r.events.values().next().value!.tags[0]!
    r.inject(
      finalizeEvent({ kind: CHANGE_KIND, created_at: Math.floor(Date.now() / 1000), tags: [ns], content: 'garbage' }, mallory),
    )
    const tampered = { ...r.events.values().next().value!, content: 'tampered' }
    r.inject({ ...tampered, id: 'f'.repeat(64) })
    await new Promise((res) => setTimeout(res, 200))
    expect(a.table('todo').count()).toBe(0)
    expect(getPublicKey(mallory)).not.toBe(a.pubkey)
  })

  it('reports status transitions', async () => {
    const r = await relay()
    const a = device([r])
    const states: string[] = []
    a.onStatus((s) => states.push(s.state))
    await a.waitForSync()
    await r.stop()
    await until(() => a.status.state === 'offline')
    expect(states[0]).toBe('offline')
    expect(states).toContain('synced')
    expect(states.at(-1)).toBe('offline')
  })
})

describe('public Nostr data', () => {
  it('fetches a profile via the author NIP-65 relay list and serves it from cache offline', async () => {
    const home = await relay()
    const authorRelay = await relay()
    const alice = device([authorRelay])
    alice.nostr.publishRelayList({ read: [authorRelay.url], write: [authorRelay.url] })
    alice.nostr.publishProfile({ name: 'alice', about: 'hi' })
    await until(() => alice.status.pendingEvents === 0)
    // Only the relay list is known to the viewer's relay (as with a discovery relay like purplepag.es).
    home.inject([...authorRelay.events.values()].find((e) => e.kind === 10002)!)

    const viewer = device([home])
    const res = await viewer.nostr.getProfile(alice.pubkey, { timeoutMs: 1000 })
    expect(res.status).toBe('synced')
    expect(res.value).toMatchObject({ name: 'alice' })
    expect(viewer.nostr.cachedProfile(alice.pubkey)?.name).toBe('alice')

    await home.stop()
    await authorRelay.stop()
    const offline = await viewer.nostr.getProfile(alice.pubkey, { maxAgeMs: 0, timeoutMs: 300 })
    expect(offline).toMatchObject({ status: 'stale', value: { name: 'alice' } })
    const unknown = await viewer.nostr.getProfile(getPublicKey(generateSecretKey()), { timeoutMs: 300 })
    expect(unknown.status).toBe('unavailable')
  })

  it('publishes standard kind 1 notes readable by any client', async () => {
    const r = await relay()
    const a = device([r])
    a.nostr.publishNote('hello nostr', [['t', 'anodb']])
    await until(() => a.status.pendingEvents === 0)
    const viewer = device([r])
    const notes = await viewer.nostr.getNotes(a.pubkey, { timeoutMs: 500 })
    expect(notes.map((n) => n.content)).toEqual(['hello nostr'])
  })
})
