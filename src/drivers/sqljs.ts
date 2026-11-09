import type { SqlValue, SqliteDriver } from '../types.js'

/** The subset of a sql.js `Database` that anoDB uses (structural, so sql.js is not a dependency). */
export interface SqlJsDatabase {
  exec(sql: string): unknown
  run(sql: string, params?: SqlValue[]): unknown
  prepare(sql: string): {
    bind(params: SqlValue[]): boolean
    step(): boolean
    getAsObject(): Record<string, SqlValue>
    free(): boolean
  }
  close(): void
}

/**
 * Wrap a sql.js database (WASM, works in any browser / runtime). sql.js keeps the database in
 * memory: persist it yourself with `db.export()` if you need durability.
 */
export function sqlJsDriver(db: SqlJsDatabase): SqliteDriver {
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => void db.run(sql, [...params]),
    all: <T>(sql: string, params: readonly SqlValue[] = []) => {
      const stmt = db.prepare(sql)
      try {
        if (params.length) stmt.bind([...params])
        const rows: T[] = []
        while (stmt.step()) rows.push(stmt.getAsObject() as T)
        return rows
      } finally {
        stmt.free()
      }
    },
    close: () => db.close(),
  }
}
