import initSqlJs from 'sql.js'
import { describe, expect, it } from 'vitest'
import { createAnoDB, defineSchema, sqlJsDriver } from '../src/index.js'
import { nodeSqlite } from '../src/node.js'
import type { SqliteDriver } from '../src/types.js'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean', priority: 'integer', meta: 'json' },
})

const SQL = await initSqlJs()
const drivers: Array<[string, () => SqliteDriver]> = [
  ['node:sqlite', () => nodeSqlite(':memory:')],
  ['sql.js', () => sqlJsDriver(new SQL.Database())],
]

describe.each(drivers)('local database (%s)', (_name, makeDriver) => {
  const open = (driver = makeDriver()) => createAnoDB({ appId: 'test', schema, driver, relays: [] })

  it('inserts, updates, deletes and queries with types preserved', () => {
    const db = open()
    const todos = db.table('todo')
    const a = todos.insert({ title: 'buy milk', done: false, priority: 2, meta: { tags: ['x'] } })
    const b = todos.insert({ title: 'write code', done: true, priority: 1 })
    expect(todos.findById(a)).toMatchObject({ id: a, title: 'buy milk', done: false, priority: 2, meta: { tags: ['x'] } })
    expect(todos.findById(a)?.createdAt).toBeTypeOf('number')

    todos.update(a, { done: true })
    expect(todos.findMany({ where: { done: true }, orderBy: { priority: 'asc' } }).map((r) => r.id)).toEqual([b, a])
    expect(todos.count()).toBe(2)

    todos.delete(b)
    expect(todos.findMany().map((r) => r.id)).toEqual([a])
    expect(db.sql<{ n: number }>('SELECT COUNT(*) AS n FROM todo')[0]!.n).toBe(1)
    db.close()
  })

  it('validates types, tables and columns', () => {
    const db = open()
    const todos = db.table('todo')
    expect(() => todos.insert({ title: 1 as unknown as string })).toThrow(/expects text/)
    expect(() => todos.insert({ priority: 1.5 })).toThrow(/expects integer/)
    expect(() => todos.insert({ nope: 1 } as never)).toThrow(/unknown column/)
    expect(() => db.table('nope' as 'todo')).toThrow(/unknown table/)
    expect(() => db.sql('DELETE FROM todo')).toThrow(/read-only/)
    db.close()
  })

  it('rolls back the whole transaction if any write throws', () => {
    const db = open()
    expect(() =>
      db.transaction((tx) => {
        tx.insert('todo', { title: 'ok' })
        tx.insert('todo', { title: 5 as unknown as string })
      }),
    ).toThrow()
    expect(db.table('todo').count()).toBe(0)
    db.close()
  })

  it('notifies subscribers', () => {
    const db = open()
    const seen: number[] = []
    const unsub = db.table('todo').subscribe({ where: { done: false } }, (rows) => seen.push(rows.length))
    const id = db.table('todo').insert({ title: 'a', done: false })
    db.table('todo').update(id, { done: true })
    unsub()
    db.table('todo').insert({ title: 'b', done: false })
    expect(seen).toEqual([0, 1, 0])
    db.close()
  })
})

describe('schema evolution', () => {
  it('rebuilds the projection from cells when columns are added', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const file = join(mkdtempSync(join(tmpdir(), 'anodb-')), 'db.sqlite')

    const v1 = defineSchema({ note: { body: 'text' } })
    const db1 = createAnoDB({ appId: 'evo', schema: v1, driver: nodeSqlite(file), relays: [] })
    const id = db1.table('note').insert({ body: 'hello' })
    const key = db1.exportSecretKey()
    db1.close()

    const v2 = defineSchema({ note: { body: 'text', pinned: 'boolean' }, tag: { name: 'text' } })
    const db2 = createAnoDB({ appId: 'evo', schema: v2, driver: nodeSqlite(file), relays: [], secretKey: key })
    expect(db2.table('note').findById(id)).toMatchObject({ body: 'hello', pinned: null })
    db2.table('note').update(id, { pinned: true })
    expect(db2.table('note').findById(id)?.pinned).toBe(true)
    db2.close()
  })

  it('refuses to open a database with a different owner key', () => {
    const driver = nodeSqlite(':memory:')
    const db = createAnoDB({ appId: 'x', schema, driver, relays: [] })
    void db
    const other = createAnoDB({ appId: 'x', schema, driver: nodeSqlite(':memory:'), relays: [] }).exportSecretKey()
    expect(() => createAnoDB({ appId: 'x', schema, driver, relays: [], secretKey: other })).toThrow(/different owner/)
  })
})
