import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { SqlValue, SqliteDriver } from './types.js'

/** SQLite driver backed by Node's built-in `node:sqlite` (Node 22.13+). Use `':memory:'` for tests. */
export function nodeSqlite(path: string): SqliteDriver {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  const cache = new Map<string, StatementSync>()
  const prepare = (sql: string) => {
    let stmt = cache.get(sql)
    if (!stmt) {
      stmt = db.prepare(sql)
      if (cache.size > 256) cache.clear()
      cache.set(sql, stmt)
    }
    return stmt
  }
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      prepare(sql).run(...(params as SqlValue[]))
    },
    all: <T>(sql: string, params: readonly SqlValue[] = []) => prepare(sql).all(...(params as SqlValue[])) as T[],
    close: () => db.close(),
  }
}
