import { type Selectable, sql, type Transaction } from 'kysely'
import type { AnoDBCore } from './db.js'
import type { KyselyDatabase } from './kysely.js'
import { authorityOf } from './schema.js'
import type { SchemaDefinition } from './types.js'

type Tables<S extends SchemaDefinition> = Extract<keyof S, string>

export interface ServeRequestsOptions<S extends SchemaDefinition, R extends Tables<S>, O extends Tables<S>> {
  /** Table clients write their requests to (an ordinary or `owned(...)` table). */
  requests: R
  /** `confirmed(...)` table this identity is the authority of. Its row id is the request's id. */
  results: O
  /**
   * Decide one request inside a transaction and return the result row's columns (without
   * `id` / `space`). Everything written through `trx` (stock, remaining seats…) commits together
   * with the result, and requests are decided one at a time, so constraints checked here hold.
   * Return a result for refusals too (e.g. `{ status: 'rejected' }`); a throw leaves the request
   * undecided — it is retried on the next change and reported to `onError`.
   */
  handle: (request: Selectable<KyselyDatabase<S>[R]>, trx: Transaction<KyselyDatabase<S>>) => Promise<Record<string, unknown>>
  onError?: (error: unknown, request: { id: string; space: string }) => void
}

export interface RequestServer {
  /** Resolves once every request received so far has been decided (or failed). */
  drain(): Promise<void>
  stop(): void
}

/**
 * Server-confirmed writes: run this on the authority of a `confirmed(...)` table. It picks up
 * requests that have no result yet (including those written while it was offline), decides them
 * one by one in a transaction, and writes the result to the request's space, so only that space's
 * members (the requester and the server) receive it. A result row is written in the same commit as
 * the decision, so a request is never decided twice, even across restarts.
 *
 * Clients show a request as "waiting" while it is still unsent (`db.status.pendingEvents`),
 * as "checking" while there is no result row, and then the result.
 */
export function serveRequests<S extends SchemaDefinition, R extends Tables<S>, O extends Tables<S>>(
  db: AnoDBCore<S>,
  opts: ServeRequestsOptions<S, R, O>,
): RequestServer {
  const authority = authorityOf(db.schema[opts.results])
  if (!authority) throw new Error(`anoDB: serveRequests: ${opts.results} is not a confirmed() table`)
  if (authority !== db.pubkey) throw new Error(`anoDB: serveRequests: this identity is not the authority of ${opts.results}`)
  if (!db.schema[opts.requests]) throw new Error(`anoDB: serveRequests: unknown table ${opts.requests}`)
  const k = db.db
  const req = sql.table(opts.requests)
  const res = sql.table(opts.results)
  let running: Promise<void> | null = null
  let again = false
  let stopped = false
  const failed = new Set<string>()

  const pending = async () =>
    (
      await sql<{ id: string; space: string }>`SELECT r.id, r.space FROM ${req} r LEFT JOIN ${res} o ON o.id = r.id AND o.space = r.space WHERE o.id IS NULL ORDER BY r."createdAt", r.id`.execute(
        k,
      )
    ).rows

  const pass = async () => {
    do {
      again = false
      for (const r of await pending()) {
        if (stopped) return
        const key = `${r.space}\u0000${r.id}`
        try {
          await decideRow(r.id, r.space)
          failed.delete(key)
        } catch (e) {
          // Report a failing request once until it succeeds; other requests still go through.
          if (!failed.has(key)) {
            failed.add(key)
            opts.onError?.(e, r)
          }
        }
      }
    } while (again && !stopped)
  }

  const decideRow = async (id: string, space: string) => {
    await k.transaction().execute(async (trx) => {
      const done = await sql`SELECT 1 FROM ${res} WHERE id = ${id} AND space = ${space}`.execute(trx)
      if (done.rows.length > 0) return
      const row = (await sql<Record<string, unknown>>`SELECT * FROM ${req} WHERE id = ${id} AND space = ${space}`.execute(trx)).rows[0]
      if (!row) return
      const { id: _i, space: _s, ...cols } = await opts.handle(row as never, trx)
      await (trx as unknown as Transaction<Record<string, Record<string, unknown>>>)
        .insertInto(opts.results)
        .values({ ...cols, id, space })
        .execute()
    })
  }

  const kick = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (running) {
      again = true
      return running
    }
    running = pass().finally(() => {
      running = null
    })
    return running
  }

  const off = db.onChange((tables) => {
    if (tables.has(opts.requests)) void kick()
  })
  void kick()
  return {
    drain: async () => {
      while (running) await running
      await kick()
    },
    stop: () => {
      stopped = true
      off()
    },
  }
}
