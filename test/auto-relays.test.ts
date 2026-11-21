import { describe, expect, it } from 'vitest'
import { WRAP_KIND, defineSchema } from '../src/index.js'
import { RELAY_CANDIDATES } from '../src/relay-candidates.js'
import { AUTO_RELAYS_PER_SEED, rankRelays } from '../src/relay-routing.js'
import { type MockRelay, until } from './helpers/mock-relay.js'
import { open, pairedDevice, relay } from './helpers/setup.js'

const schema = defineSchema({ todo: { title: 'text' } })

interface Internals {
  sync: { pool: { relays: string[] }; fixedRelays: readonly string[]; relaysFor(tag: string): string[] }
  keysBySpace: Map<string, Array<{ tag: string }>>
  personal: string
}
const internals = (db: unknown) => db as Internals
const currentTag = (db: unknown) => internals(db).keysBySpace.get(internals(db).personal)![0]!.tag
const wraps = (r: MockRelay) => [...r.events.values()].filter((e) => e.kind === WRAP_KIND)

async function relays(n: number) {
  return Promise.all(Array.from({ length: n }, () => relay()))
}

describe('automatic relay selection, migration phase 1 (DECISIONS 29/30)', () => {
  it('ranks candidates deterministically per seed', () => {
    const c = Array.from({ length: 30 }, (_, i) => `wss://r${i}.example`)
    expect(rankRelays('seed-a', c)).toEqual(rankRelays('seed-a', [...c].reverse()))
    expect(rankRelays('seed-a', c)).toHaveLength(30)
    expect(rankRelays('seed-a', c).slice(0, 5)).not.toEqual(rankRelays('seed-b', c).slice(0, 5))
  })

  it('bundles a versioned candidate list', () => {
    expect(RELAY_CANDIDATES.length).toBeGreaterThanOrEqual(20)
    expect(new Set(RELAY_CANDIDATES).size).toBe(RELAY_CANDIDATES.length)
  })

  it('stays on the fixed relays when the app passes `relays`', async () => {
    const f = await relay()
    const db = await open(schema, [f])
    expect(internals(db).sync.pool.relays).toEqual([f.url])
    await db.insertInto('todo').values({ title: 'x' }).execute()
    await until(() => wraps(f).length > 1, 3000, 'written')
    const inner = (db as unknown as { store: { driver: { all<T>(q: string): T[] } } }).store.driver.all<{ payload: string }>(
      'SELECT payload FROM anodb_messages',
    )
    expect(inner.every((m) => !('rp' in JSON.parse(m.payload)))).toBe(true)
  })

  it('writes to the fixed relays and to the picked ones, and marks messages rp: 1', async () => {
    const f = await relay()
    const cands = await relays(8)
    const db = await open(schema, [f], { autoRelays: true, relayCandidates: cands.map((r) => r.url) })
    const route = internals(db).sync.relaysFor(currentTag(db))
    expect(route[0]).toBe(f.url)
    expect(route).toHaveLength(1 + AUTO_RELAYS_PER_SEED)

    await db.insertInto('todo').values({ title: 'hello' }).execute()
    const picked = cands.filter((r) => route.includes(r.url))
    await until(() => [f, ...picked].every((r) => wraps(r).some((e) => e.tags[0]?.[1] === currentTag(db))), 3000, 'on every route relay')
    for (const r of cands.filter((r) => !route.includes(r.url))) expect(wraps(r).filter((e) => e.tags[0]?.[1] === currentTag(db))).toHaveLength(0)

    const payloads = (db as unknown as { store: { driver: { all<T>(q: string): T[] } } }).store.driver.all<{ payload: string }>(
      'SELECT payload FROM anodb_messages',
    )
    expect(payloads.length).toBeGreaterThan(0)
    expect(payloads.every((m) => JSON.parse(m.payload).rp === 1)).toBe(true)
  })

  it('keeps syncing through the picked relays when the fixed relay loses data', async () => {
    const f = await relay()
    const cands = await relays(8)
    const extra = { autoRelays: true, relayCandidates: cands.map((r) => r.url) }
    const a = await open(schema, [f], extra)
    const { db: b } = await pairedDevice(a, schema, [f], extra)
    expect(internals(b).sync.relaysFor(currentTag(b))).toEqual(internals(a).sync.relaysFor(currentTag(a)))

    f.opts.blackhole = true // accepts (OK true) but stores and forwards nothing
    await a.insertInto('todo').values({ title: 'via picked relays' }).execute()
    await until(async () => (await b.selectFrom('todo').select('title').execute()).some((r) => r.title === 'via picked relays'), 4000, 'B receives')
  })

  it('respects the connection budget', async () => {
    const f = await relay()
    const cands = await relays(12)
    const db = await open(schema, [f], { autoRelays: true, relayCandidates: cands.map((r) => r.url), maxAutoRelays: 5 })
    const pool = internals(db).sync.pool.relays
    expect(pool.length).toBeLessThanOrEqual(1 + 5)
    expect(pool).toContain(f.url)
  })
})
