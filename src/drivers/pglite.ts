import type { AsyncSqlDriver } from '../types.js'

interface PGliteQueries {
  exec(sql: string): Promise<unknown>
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>
}

/** The subset of a PGlite instance that anoDB uses (structural, so PGlite is not a dependency). */
export interface PGliteLike extends PGliteQueries {
  transaction<T>(fn: (tx: PGliteQueries) => Promise<T>): Promise<T>
  listen?(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>
  close(): Promise<void>
  readonly closed?: boolean
}

export interface PGliteDriverOptions {
  /**
   * Close the PGlite instance when the database closes. Default true; pass false when the instance
   * is shared with other code (Prisma, Drizzle…) that keeps using it.
   */
  close?: boolean
}

function statements(q: PGliteQueries): Pick<AsyncSqlDriver, 'exec' | 'run' | 'all'> {
  return {
    exec: async (sql) => {
      await q.exec(sql)
    },
    run: async (sql, params = []) => (await q.query(sql, [...params])).affectedRows ?? 0,
    all: async <T>(sql: string, params: readonly unknown[] = []) => (await q.query<T>(sql, [...params])).rows,
  }
}

/**
 * PGlite (Postgres in WASM) driver. User tables are real Postgres tables (`boolean`, `jsonb`,
 * `bigint`…), so other tools can read and write them through the same PGlite instance; writes
 * that bypass anoDB are picked up by triggers and synced like anoDB's own.
 *
 *   const pg = await PGlite.create('./anodb-data')
 *   const db = await createAnoDB({ appId, schema, driver: pgliteDriver(pg) })
 */
export function pgliteDriver(pg: PGliteLike, opts: PGliteDriverOptions = {}): AsyncSqlDriver {
  const driver: AsyncSqlDriver = {
    dialect: 'postgres',
    ...statements(pg),
    // PGlite's own transaction lock keeps other users of the instance out until it ends.
    transaction: (fn) => pg.transaction((tx) => fn({ dialect: 'postgres', ...statements(tx), close: async () => {} })),
    close: async () => {
      if (opts.close !== false && !pg.closed) await pg.close()
    },
  }
  if (pg.listen) driver.listen = (channel, fn) => pg.listen!(channel, fn)
  return driver
}
