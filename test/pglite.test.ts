import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { type AnoDBError, createAnoDB, defineSchema, owned, pgliteDriver, sql } from '../src/index.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { until } from './helpers/mock-relay.js'
import { onCleanup, open, relay, sleep } from './helpers/setup.js'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean', priority: 'integer', score: 'real', meta: 'json' },
  tag: { name: 'text', todoId: 'text' },
})

async function pglite(dir?: string) {
  const pg = await PGlite.create(dir)
  onCleanup(() => (pg.closed ? undefined : pg.close()))
  return pg
}

async function pgdb(extra: Parameters<typeof open<typeof schema>>[2] = {}) {
  const pg = await pglite()
  const db = await open(schema, [], { driver: pgliteDriver(pg, { close: false }), ...extra })
  return { pg, db }
}

/** What another tool (Prisma, psql…) does: plain SQL on the same PGlite instance. */
const outside = (pg: PGlite, q: string, params: unknown[] = []) => pg.query(q, params)

describe('PGlite driver: SQL-like API on Postgres', () => {
  it('stores native Postgres types and reads them back through Kysely', async () => {
    const { pg, db } = await pgdb()
    const [row] = await db
      .insertInto('todo')
      .values({ title: 'milk', done: false, priority: 2, score: 1.5, meta: { tags: ['x'] } })
      .returning(['id', 'space', 'done', 'meta'])
      .execute()
    expect(row).toMatchObject({ space: db.personalSpace, done: false, meta: { tags: ['x'] } })
    expect(row!.id).toMatch(new RegExp(`^${db.pubkey}-[0-9a-f]{16}$`))
    await db.insertInto('tag').values({ name: 'shop', todoId: row!.id }).execute()
    await db.updateTable('todo').set({ done: true }).where('id', '=', row!.id).execute()

    const joined = await db.selectFrom('todo').innerJoin('tag', 'tag.todoId', 'todo.id').select(['todo.title', 'todo.done', 'todo.meta', 'tag.name', 'todo.createdAt']).execute()
    expect(joined).toEqual([{ title: 'milk', done: true, meta: { tags: ['x'] }, name: 'shop', createdAt: expect.any(Number) }])

    // The table is an ordinary Postgres table with native column types.
    const cols = await outside(pg, `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'todo' ORDER BY ordinal_position`)
    expect(Object.fromEntries((cols.rows as Array<{ column_name: string; data_type: string }>).map((c) => [c.column_name, c.data_type]))).toMatchObject({
      title: 'text',
      done: 'boolean',
      priority: 'bigint',
      score: 'double precision',
      meta: 'jsonb',
      createdAt: 'bigint',
    })
    expect(await db.execute('SELECT done, meta FROM todo')).toEqual([{ done: true, meta: { tags: ['x'] } }])

    await db.deleteFrom('todo').where('done', '=', true).execute()
    expect(await db.selectFrom('todo').selectAll().execute()).toEqual([])
  })

  it('accepts arbitrary Postgres SQL writes with $n parameters', async () => {
    const { db } = await pgdb()
    await db.execute(`INSERT INTO todo (title, priority) VALUES ('buy milk', 1), ('buy eggs', 2), ('code', 3)`)
    await db.execute(`UPDATE todo SET done = true WHERE title LIKE 'buy%'`)
    await db.execute(`INSERT INTO tag (name, "todoId") SELECT 'auto', id FROM todo WHERE done`)
    const [first] = await db.execute<{ id: string }>(`SELECT id FROM todo WHERE title = $1`, ['code'])
    await db.execute(`INSERT INTO todo (id, title) VALUES ($1, 'code!') ON CONFLICT (space, id) DO UPDATE SET title = excluded.title`, [first!.id])
    expect(await db.execute(`SELECT title, done FROM todo ORDER BY priority`)).toEqual([
      { title: 'buy milk', done: true },
      { title: 'buy eggs', done: true },
      { title: 'code!', done: null },
    ])
    expect((await db.execute<{ n: number }>('SELECT COUNT(*)::int AS n FROM tag'))[0]!.n).toBe(2)
    const r = await sql<{ p: number }>`SELECT priority * 2 AS p FROM todo WHERE title = ${'buy eggs'}`.execute(db.db)
    expect(r.rows).toEqual([{ p: 4 }])
  })

  it('makes multi-statement transactions atomic', async () => {
    const { db } = await pgdb()
    await db.transaction().execute(async (tx) => {
      const [r] = await tx.insertInto('todo').values({ title: 'a' }).returning('id').execute()
      expect(await tx.selectFrom('todo').select('title').where('id', '=', r!.id).execute()).toEqual([{ title: 'a' }])
      await tx.updateTable('todo').set({ priority: 5 }).where('id', '=', r!.id).execute()
    })
    expect(await db.selectFrom('todo').select(['title', 'priority']).execute()).toEqual([{ title: 'a', priority: 5 }])
    await expect(
      db.transaction().execute(async (tx) => {
        await tx.insertInto('todo').values({ title: 'b' }).execute()
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // a failing statement aborts the Postgres transaction; anoDB recovers
    await expect(
      db.transaction().execute(async (tx) => {
        await tx.insertInto('todo').values({ title: 'c' }).execute()
        await sql`SELECT 1/0`.execute(tx)
      }),
    ).rejects.toThrow(/division by zero/)
    expect(await db.selectFrom('todo').select('title').execute()).toEqual([{ title: 'a' }])
    await db.insertInto('todo').values({ title: 'after' }).execute()
    expect((await db.selectFrom('todo').select('title').orderBy('title').execute()).map((r) => r.title)).toEqual(['a', 'after'])
  })

  it('rejects type errors, id/space changes and unknown spaces', async () => {
    const { db } = await pgdb()
    await expect(db.execute(`INSERT INTO todo (priority) VALUES (1.5)`)).resolves.toEqual([]) // Postgres rounds into bigint
    await expect(db.execute(`INSERT INTO todo (done) VALUES (7)`)).rejects.toThrow(/boolean/)
    await expect(db.execute(`INSERT INTO todo (meta) VALUES ('not json')`)).rejects.toThrow(/json/i)
    await db.execute(`INSERT INTO todo (id, title) VALUES ('fixed', 'x')`)
    await expect(db.execute(`UPDATE todo SET id = 'other' WHERE id = 'fixed'`)).rejects.toThrow(/cannot be changed/)
    await expect(db.execute(`INSERT INTO todo (space, title) VALUES ('nope', 'x')`)).rejects.toThrow(/unknown or inactive space/)
    expect((await db.execute<{ id: string }>(`SELECT id FROM todo ORDER BY id`)).map((r) => r.id)).toContain('fixed')
  })

  it('notifies subscriptions', async () => {
    const { db } = await pgdb()
    const seen: number[] = []
    const stop = db.subscribe(db.selectFrom('todo').selectAll().where('done', 'is', null), (rows) => seen.push(rows.length))
    await sleep(30)
    await db.insertInto('todo').values({ title: 'x' }).execute()
    await db.insertInto('tag').values({ name: 'unrelated' }).execute()
    await sleep(30)
    stop()
    expect(seen).toEqual([0, 1])
  })

  it('reopens a persistent PGlite database (schema change, other identity refused)', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = join(mkdtempSync(join(tmpdir(), 'anodb-pg-')), 'data')
    const ks = memoryKeyStore()
    const a = await createAnoDB({ appId: 'p', schema, driver: pgliteDriver(await PGlite.create(dir)), keyStore: ks, relays: [] })
    await a.insertInto('todo').values({ title: 'persisted', done: true }).execute()
    const space = a.personalSpace
    await a.close()
    const v2 = defineSchema({ todo: { title: 'text', done: 'boolean', due: 'integer' } })
    const b = await createAnoDB({ appId: 'p', schema: v2, driver: pgliteDriver(await PGlite.create(dir)), keyStore: ks, relays: [] })
    expect(b.personalSpace).toBe(space)
    expect(await b.selectFrom('todo').select(['title', 'done', 'due']).execute()).toEqual([{ title: 'persisted', done: true, due: null }])
    await b.close()
    await expect(createAnoDB({ appId: 'p', schema, driver: pgliteDriver(await PGlite.create(dir)), keyStore: memoryKeyStore(), relays: [] })).rejects.toThrow(
      /different identity/,
    )
  })

  it('never drops a table it did not create', async () => {
    const pg = await pglite()
    await pg.exec(`CREATE TABLE todo (id TEXT PRIMARY KEY, title TEXT); INSERT INTO todo VALUES ('1', 'keep me')`)
    await expect(open(schema, [], { driver: pgliteDriver(pg, { close: false }) })).rejects.toThrow(/already exists and was not created by anoDB/)
    expect((await pg.query('SELECT title FROM todo')).rows).toEqual([{ title: 'keep me' }])
  })
})

describe('PGlite driver: writes from outside anoDB (Prisma, psql…)', () => {
  it('commits inserts, updates and deletes made directly on the tables', async () => {
    const { pg, db } = await pgdb()
    const changes: string[] = []
    db.onChange((t, origin) => changes.push(`${[...t].join(',')}:${origin}`))
    await outside(pg, `INSERT INTO todo (title, done, meta) VALUES ($1, $2, $3)`, ['from prisma', false, JSON.stringify({ a: 1 })])
    await db.syncExternalWrites()
    const [row] = await db.selectFrom('todo').selectAll().execute()
    expect(row).toMatchObject({ title: 'from prisma', done: false, meta: { a: 1 }, space: db.personalSpace, createdBy: db.pubkey, updatedBy: db.pubkey })
    expect(row!.createdAt).toEqual(expect.any(Number))
    expect(changes).toContain('todo:local')

    await outside(pg, `UPDATE todo SET done = true WHERE id = $1`, [row!.id])
    await db.syncExternalWrites()
    expect(await db.selectFrom('todo').select('done').execute()).toEqual([{ done: true }])

    await outside(pg, `DELETE FROM todo`)
    await db.syncExternalWrites()
    expect(await db.selectFrom('todo').selectAll().execute()).toEqual([])
    // and they went through the change log like anoDB's own writes
    const cells = await (db as unknown as { store: { cells(s: string): Promise<unknown[][]> } }).store.cells(db.personalSpace)
    expect(cells.some((c) => c[1] === row!.id && c[2] === '$deleted' && c[3] === true)).toBe(true)
  })

  it('picks outside writes up by itself (LISTEN / NOTIFY)', async () => {
    const { pg, db } = await pgdb()
    await outside(pg, `INSERT INTO todo (title) VALUES ('notified')`)
    await until(async () => (await db.execute<{ n: number }>(`SELECT COUNT(*)::int AS n FROM anodb_cells WHERE col = 'title'`))[0]!.n === 1, 3000, 'captured')
  })

  it('undoes outside writes that are not allowed and reports them', async () => {
    const pg = await pglite()
    const db = await open(defineSchema({ ...schema, note: owned({ text: 'text' }) }), [], { driver: pgliteDriver(pg, { close: false }) })
    const errors: AnoDBError[] = []
    db.onError((e) => errors.push(e))
    await db.insertInto('todo').values({ title: 'kept' }).execute()
    await outside(pg, `INSERT INTO todo (space, title) VALUES ('no-such-space', 'stray')`)
    await outside(pg, `INSERT INTO note (id, text) VALUES ($1, 'not mine')`, [`${'ab'.repeat(32)}-x`])
    await outside(pg, `UPDATE todo SET title = 'edited' WHERE title = 'kept'`)
    await db.syncExternalWrites()
    expect(await db.selectFrom('todo').select('title').orderBy('title').execute()).toEqual([{ title: 'edited' }])
    expect(await db.selectFrom('note').selectAll().execute()).toEqual([])
    expect(errors.map((e) => e.code)).toEqual(['rejected-write', 'rejected-write'])
    expect(errors[0]!.message).toMatch(/unknown or inactive space/)
    // the projection matches anoDB's state again: the stray row is gone from the table itself
    expect((await pg.query(`SELECT title FROM todo ORDER BY title`)).rows).toEqual([{ title: 'edited' }])
    // id / space of a row cannot be changed from outside either
    await expect(outside(pg, `UPDATE todo SET id = 'x'`)).rejects.toThrow(/cannot be changed/)
  })

  it('syncs writes made while anoDB was closed', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = join(mkdtempSync(join(tmpdir(), 'anodb-pg-')), 'data')
    const ks = memoryKeyStore()
    const a = await createAnoDB({ appId: 'p', schema, driver: pgliteDriver(await PGlite.create(dir)), keyStore: ks, relays: [] })
    await a.close()
    const pg = await PGlite.create(dir)
    await pg.query(`INSERT INTO todo (title) VALUES ('offline write')`)
    const b = await createAnoDB({ appId: 'p', schema, driver: pgliteDriver(pg), keyStore: ks, relays: [] })
    onCleanup(() => b.close())
    const cells = await (b as unknown as { store: { cells(s: string): Promise<unknown[][]> } }).store.cells(b.personalSpace)
    expect(cells.some((c) => c[2] === 'title' && c[3] === 'offline write')).toBe(true)
  })

  it('outside transactions and anoDB writes do not interfere', async () => {
    const { pg, db } = await pgdb()
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => db.insertInto('todo').values({ title: `ano${i}` }).execute()),
      ...Array.from({ length: 5 }, (_, i) =>
        pg.transaction(async (tx) => {
          await tx.query(`INSERT INTO todo (title) VALUES ($1)`, [`ext${i}`])
          await tx.query(`UPDATE todo SET priority = $1 WHERE title = $2`, [i, `ext${i}`])
        }),
      ),
    ])
    await db.syncExternalWrites()
    const rows = await db.selectFrom('todo').select(['title', 'priority']).orderBy('title').execute()
    expect(rows.map((r) => r.title)).toEqual(['ano0', 'ano1', 'ano2', 'ano3', 'ano4', 'ext0', 'ext1', 'ext2', 'ext3', 'ext4'])
    expect(rows.filter((r) => r.title?.startsWith('ext')).map((r) => r.priority)).toEqual([0, 1, 2, 3, 4])
    const cellCount = (await db.execute<{ n: number }>(`SELECT COUNT(DISTINCT row_id)::int AS n FROM anodb_cells`))[0]!.n
    expect(cellCount).toBe(10)
  })
})

describe('PGlite ⇄ SQLite devices', () => {
  it('a PGlite member and a SQLite member share a space both ways, including outside writes', async () => {
    const r = await relay()
    const pg = await pglite()
    const server = await open(schema, [r], { driver: pgliteDriver(pg, { close: false }) })
    const phone = await open(schema, [r]) // node:sqlite
    await server.publishKeyPackage()
    await phone.publishKeyPackage()
    const space = await server.createSpace('family')
    await until(async () => {
      try {
        await server.addMember(space, phone.npub, 'writer')
        return true
      } catch {
        return false
      }
    }, 4000, 'key package')
    await until(() => phone.invitations().length === 1, 4000, 'invitation')
    await phone.acceptInvitation(space)

    await server.insertInto('todo').values({ title: 'from server', done: true, meta: { n: 1 }, space }).execute()
    await outside(pg, `INSERT INTO todo (space, title, priority) VALUES ($1, 'from prisma', 7)`, [space])
    await phone.insertInto('todo').values({ title: 'from phone', done: false, space }).execute()

    const rows = async (d: typeof server) => d.selectFrom('todo').select(['title', 'done', 'priority', 'meta']).where('space', '=', space).orderBy('title').execute()
    const want = [
      { title: 'from phone', done: false, priority: null, meta: null },
      { title: 'from prisma', done: null, priority: 7, meta: null },
      { title: 'from server', done: true, priority: null, meta: { n: 1 } },
    ]
    await until(async () => JSON.stringify(await rows(phone)) === JSON.stringify(want), 5000, 'phone sees all')
    await until(async () => JSON.stringify(await rows(server)) === JSON.stringify(want), 5000, 'server sees all')
    // phone's write lands in the Postgres table, readable by Prisma
    expect((await pg.query(`SELECT title FROM todo WHERE space = $1 AND title = 'from phone'`, [space])).rows).toHaveLength(1)
    expect(server.members(space).map((m) => m.role).sort()).toEqual(['owner', 'writer'])
    expect((await server.syncHealth()).gaps).toEqual([])
  })
})
