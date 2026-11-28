import type { AsyncSqlDriver } from '../types.js'

interface PgField {
  name: string
  dataTypeID: number
}

interface PgResult {
  rows: Record<string, unknown>[]
  rowCount: number | null
  fields?: PgField[]
}

interface PgQueryable {
  query(config: { text: string; values?: unknown[] }): Promise<PgResult | PgResult[]>
}

interface PgNotification {
  channel: string
  payload?: string
}

/** A client checked out of the pool (`pool.connect()`). */
export interface PgClientLike extends PgQueryable {
  release(err?: Error | boolean): void
  // node-postgres types `on` as one generic signature (the listener's argument depends on the
  // event); a union of events with an `any` argument keeps a real PoolClient assignable.
  on(event: 'notification' | 'error', listener: (arg: any) => void): unknown
  removeListener(event: 'notification', listener: (arg: any) => void): unknown
}

/** The subset of a node-postgres `Pool` that anoDB uses (structural, so `pg` is not a dependency). */
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>
  end(): Promise<void>
  readonly ended?: boolean
}

export interface PgDriverOptions {
  /** End the pool when the database closes. Default true; pass false when other code shares it. */
  close?: boolean
}

const INT8 = 20

/** node-postgres returns BIGINT as strings; anoDB's BIGINT columns hold safe integers, like PGlite returns them. */
function rowsOf(res: PgResult | PgResult[]): Record<string, unknown>[] {
  const r = Array.isArray(res) ? res[res.length - 1] : res
  if (!r) return []
  const ints = (r.fields ?? []).filter((f) => f.dataTypeID === INT8).map((f) => f.name)
  if (ints.length === 0) return r.rows
  for (const row of r.rows) for (const k of ints) if (typeof row[k] === 'string') row[k] = Number(row[k])
  return r.rows
}

function statements(q: PgQueryable): Pick<AsyncSqlDriver, 'exec' | 'run' | 'all'> {
  return {
    // No parameters: the simple query protocol, which accepts several statements.
    exec: async (sql) => {
      await q.query({ text: sql })
    },
    run: async (sql, params = []) => {
      const res = await q.query({ text: sql, values: [...params] })
      return (Array.isArray(res) ? res[res.length - 1]?.rowCount : res.rowCount) ?? 0
    },
    all: async <T>(sql: string, params: readonly unknown[] = []) => rowsOf(await q.query({ text: sql, values: [...params] })) as T[],
  }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * PostgreSQL server driver (node-postgres). anoDB's tables are ordinary Postgres tables, so other
 * tools on the same database (Prisma, TypeORM, Drizzle, psql) can read them; their writes to them
 * are picked up by triggers and synced like anoDB's own.
 *
 *   import pg from 'pg'
 *   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
 *   const db = await createAnoDB({ appId, schema, driver: pgDriver(pool) })
 *
 * Transactions run on one client checked out of the pool; change notifications (LISTEN) hold
 * another one, so give the pool at least 3 connections.
 */
export function pgDriver(pool: PgPoolLike, opts: PgDriverOptions = {}): AsyncSqlDriver {
  const listeners = new Set<() => Promise<void>>()
  return {
    dialect: 'postgres',
    ...statements(pool),
    transaction: async (fn) => {
      const client = await pool.connect()
      let broken: Error | undefined
      try {
        await client.query({ text: 'BEGIN' })
        try {
          const result = await fn({ dialect: 'postgres', ...statements(client), close: async () => {} })
          await client.query({ text: 'COMMIT' })
          return result
        } catch (e) {
          await client.query({ text: 'ROLLBACK' }).catch((err: Error) => (broken = err))
          throw e
        }
      } finally {
        // A client whose ROLLBACK failed is discarded instead of going back to the pool.
        client.release(broken ?? false)
      }
    },
    listen: async (channel, fn) => {
      const client = await pool.connect()
      const onNote = (m: PgNotification) => {
        if (m.channel === channel) fn(m.payload ?? '')
      }
      // A dropped connection only stops notifications; anoDB also polls for outside writes.
      client.on('error', () => {})
      client.on('notification', onNote)
      await client.query({ text: `LISTEN ${quote(channel)}` })
      let done = false
      const stop = async () => {
        if (done) return
        done = true
        listeners.delete(stop)
        client.removeListener('notification', onNote)
        await client.query({ text: `UNLISTEN ${quote(channel)}` }).catch(() => {})
        client.release()
      }
      listeners.add(stop)
      return stop
    },
    close: async () => {
      for (const stop of [...listeners]) await stop()
      if (opts.close !== false && !pool.ended) await pool.end()
    },
  }
}
