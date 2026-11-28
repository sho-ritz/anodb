import { describe, expect, it } from 'vitest'
import { bytesToHex, generateSecretKey, getPublicKey } from '../src/crypto.js'
import { confirmed, defineSchema, owned, serveRequests } from '../src/index.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { changeAllowed } from '../src/policy.js'
import { until } from './helpers/mock-relay.js'
import { open, relay } from './helpers/setup.js'

const serverSk = generateSecretKey()
const SERVER = getPublicKey(serverSk)

const schema = defineSchema({
  slots: confirmed({ title: 'text', remaining: 'integer' }, { by: SERVER }),
  bookingRequests: owned({ slot: 'text' }),
  bookings: confirmed({ slot: 'text', status: 'text' }, { by: SERVER }),
})

type DB = Awaited<ReturnType<typeof open<typeof schema>>>

/** Server owns a public space with the slots; each user has a private space shared with the server. */
async function setup() {
  const r = await relay()
  const server = await open(schema, [r], { keyStore: memoryKeyStore({ identity: bytesToHex(serverSk) }) })
  expect(server.pubkey).toBe(SERVER)
  server.onInvitation((i) => void server.acceptInvitation(i.space))
  const users: Array<{ db: DB; space: string }> = []
  for (const name of ['alice', 'bob']) {
    const db = await open(schema, [r])
    await db.publishKeyPackage()
    users.push({ db, space: '' })
  }
  await server.publishKeyPackage()
  await until(() => [server, ...users.map((u) => u.db)].every((d) => d.status.pendingEvents === 0), 5000, 'key packages')

  const pub = await server.createSpace('events')
  await server.insertInto('slots').values({ id: 'concert', title: 'Concert', remaining: 1, space: pub }).execute()
  for (const u of users) {
    await server.addMember(pub, u.db.npub, 'reader')
    await until(() => u.db.invitations().some((i) => i.space === pub), 5000, 'public invitation')
    await u.db.acceptInvitation(pub)
    u.space = await u.db.createSpace('my bookings')
    await u.db.addMember(u.space, server.npub, 'writer')
    await until(() => server.spaces().some((s) => s.id === u.space && s.status === 'active'), 5000, 'server joins private space')
  }
  for (const u of users) await until(async () => (await u.db.selectFrom('slots').selectAll().execute()).length === 1, 5000, 'slots reach users')
  return { r, server, users, pub }
}

const decide = (db: DB) =>
  serveRequests(db, {
    requests: 'bookingRequests',
    results: 'bookings',
    handle: async (req, trx) => {
      const slot = await trx.selectFrom('slots').select('remaining').where('id', '=', req.slot!).executeTakeFirst()
      const left = slot?.remaining ?? 0
      if (left < 1) return { slot: req.slot, status: 'rejected' }
      await trx.updateTable('slots').set({ remaining: left - 1 }).where('id', '=', req.slot!).execute()
      return { slot: req.slot, status: 'confirmed' }
    },
  })

describe('server-confirmed tables', () => {
  it('only the authority may write confirmed() tables (row rule)', () => {
    const other = 'b'.repeat(64)
    expect(changeAllowed(schema, ['bookings', `${other}-x`, 'status', 'confirmed', '1'], SERVER, 'writer')).toBe(true)
    // Not even the row's creator or the space owner.
    expect(changeAllowed(schema, ['bookings', `${other}-x`, 'status', 'confirmed', '1'], other, 'owner')).toBe(false)
    expect(changeAllowed(schema, ['slots', 'concert', '$deleted', true, '1'], other, 'owner')).toBe(false)
    expect(() => confirmed(owned({ a: 'text' }), { by: SERVER })).toThrow(/both/)
    expect(() => confirmed({ a: 'text' }, { by: 'nope' })).toThrow()
  })

  it('one seat left: of two simultaneous requests exactly one is confirmed; nobody sees the other booking', async () => {
    const { server, users, pub } = await setup()
    const [alice, bob] = users as [{ db: DB; space: string }, { db: DB; space: string }]
    const serving = decide(server)

    // Clients cannot write the decision themselves, even in a space they own.
    await expect(alice.db.insertInto('bookings').values({ slot: 'concert', status: 'confirmed', space: alice.space }).execute()).rejects.toThrow(/confirmed\(\)/)
    await expect(alice.db.updateTable('slots').set({ remaining: 5 }).where('id', '=', 'concert').execute()).rejects.toThrow(/no write permission/)

    const [ra, rb] = await Promise.all([
      alice.db.insertInto('bookingRequests').values({ slot: 'concert', space: alice.space }).returning('id').executeTakeFirstOrThrow(),
      bob.db.insertInto('bookingRequests').values({ slot: 'concert', space: bob.space }).returning('id').executeTakeFirstOrThrow(),
    ])
    const result = async (u: { db: DB }, id: string) => (await u.db.selectFrom('bookings').selectAll().where('id', '=', id).executeTakeFirst())?.status
    await until(async () => !!(await result(alice, ra.id)) && !!(await result(bob, rb.id)), 8000, 'both decided')
    expect([await result(alice, ra.id), await result(bob, rb.id)].sort()).toEqual(['confirmed', 'rejected'])

    // Each user receives only their own booking; the shared count reaches everyone.
    for (const u of users) {
      expect(await u.db.selectFrom('bookings').selectAll().execute()).toHaveLength(1)
      await until(async () => (await u.db.selectFrom('slots').select('remaining').executeTakeFirst())?.remaining === 0, 5000, 'remaining 0')
    }
    const onServer = await server.selectFrom('bookings').selectAll().execute()
    expect(onServer).toHaveLength(2)
    expect((await server.selectFrom('slots').selectAll().where('space', '=', pub).executeTakeFirstOrThrow()).remaining).toBe(0)
    // The result row names the request (same id) and is never decided twice.
    await serving.drain()
    await serving.drain()
    expect(await server.selectFrom('bookings').selectAll().execute()).toHaveLength(2)
    serving.stop()
  })

  it('a modified client cannot forge decisions, not even by a snapshot of its own space', async () => {
    const { server, users } = await setup()
    const alice = users[0]!
    const d = alice.db as unknown as {
      store: { transaction<T>(f: (s: unknown) => Promise<T>): Promise<T>; applyChanges: (s: string, c: unknown[], by?: string) => Promise<unknown> }
      sendToSpace: (s: unknown, sp: string, t: string, p: unknown) => Promise<unknown>
      clock: { tick: () => string }
      snapshot: (s: string) => Promise<void>
    }
    const id = `${alice.db.pubkey}-forged`
    await d.store.transaction((s) =>
      d.sendToSpace(s, alice.space, 'ch', { c: [['bookings', id, '$createdAt', Date.now(), d.clock.tick()], ['bookings', id, 'status', 'confirmed', d.clock.tick()]] }),
    )
    // The snapshot restates the cell as if the server had written it.
    await d.store.applyChanges(alice.space, [['bookings', `${id}2`, '$createdAt', Date.now(), d.clock.tick()], ['bookings', `${id}2`, 'status', 'confirmed', d.clock.tick()]], SERVER)
    await d.snapshot(alice.space)
    // Something legitimate after it, to know the forged messages have arrived too.
    await alice.db.insertInto('bookingRequests').values({ slot: 'concert', space: alice.space }).execute()
    await until(async () => (await server.selectFrom('bookingRequests').selectAll().execute()).length === 1, 5000, 'delivery')
    await new Promise((r) => setTimeout(r, 500))
    expect(await server.selectFrom('bookings').selectAll().execute()).toEqual([])
  })

  it('requests written while the server was not serving are decided when it starts', async () => {
    const { server, users } = await setup()
    const alice = users[0]!
    const req = await alice.db.insertInto('bookingRequests').values({ slot: 'concert', space: alice.space }).returning('id').executeTakeFirstOrThrow()
    await until(async () => (await server.selectFrom('bookingRequests').selectAll().execute()).length === 1, 5000, 'request reaches server')
    expect(await server.selectFrom('bookings').selectAll().execute()).toHaveLength(0)

    const serving = decide(server)
    await serving.drain()
    await until(async () => (await alice.db.selectFrom('bookings').select('status').where('id', '=', req.id).executeTakeFirst())?.status === 'confirmed', 5000, 'decided')
    serving.stop()
  })

  it('a failing handler leaves the request undecided and reports it once', async () => {
    const { server, users } = await setup()
    const alice = users[0]!
    const errors: unknown[] = []
    let fail = true
    const serving = serveRequests(server, {
      requests: 'bookingRequests',
      results: 'bookings',
      handle: async (req) => {
        if (fail) throw new Error('payment provider down')
        return { slot: req.slot, status: 'confirmed' }
      },
      onError: (e) => errors.push(e),
    })
    const req = await alice.db.insertInto('bookingRequests').values({ slot: 'concert', space: alice.space }).returning('id').executeTakeFirstOrThrow()
    await until(() => errors.length === 1, 5000, 'error reported')
    await serving.drain()
    expect(errors).toHaveLength(1)
    expect(await server.selectFrom('bookings').selectAll().execute()).toHaveLength(0)
    fail = false
    await serving.drain()
    await until(async () => (await alice.db.selectFrom('bookings').select('status').where('id', '=', req.id).executeTakeFirst())?.status === 'confirmed', 5000, 'decided after retry')
    serving.stop()
  })

  it('serveRequests refuses tables this identity does not confirm', async () => {
    const db = await open(schema)
    expect(() => serveRequests(db, { requests: 'bookingRequests', results: 'bookings', handle: async () => ({}) })).toThrow(/not the authority/)
    expect(() => serveRequests(db as never, { requests: 'bookingRequests', results: 'bookingRequests', handle: async () => ({}) })).toThrow(/not a confirmed/)
  })
})
