// anoDB on a PostgreSQL server (node-postgres). Needs a server: `docker compose -f
// docker-compose.test.yml up -d --wait`, or ANODB_TEST_PG_URL (an admin connection that may create
// databases). Skipped when no server answers.
import pg from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { type AnoDBError, createAnoDB, defineSchema, owned, pgDriver, sql } from '../src/index.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { until } from './helpers/mock-relay.js'
import { TEST_PG_URL, freshPgDatabase, onCleanup, open, pgPool, relay } from './helpers/setup.js'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean', priority: 'integer', score: 'real', meta: 'json' },
  tag: { name: 'text', todoId: 'text' },
})

async function serverUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: TEST_PG_URL, connectionTimeoutMillis: 2000 })
  try {
    await c.connect()
    await c.end()
    return true
  } catch {
    return false
  }
}
const up = await serverUp()

/** anoDB on a fresh database, plus a separate pool standing in for another tool (Prisma, psql…). */
async function pgdb(extra: Parameters<typeof open<typeof schema>>[2] = {}) {
  const url = await freshPgDatabase()
  const db = await open(schema, [], { driver: pgDriver(await pgPool(url), { close: false }), ...extra })
  const other = await pgPool(url)
  return { url, db, other }
}

const outside = async (p: pg.Pool, q: string, params: unknown[] = []) => (await p.query(q, params)).rows

describe.skipIf(!up)('pg driver: SQL-like API on a Postgres server', () => {
  beforeAll(() => {
    if (!up) console.warn(`no Postgres at ${TEST_PG_URL}`)
  })

  it('stores native Postgres types and reads them back (BIGINT as numbers)', async () => {
    const { db, other } = await pgdb()
    const [row] = await db
      .insertInto('todo')
      .values({ title: 'milk', done: false, priority: 2 ** 40, score: 1.5, meta: { tags: ['x'] } })
      .returning(['id', 'space', 'done', 'priority', 'meta'])
      .execute()
    expect(row).toMatchObject({ space: db.personalSpace, done: false, priority: 2 ** 40, meta: { tags: ['x'] } })
    // createdAt is filled in once anoDB has committed the write (after RETURNING).
    expect((await db.selectFrom('todo').select('createdAt').execute())[0]!.createdAt).toEqual(expect.any(Number))
    await db.insertInto('tag').values({ name: 'shop', todoId: row!.id }).execute()
    const joined = await db.selectFrom('todo').innerJoin('tag', 'tag.todoId', 'todo.id').select(['todo.title', 'todo.priority', 'tag.name', 'todo.updatedAt']).execute()
    expect(joined).toEqual([{ title: 'milk', priority: 2 ** 40, name: 'shop', updatedAt: expect.any(Number) }])
    const cols = await outside(other, `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'todo' ORDER BY ordinal_position`)
    expect(Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]))).toMatchObject({
      title: 'text',
      done: 'boolean',
      priority: 'bigint',
      score: 'double precision',
      meta: 'jsonb',
      createdAt: 'bigint',
    })
  })

  it('accepts Postgres SQL writes with $n parameters', async () => {
    const { db } = await pgdb()
    await db.execute(`INSERT INTO todo (title, priority) VALUES ('buy milk', 1), ('buy eggs', 2), ('code', 3)`)
    await db.execute(`UPDATE todo SET done = true WHERE title LIKE 'buy%'`)
    const [first] = await db.execute<{ id: string }>(`SELECT id FROM todo WHERE title = $1`, ['code'])
    await db.execute(`INSERT INTO todo (id, title) VALUES ($1, 'code!') ON CONFLICT (space, id) DO UPDATE SET title = excluded.title`, [first!.id])
    expect(await db.execute(`SELECT title, done FROM todo ORDER BY priority`)).toEqual([
      { title: 'buy milk', done: true },
      { title: 'buy eggs', done: true },
      { title: 'code!', done: null },
    ])
    const r = await sql<{ p: number }>`SELECT priority * 2 AS p FROM todo WHERE title = ${'buy eggs'}`.execute(db.db)
    expect(r.rows).toEqual([{ p: 4 }])
  })

  it('makes multi-statement transactions atomic, and recovers from a failed one', async () => {
    const { db } = await pgdb()
    await db.transaction().execute(async (tx) => {
      const [r] = await tx.insertInto('todo').values({ title: 'a' }).returning('id').execute()
      await tx.updateTable('todo').set({ priority: 5 }).where('id', '=', r!.id).execute()
    })
    await expect(
      db.transaction().execute(async (tx) => {
        await tx.insertInto('todo').values({ title: 'c' }).execute()
        await sql`SELECT 1/0`.execute(tx)
      }),
    ).rejects.toThrow(/division by zero/)
    await db.insertInto('todo').values({ title: 'after' }).execute()
    expect(await db.selectFrom('todo').select(['title', 'priority']).orderBy('title').execute()).toEqual([
      { title: 'a', priority: 5 },
      { title: 'after', priority: null },
    ])
  })

  it('rejects type errors, id changes and unknown spaces', async () => {
    const { db } = await pgdb()
    await expect(db.execute(`INSERT INTO todo (done) VALUES (7)`)).rejects.toThrow(/boolean/)
    await db.execute(`INSERT INTO todo (id, title) VALUES ('fixed', 'x')`)
    await expect(db.execute(`UPDATE todo SET id = 'other' WHERE id = 'fixed'`)).rejects.toThrow(/cannot be changed/)
    await expect(db.execute(`INSERT INTO todo (space, title) VALUES ('nope', 'x')`)).rejects.toThrow(/unknown or inactive space/)
  })

  it('reopens the same database (schema change; another identity is refused)', async () => {
    const url = await freshPgDatabase()
    const ks = memoryKeyStore()
    const a = await createAnoDB({ appId: 'p', schema, driver: pgDriver(new pg.Pool({ connectionString: url })), keyStore: ks, relays: [] })
    await a.insertInto('todo').values({ title: 'persisted', done: true }).execute()
    const space = a.personalSpace
    await a.close()
    const v2 = defineSchema({ todo: { title: 'text', done: 'boolean', due: 'integer' } })
    const b = await createAnoDB({ appId: 'p', schema: v2, driver: pgDriver(new pg.Pool({ connectionString: url })), keyStore: ks, relays: [] })
    expect(b.personalSpace).toBe(space)
    expect(await b.selectFrom('todo').select(['title', 'done', 'due']).execute()).toEqual([{ title: 'persisted', done: true, due: null }])
    await b.close()
    await expect(
      createAnoDB({ appId: 'p', schema, driver: pgDriver(new pg.Pool({ connectionString: url })), keyStore: memoryKeyStore(), relays: [] }),
    ).rejects.toThrow(/different identity/)
  })

  it('never drops a table it did not create', async () => {
    const url = await freshPgDatabase()
    const other = await pgPool(url)
    await other.query(`CREATE TABLE todo (id TEXT PRIMARY KEY, title TEXT); INSERT INTO todo VALUES ('1', 'keep me')`)
    await expect(open(schema, [], { driver: pgDriver(await pgPool(url), { close: false }) })).rejects.toThrow(/already exists and was not created by anoDB/)
    expect(await outside(other, 'SELECT title FROM todo')).toEqual([{ title: 'keep me' }])
  })
})

describe.skipIf(!up)('pg driver: writes from other connections (Prisma, TypeORM, psql…)', () => {
  it('commits inserts, updates and deletes made on another connection', async () => {
    const { db, other } = await pgdb()
    await outside(other, `INSERT INTO todo (title, done, meta) VALUES ($1, $2, $3)`, ['from prisma', false, JSON.stringify({ a: 1 })])
    await db.syncExternalWrites()
    const [row] = await db.selectFrom('todo').selectAll().execute()
    expect(row).toMatchObject({ title: 'from prisma', done: false, meta: { a: 1 }, createdBy: db.pubkey })
    await outside(other, `UPDATE todo SET done = true WHERE id = $1`, [row!.id])
    await db.syncExternalWrites()
    expect(await db.selectFrom('todo').select('done').execute()).toEqual([{ done: true }])
    await outside(other, `DELETE FROM todo`)
    await db.syncExternalWrites()
    expect(await db.selectFrom('todo').selectAll().execute()).toEqual([])
  })

  it('picks writes up by itself (LISTEN / NOTIFY on its own connection)', async () => {
    const { db, other } = await pgdb()
    await outside(other, `INSERT INTO todo (title) VALUES ('notified')`)
    await until(async () => (await db.execute<{ n: number }>(`SELECT COUNT(*)::int AS n FROM anodb_cells WHERE col = 'title'`))[0]!.n === 1, 3000, 'captured')
  })

  it('undoes writes that are not allowed and reports them', async () => {
    const url = await freshPgDatabase()
    const db = await open(defineSchema({ ...schema, note: owned({ text: 'text' }) }), [], { driver: pgDriver(await pgPool(url), { close: false }) })
    const other = await pgPool(url)
    const errors: AnoDBError[] = []
    db.onError((e) => errors.push(e))
    await db.insertInto('todo').values({ title: 'kept' }).execute()
    await outside(other, `INSERT INTO todo (space, title) VALUES ('no-such-space', 'stray')`)
    await outside(other, `INSERT INTO note (id, text) VALUES ($1, 'not mine')`, [`${'ab'.repeat(32)}-x`])
    await db.syncExternalWrites()
    expect(await outside(other, `SELECT title FROM todo ORDER BY title`)).toEqual([{ title: 'kept' }])
    expect(await outside(other, `SELECT * FROM note`)).toEqual([])
    expect(errors.map((e) => e.code)).toEqual(['rejected-write', 'rejected-write'])
  })

  it('syncs writes made while anoDB was not running', async () => {
    const url = await freshPgDatabase()
    const ks = memoryKeyStore()
    const a = await createAnoDB({ appId: 'p', schema, driver: pgDriver(new pg.Pool({ connectionString: url })), keyStore: ks, relays: [] })
    await a.close()
    const other = await pgPool(url)
    await other.query(`INSERT INTO todo (title) VALUES ('offline write')`)
    const b = await createAnoDB({ appId: 'p', schema, driver: pgDriver(new pg.Pool({ connectionString: url })), keyStore: ks, relays: [] })
    onCleanup(() => b.close())
    const cells = await (b as unknown as { store: { cells(s: string): Promise<unknown[][]> } }).store.cells(b.personalSpace)
    expect(cells.some((c) => c[2] === 'title' && c[3] === 'offline write')).toBe(true)
  })

  it('concurrent transactions on other connections and anoDB writes do not interfere', async () => {
    const { db, other } = await pgdb()
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => db.insertInto('todo').values({ title: `ano${i}` }).execute()),
      ...Array.from({ length: 5 }, async (_, i) => {
        const c = await other.connect()
        try {
          await c.query('BEGIN')
          await c.query(`INSERT INTO todo (title) VALUES ($1)`, [`ext${i}`])
          await c.query(`UPDATE todo SET priority = $1 WHERE title = $2`, [i, `ext${i}`])
          await c.query('COMMIT')
        } finally {
          c.release()
        }
      }),
    ])
    await db.syncExternalWrites()
    const rows = await db.selectFrom('todo').select(['title', 'priority']).orderBy('title').execute()
    expect(rows.map((r) => r.title)).toEqual(['ano0', 'ano1', 'ano2', 'ano3', 'ano4', 'ext0', 'ext1', 'ext2', 'ext3', 'ext4'])
    expect(rows.filter((r) => r.title?.startsWith('ext')).map((r) => r.priority)).toEqual([0, 1, 2, 3, 4])
  })
})

describe.skipIf(!up)('Postgres server ⇄ SQLite devices', () => {
  it('a server member and a SQLite member share a space both ways, including writes from another tool', async () => {
    const r = await relay()
    const url = await freshPgDatabase()
    const server = await open(schema, [r], { driver: pgDriver(await pgPool(url), { close: false }) })
    const other = await pgPool(url)
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

    await server.insertInto('todo').values({ title: 'from server', done: true, space }).execute()
    await outside(other, `INSERT INTO todo (space, title, priority) VALUES ($1, 'from typeorm', 7)`, [space])
    await phone.insertInto('todo').values({ title: 'from phone', done: false, space }).execute()

    const rows = async (d: typeof server) => d.selectFrom('todo').select(['title', 'done', 'priority']).where('space', '=', space).orderBy('title').execute()
    const want = [
      { title: 'from phone', done: false, priority: null },
      { title: 'from server', done: true, priority: null },
      { title: 'from typeorm', done: null, priority: 7 },
    ]
    await until(async () => JSON.stringify(await rows(phone)) === JSON.stringify(want), 5000, 'phone sees all')
    await until(async () => JSON.stringify(await rows(server)) === JSON.stringify(want), 5000, 'server sees all')
    // The phone's write is in the Postgres table, readable by any other tool.
    expect(await outside(other, `SELECT title FROM todo WHERE space = $1 AND title = 'from phone'`, [space])).toHaveLength(1)
  })
})
