import initSqlJs from 'sql.js'
import { describe, expect, it } from 'vitest'
import { createAnoDB, defineSchema, json, sql, sqlJsDriver } from '../src/index.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { nodeSqlite } from '../src/node.js'
import type { SqliteDriver } from '../src/types.js'
import { onCleanup, open } from './helpers/setup.js'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean', priority: 'integer', meta: 'json' },
  tag: { name: 'text', todoId: 'text' },
})

const SQL = await initSqlJs()
const drivers: Array<[string, () => SqliteDriver]> = [
  ['node:sqlite', () => nodeSqlite(':memory:')],
  ['sql.js', () => sqlJsDriver(new SQL.Database())],
]

describe.each(drivers)('SQL-like API (%s)', (_n, makeDriver) => {
  const db = () => open(schema, [], { driver: makeDriver() })

  it('inserts, updates, deletes and joins with Kysely', async () => {
    const d = await db()
    const [row] = await d.insertInto('todo').values({ title: 'milk', done: false, priority: 2, meta: { tags: ['x'] } }).returning(['id', 'space']).execute()
    expect(row!.space).toBe(d.personalSpace)
    await d.insertInto('tag').values({ name: 'shop', todoId: row!.id }).execute()
    await d.updateTable('todo').set({ done: true }).where('id', '=', row!.id).execute()

    const joined = await d
      .selectFrom('todo')
      .innerJoin('tag', 'tag.todoId', 'todo.id')
      .select(['todo.title', 'todo.done', 'todo.meta', 'tag.name', 'todo.createdAt'])
      .execute()
    expect(joined).toEqual([{ title: 'milk', done: true, meta: { tags: ['x'] }, name: 'shop', createdAt: expect.any(Number) }])

    await d.deleteFrom('todo').where('done', '=', true).execute()
    expect(await d.selectFrom('todo').selectAll().execute()).toEqual([])
  })

  it('reads booleans as true/false and JSON as values, through aliases, joins and live queries', async () => {
    const typed = defineSchema({
      todo: { title: 'text', done: 'boolean', meta: json<{ tags: string[] }>() },
      tag: { name: 'text', todoId: 'text', done: 'text' }, // same column name, different type
    })
    const d = await open(typed, [], { driver: makeDriver() })
    const [row] = await d.insertInto('todo').values({ title: 'a', done: true, meta: { tags: ['x'] } }).returning(['id', 'done', 'meta']).execute()
    expect(row).toMatchObject({ done: true, meta: { tags: ['x'] } })
    const tags: string[] = row!.meta!.tags // json<T>() types the value
    expect(tags).toEqual(['x'])
    await d.insertInto('tag').values({ name: 'n', todoId: row!.id, done: 'text!' }).execute()

    expect(await d.selectFrom('todo').selectAll().execute()).toMatchObject([{ done: true, meta: { tags: ['x'] } }])
    expect(await d.selectFrom('todo as t').select(['t.done as finished', 't.meta']).execute()).toEqual([{ finished: true, meta: { tags: ['x'] } }])
    const joined = await d.selectFrom('todo').innerJoin('tag', 'tag.todoId', 'todo.id').select(['todo.done', 'tag.done as tagDone']).selectAll('tag').execute()
    expect(joined[0]).toMatchObject({ done: 'text!', tagDone: 'text!' }) // selectAll('tag') last: tag.done (text) wins
    const [j2] = await d.selectFrom('todo').innerJoin('tag', 'tag.todoId', 'todo.id').select(['todo.done', 'tag.done as tagDone']).execute()
    expect(j2).toEqual({ done: true, tagDone: 'text!' })
    expect(await d.selectFrom('todo').select('done').where('done', '=', true).execute()).toEqual([{ done: true }])
    // expressions and raw SQL keep SQLite values
    expect(await d.selectFrom('todo').select(sql<number>`done + 0`.as('n')).execute()).toEqual([{ n: 1 }])
    expect(await d.execute('SELECT done FROM todo')).toEqual([{ done: 1 }])

    const seen: unknown[] = []
    const stop = d.subscribe(d.selectFrom('todo').select(['done', 'meta']), (rows) => seen.push(rows))
    onCleanup(stop)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen.at(-1)).toEqual([{ done: true, meta: { tags: ['x'] } }])
  })

  it('accepts arbitrary SQL writes (UPDATE … LIKE, INSERT … SELECT, upsert)', async () => {
    const d = await db()
    await d.execute(`INSERT INTO todo (title, priority) VALUES ('buy milk', 1), ('buy eggs', 2), ('code', 3)`)
    await d.execute(`UPDATE todo SET done = 1 WHERE title LIKE 'buy%'`)
    await d.execute(`INSERT INTO tag (name, todoId) SELECT 'auto', id FROM todo WHERE done = 1`)
    const [first] = await d.execute<{ id: string }>(`SELECT id FROM todo WHERE title = 'code'`)
    await d.execute(`INSERT INTO todo (id, title) VALUES (?, 'code!') ON CONFLICT (space, id) DO UPDATE SET title = excluded.title`, [first!.id])
    expect(await d.execute(`SELECT title, done FROM todo ORDER BY priority`)).toEqual([
      { title: 'buy milk', done: 1 },
      { title: 'buy eggs', done: 1 },
      { title: 'code!', done: null },
    ])
    expect((await d.execute<{ n: number }>('SELECT COUNT(*) AS n FROM tag'))[0]!.n).toBe(2)
  })

  it('makes multi-statement transactions atomic', async () => {
    const d = await db()
    await d.transaction().execute(async (tx) => {
      const [r] = await tx.insertInto('todo').values({ title: 'a' }).returning('id').execute()
      // reads inside the transaction see its own writes
      const inside = await tx.selectFrom('todo').select('title').where('id', '=', r!.id).execute()
      expect(inside).toEqual([{ title: 'a' }])
      await tx.updateTable('todo').set({ priority: 5 }).where('id', '=', r!.id).execute()
    })
    expect(await d.selectFrom('todo').select(['title', 'priority']).execute()).toEqual([{ title: 'a', priority: 5 }])

    await expect(
      d.transaction().execute(async (tx) => {
        await tx.insertInto('todo').values({ title: 'b' }).execute()
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await d.selectFrom('todo').select('title').execute()).toEqual([{ title: 'a' }])
  })

  it('rejects type errors, id/space changes and unknown spaces', async () => {
    const d = await db()
    await expect(d.execute(`INSERT INTO todo (priority) VALUES (1.5)`)).rejects.toThrow(/expects integer/)
    await expect(d.execute(`INSERT INTO todo (done) VALUES (7)`)).rejects.toThrow(/expects boolean/)
    await expect(d.execute(`INSERT INTO todo (meta) VALUES ('not json')`)).rejects.toThrow(/JSON/)
    await d.execute(`INSERT INTO todo (id, title) VALUES ('fixed', 'x')`)
    await expect(d.execute(`UPDATE todo SET id = 'other'`)).rejects.toThrow(/cannot be changed/)
    await expect(d.execute(`INSERT INTO todo (space, title) VALUES ('nope', 'x')`)).rejects.toThrow(/unknown or inactive space/)
    expect(await d.execute(`SELECT id FROM todo`)).toEqual([{ id: 'fixed' }])
  })

  it('notifies subscriptions for the tables a query mentions', async () => {
    const d = await db()
    const seen: number[] = []
    const stop = d.subscribe(d.selectFrom('todo').selectAll().where('done', 'is', null), (rows) => seen.push(rows.length))
    await new Promise((r) => setTimeout(r, 10))
    await d.insertInto('todo').values({ title: 'x' }).execute()
    await d.insertInto('tag').values({ name: 'unrelated' }).execute()
    await new Promise((r) => setTimeout(r, 10))
    stop()
    expect(seen).toEqual([0, 1])
  })

  it('supports the sql template tag', async () => {
    const d = await db()
    await d.insertInto('todo').values({ title: 'x', priority: 4 }).execute()
    const r = await sql<{ p: number }>`SELECT priority * 2 AS p FROM todo`.execute(d.db)
    expect(r.rows).toEqual([{ p: 8 }])
  })
})

describe('keys and identity', () => {
  it('stores the identity key by default and can export it', async () => {
    const ks = memoryKeyStore()
    const d = await open(schema, [], { keyStore: ks })
    expect(await ks.get('identity')).toBeTruthy()
    expect(d.exportIdentityKey()).toMatch(/^nsec1/)
  })

  it("recovery mode hands the identity key out once and never stores it", async () => {
    const ks = memoryKeyStore()
    const keys: string[] = []
    const d = await open(schema, [], { keyStore: ks, identity: 'recovery', onRecoveryKey: (k) => keys.push(k) })
    expect(keys).toHaveLength(1)
    expect(await ks.get('identity')).toBeNull()
    expect(() => d.exportIdentityKey()).toThrow(/not stored/)
    await expect(d.nostr.publishNote('x')).rejects.toThrow(/identity key is not on this device/)
    // writes still work: they are signed by the device key
    await d.insertInto('todo').values({ title: 'ok' }).execute()
    await expect(open(schema, [], { identity: 'recovery' })).rejects.toThrow(/onRecoveryKey/)
  })

  it('reopens a persistent database with the same keys', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const file = join(mkdtempSync(join(tmpdir(), 'anodb-')), 'db.sqlite')
    const ks = memoryKeyStore()
    const a = await createAnoDB({ appId: 'p', schema, driver: nodeSqlite(file), keyStore: ks, relays: [] })
    await a.insertInto('todo').values({ title: 'persisted' }).execute()
    const space = a.personalSpace
    await a.close()
    const v2 = defineSchema({ todo: { title: 'text', done: 'boolean', priority: 'integer', meta: 'json', due: 'integer' } })
    const b = await createAnoDB({ appId: 'p', schema: v2, driver: nodeSqlite(file), keyStore: ks, relays: [] })
    onCleanup(() => b.close())
    expect(b.personalSpace).toBe(space)
    expect(await b.selectFrom('todo').select(['title', 'due']).execute()).toEqual([{ title: 'persisted', due: null }])
    // another identity cannot open it
    await expect(createAnoDB({ appId: 'p', schema, driver: nodeSqlite(file), keyStore: memoryKeyStore(), relays: [] })).rejects.toThrow(
      /different identity/,
    )
  })
})
