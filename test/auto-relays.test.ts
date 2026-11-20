import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AnoDBOptions, WRAP_KIND, createAnoDB, defineSchema } from '../src/index.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { nodeSqlite } from '../src/node.js'
import { RELAY_CANDIDATES } from '../src/relay-candidates.js'
import { AUTO_RELAYS_PER_SEED, candidateListId, rankRelays } from '../src/relay-routing.js'
import { RELAY_CANDIDATE_VERSIONS } from '../src/relay-candidates.js'
import { type MockRelay, until } from './helpers/mock-relay.js'
import { onCleanup, open, relay } from './helpers/setup.js'

const schema = defineSchema({ todo: { title: 'text' } })
type DB = Awaited<ReturnType<typeof createAnoDB<typeof schema>>>

interface Internals {
  sync: {
    pool: { relays: string[]; connected(): string[]; isDown(r: string): boolean }
    relaysFor(tag: string): string[]
    router: { planned(): ReadonlyMap<string, { ranks: readonly string[]; fixed: readonly string[]; live: boolean; route: { primary: boolean } }> }
  }
  keysBySpace: Map<string, Array<{ tag: string; relays?: readonly string[] | null }>>
  personal: string
  store: { outboxSize(): number; driver: { all<T>(q: string): T[] } }
  subscriptionTags(): string[]
  rotateKey(space: string): Promise<void>
}
const I = (db: unknown) => db as Internals
const current = (db: unknown) => I(db).keysBySpace.get(I(db).personal)![0]!
const wrapsWith = (r: MockRelay, tag: string) => [...r.events.values()].filter((e) => e.kind === WRAP_KIND && e.tags.some((t) => t[0] === 'n' && t[1] === tag))
const allWraps = (r: MockRelay) => [...r.events.values()].filter((e) => e.kind === WRAP_KIND)
const titles = async (d: DB) => (await d.selectFrom('todo').select('title').execute()).map((r) => r.title)

async function relays(n: number) {
  return Promise.all(Array.from({ length: n }, () => relay()))
}

/** A device backed by a file, so it can be reopened with other options (e.g. after an app update). */
function device() {
  const file = join(mkdtempSync(join(tmpdir(), 'anodb-auto-')), 'db.sqlite')
  const keyStore = memoryKeyStore()
  return async (opts: Partial<AnoDBOptions<typeof schema>>) => {
    const db = await createAnoDB({
      appId: 'test',
      schema,
      driver: nodeSqlite(file),
      keyStore,
      relayOptions: { reconnectMinMs: 30, reconnectMaxMs: 100, publishTimeoutMs: 500, connectTimeoutMs: 500 },
      retryIntervalMs: 100,
      ...opts,
    })
    onCleanup(() => db.close())
    return db
  }
}

/** Pair a new device (opened with `opts`) to `a`; returns it reopened. */
async function pair(a: DB, opts: Partial<AnoDBOptions<typeof schema>>) {
  const mk = device()
  const fresh = await mk(opts)
  const offer = await fresh.startPairing()
  await a.parsePairing(offer.uri).approve('b')
  await offer.done
  await fresh.close()
  return { db: await mk(opts), mk }
}

async function setup(n = 8, extra: Partial<AnoDBOptions<typeof schema>> = {}) {
  const f = await relay()
  const cands = await relays(n)
  const fresh = { relays: [f.url], autoRelays: true, relayCandidates: cands.map((r) => r.url), ...extra }
  const older = { relays: [f.url] } // no automatic selection, no `rp`: behaves like versions before 0.12
  return { f, cands, fresh, older }
}

describe('relay routing', () => {
  it('ranks candidates deterministically per seed', () => {
    const c = Array.from({ length: 30 }, (_, i) => `wss://r${i}.example`)
    expect(rankRelays('seed-a', c)).toEqual(rankRelays('seed-a', [...c].reverse()))
    expect(rankRelays('seed-a', c).slice(0, 5)).not.toEqual(rankRelays('seed-b', c).slice(0, 5))
  })

  it('names candidate lists: bundled version number, or a hash for custom lists', () => {
    expect(RELAY_CANDIDATES.length).toBeGreaterThanOrEqual(100)
    expect(candidateListId(RELAY_CANDIDATES, RELAY_CANDIDATE_VERSIONS)).toBe(1)
    expect(candidateListId([...RELAY_CANDIDATES].reverse(), RELAY_CANDIDATE_VERSIONS)).toBe(1)
    expect(candidateListId(['wss://a.example', 'wss://b.example'], RELAY_CANDIDATE_VERSIONS)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('stays on the fixed relays when the app passes `relays`', async () => {
    const f = await relay()
    const db = await open(schema, [f])
    expect(I(db).sync.pool.relays).toEqual([f.url])
    expect(current(db).relays ?? null).toBeNull()
    await db.insertInto('todo').values({ title: 'x' }).execute()
    await until(() => allWraps(f).length > 1, 3000, 'written')
    const payloads = I(db).store.driver.all<{ payload: string }>('SELECT payload FROM anodb_messages')
    expect(payloads.every((m) => !('rp' in JSON.parse(m.payload)))).toBe(true)
  })
})

describe('migration (DECISIONS 30)', { timeout: 20_000 }, () => {
  it('phase 2: a space whose devices all read picked relays lives on them only', async () => {
    const { f, fresh } = await setup()
    const a = await device()(fresh)
    expect(current(a).relays?.length).toBeGreaterThan(0) // a new space starts on picked relays
    const { db: b } = await pair(a, fresh)
    expect(current(b).tag).toBe(current(a).tag)
    expect(current(b).relays).toEqual(current(a).relays)

    await a.insertInto('todo').values({ title: 'from A' }).execute()
    await until(async () => (await titles(b)).includes('from A'), 5000, 'B receives')
    await b.insertInto('todo').values({ title: 'from B' }).execute()
    await until(async () => (await titles(a)).includes('from B'), 5000, 'A receives')

    // The space's envelopes never reached the fixed relay (inboxes and pairing still use it).
    expect(wrapsWith(f, current(a).tag)).toHaveLength(0)
    expect(I(a).sync.relaysFor(current(a).tag)).not.toContain(f.url)
  })

  it('phase 3 end state (fixedInbox: false): devices that all read picked relays never touch the fixed relay', async () => {
    const { f, fresh } = await setup(8, { fixedInbox: false })
    const a = await device()(fresh)
    const { db: b } = await pair(a, fresh)
    await a.insertInto('todo').values({ title: 'from A' }).execute()
    await until(async () => (await titles(b)).includes('from A'), 5000, 'B receives')
    await I(a).rotateKey(I(a).personal) // key delivery to B's inbox
    await until(() => current(b).tag === current(a).tag, 5000, 'B gets the key on its picked relays')
    // Spaces, inbox and the pairing link all went to picked relays only.
    expect(allWraps(f)).toHaveLength(0)
    expect(I(a).sync.pool.relays).not.toContain(f.url)
  })

  it('by default the inbox is still read on the fixed relays (invitations from older versions)', async () => {
    const { f, fresh, older } = await setup()
    const a = await device()(fresh)
    expect(I(a).sync.pool.relays).toContain(f.url)
    const c = await device()(older)
    const space = await c.createSpace('old team')
    await c.addMember(space, a.npub, 'writer', { devices: a.deviceDelegations() })
    await until(() => a.invitations().some((i) => i.space === space), 5000, 'invitation from an older version arrives')
  })

  it('phase 1: a space with a device that cannot follow stays on the fixed relays (+ picked copies)', async () => {
    const { f, cands, fresh, older } = await setup()
    const a = await device()(fresh)
    const { db: b } = await pair(a, older)
    // Pairing a device without `rp` switches the personal space back to the fixed relays.
    await until(() => (current(a).relays ?? null) === null, 5000, 'A back on fixed relays')
    await until(() => current(b).tag === current(a).tag, 5000, 'B got the new epoch')

    await a.insertInto('todo').values({ title: 'from A' }).execute()
    await until(async () => (await titles(b)).includes('from A'), 5000, 'old device receives')
    await b.insertInto('todo').values({ title: 'from B' }).execute()
    await until(async () => (await titles(a)).includes('from B'), 5000, 'new device receives')

    const tag = current(a).tag
    const picked = cands.filter((r) => I(a).sync.relaysFor(tag).includes(r.url))
    expect(picked).toHaveLength(AUTO_RELAYS_PER_SEED)
    expect(wrapsWith(f, tag).length).toBeGreaterThan(0)
    await until(() => picked.every((r) => wrapsWith(r, tag).length > 0), 3000, 'extra copies on picked relays')
  })

  it('phase 2: the space switches automatically once every device reads picked relays', async () => {
    const { f, fresh, older } = await setup()
    const a = await device()(fresh)
    const { db: b0, mk } = await pair(a, older)
    await until(() => (current(a).relays ?? null) === null, 5000, 'fixed while B is old')
    await until(() => current(b0).tag === current(a).tag, 5000, 'B on the fixed epoch')
    const fixedTag = current(a).tag

    // B updates the app: it now announces `rp` with its next write, and A switches the space.
    await b0.close()
    const b = await mk(fresh)
    await b.insertInto('todo').values({ title: 'after update' }).execute()
    await until(() => (current(a).relays?.length ?? 0) > 0, 5000, 'A switched')
    await until(() => (current(b).relays?.length ?? 0) > 0 && current(b).tag === current(a).tag, 5000, 'B follows')
    const autoTag = current(a).tag
    expect(autoTag).not.toBe(fixedTag)

    await a.insertInto('todo').values({ title: 'on picked relays' }).execute()
    await until(async () => (await titles(b)).includes('on picked relays'), 5000, 'B receives')
    expect(wrapsWith(f, autoTag)).toHaveLength(0)
    // The earlier fixed-relay epoch is still read (FIXED_READ_DAYS).
    expect(I(a).subscriptionTags()).toContain(fixedTag)
  })

  it('inviting a member on an older version puts the space back on the fixed relays', async () => {
    const { fresh, older } = await setup()
    const a = await device()(fresh)
    const c = await device()(older)
    const space = await a.createSpace('team')
    expect(I(a).keysBySpace.get(space)![0]!.relays?.length).toBeGreaterThan(0)
    await a.addMember(space, c.npub, 'writer', { devices: c.deviceDelegations() })
    expect(I(a).keysBySpace.get(space)![0]!.relays ?? null).toBeNull()
    await until(() => c.invitations().some((i) => i.space === space), 5000, 'invitation arrives')
    await c.acceptInvitation(space)
    await a.insertInto('todo').values({ title: 'hello team', space } as never).execute()
    await until(async () => (await c.selectFrom('todo').select('title').execute()).some((r) => r.title === 'hello team'), 5000, 'old member receives')
  })

  it('writes fall through to ranks 6–10, and readers find them there (DECISIONS 29 ⑤)', async () => {
    const { cands, fresh } = await setup(12, { relayCheckIntervalMs: 300 })
    const a = await device()(fresh)
    const { db: b } = await pair(a, fresh)
    await until(() => current(b).tag === current(a).tag, 5000, 'paired')
    const tag = current(a).tag
    const ranks = I(a).sync.router.planned().get(tag)!.ranks
    expect(ranks).toHaveLength(10)
    const top = cands.filter((r) => ranks.slice(0, 5).includes(r.url))
    for (const r of top) await r.stop()
    await until(() => ranks.slice(0, 5).every((u) => I(a).sync.pool.isDown(u)), 5000, 'top 5 seen as down')

    await a.insertInto('todo').values({ title: 'placed on lower ranks' }).execute()
    await until(() => I(a).store.outboxSize() === 0, 5000, 'delivered to 5 of the top 10')
    const lower = cands.filter((r) => ranks.slice(5).includes(r.url))
    expect(lower.filter((r) => wrapsWith(r, tag).length > 0).length).toBeGreaterThan(0)
    await until(async () => (await titles(b)).includes('placed on lower ranks'), 5000, 'B finds it on ranks 6–10')
  })

  it('a sequence gap is filled by a time-range query over the top 10 (DECISIONS 29 ⑤)', async () => {
    const { cands, fresh } = await setup(12, { relayCheckIntervalMs: 3_600_000, reconcileIntervalMs: 300 })
    const a = await device()(fresh)
    const { db: b } = await pair(a, fresh)
    await until(() => current(b).tag === current(a).tag, 5000, 'paired')
    const tag = current(a).tag
    const ranks = I(a).sync.router.planned().get(tag)!.ranks
    const top = cands.filter((r) => ranks.slice(0, 5).includes(r.url))

    // msg 2 is lost on the top 5 and survives only on rank 6.
    for (const r of top) r.opts.blackhole = true
    await a.insertInto('todo').values({ title: 'only on rank 6' }).execute()
    await until(() => I(a).store.outboxSize() === 0, 5000, 'A thinks it is delivered')
    const raw = I(a).store.driver.all<{ event: string }>(`SELECT event FROM anodb_raw WHERE tag = '${tag}' ORDER BY created_at DESC LIMIT 1`)
    const ev = JSON.parse(raw[0]!.event)
    await (I(a).sync.pool as unknown as { publish(e: unknown, r: string[]): Promise<unknown> }).publish(ev, [ranks[5]!])
    for (const r of top) r.opts.blackhole = false

    await a.insertInto('todo').values({ title: 'after the gap' }).execute()
    await until(async () => (await titles(b)).includes('after the gap'), 5000, 'B sees the gap')
    await until(async () => (await titles(b)).includes('only on rank 6'), 5000, 'gap filled from rank 6')
  })

  it('spaces beyond the live connection budget are polled (DECISIONS 29 ④)', async () => {
    // 20 candidates: the space's top 5 almost surely include a relay outside the inbox's (always live) top 5.
    const { fresh } = await setup(20, { maxAutoRelays: 0, relayPollIntervalMs: 200 })
    const a = await device()(fresh)
    const { db: b } = await pair(a, fresh)
    await until(() => current(b).tag === current(a).tag, 5000, 'paired')
    expect(I(b).sync.router.planned().get(current(b).tag)!.live).toBe(false)
    await a.insertInto('todo').values({ title: 'polled' }).execute()
    await until(async () => (await titles(b)).includes('polled'), 5000, 'B polls it')
  })

  it('keeps reading the previous epoch on picked relays for relayGraceDays', async () => {
    const { fresh } = await setup()
    const a = await device()(fresh)
    const first = current(a).tag
    await I(a).rotateKey(I(a).personal)
    expect(current(a).tag).not.toBe(first)
    expect(I(a).subscriptionTags()).toContain(first)
    await a.close()
    const short = await device()({ ...fresh, relayGraceDays: 0 })
    const t0 = current(short).tag
    await I(short).rotateKey(I(short).personal)
    expect(I(short).subscriptionTags()).not.toContain(t0)
  })
})
