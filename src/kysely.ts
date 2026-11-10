import {
  type ColumnType,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'
import { TypedResultsPlugin } from './result-types.js'
import type { ColumnType as AnoColumnType, JsonColumn, SchemaDefinition, SqlValue, TableDefinition } from './types.js'

type JsonValue<C> = C extends JsonColumn<infer T> ? T : unknown
type SelectTs<C extends AnoColumnType> = C extends 'text'
  ? string
  : C extends 'integer' | 'real'
    ? number
    : C extends 'boolean'
      ? boolean
      : JsonValue<C>
type WriteTs<C extends AnoColumnType> = C extends 'boolean' ? boolean | 0 | 1 : SelectTs<C>

/** Kysely table type for a schema table. Booleans read as `boolean`, JSON as the parsed value. */
export type KyselyTable<D extends TableDefinition> = {
  space: ColumnType<string, string | undefined, never>
  id: ColumnType<string, string | undefined, never>
  createdAt: ColumnType<number | null, never, never>
  updatedAt: ColumnType<number, never, never>
} & { [K in Exclude<keyof D, symbol>]: ColumnType<SelectTs<D[K]> | null, WriteTs<D[K]> | null | undefined, WriteTs<D[K]> | null> }

export type KyselyDatabase<S extends SchemaDefinition> = { -readonly [T in keyof S]: KyselyTable<S[T]> }

/** Implemented by AnoDB: runs SQL through the capture/merge path. */
export interface SqlExecutor {
  /** One statement in its own transaction. */
  execute(sql: string, params: readonly SqlValue[]): Promise<{ rows: Record<string, SqlValue>[]; changedRows: number }>
  begin(): Promise<void>
  /** Statement inside a transaction opened with `begin`. */
  executeInTransaction(sql: string, params: readonly SqlValue[]): { rows: Record<string, SqlValue>[]; changedRows: number }
  commit(): Promise<void>
  rollback(): Promise<void>
}

/** Bind values the way users expect from Kysely: booleans → 0/1, objects → JSON text. */
export function toBindValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' || typeof v === 'number' || v instanceof Uint8Array) return v
  return JSON.stringify(v)
}

class Mutex {
  #p: Promise<void> = Promise.resolve()
  lock(): Promise<() => void> {
    let release!: () => void
    const next = new Promise<void>((r) => (release = r))
    const prev = this.#p
    this.#p = prev.then(() => next)
    return prev.then(() => release)
  }
}

class AnoConnection implements DatabaseConnection {
  inTransaction = false
  constructor(readonly exec: SqlExecutor) {}

  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const params = q.parameters.map(toBindValue)
    const r = this.inTransaction ? this.exec.executeInTransaction(q.sql, params) : await this.exec.execute(q.sql, params)
    return { rows: r.rows as R[], numAffectedRows: BigInt(r.changedRows) }
  }

  async *streamQuery<R>(q: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(q)
  }
}

class AnoDriver implements Driver {
  readonly #conn: AnoConnection
  readonly #mutex = new Mutex()
  #release: (() => void) | null = null
  constructor(exec: SqlExecutor) {
    this.#conn = new AnoConnection(exec)
  }
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    this.#release = await this.#mutex.lock()
    return this.#conn
  }
  async beginTransaction(): Promise<void> {
    await this.#conn.exec.begin()
    this.#conn.inTransaction = true
  }
  async commitTransaction(): Promise<void> {
    this.#conn.inTransaction = false
    await this.#conn.exec.commit()
  }
  async rollbackTransaction(): Promise<void> {
    this.#conn.inTransaction = false
    await this.#conn.exec.rollback()
  }
  async releaseConnection(): Promise<void> {
    const r = this.#release
    this.#release = null
    r?.()
  }
  async destroy(): Promise<void> {}
}

export function createKysely<S extends SchemaDefinition>(exec: SqlExecutor, schema: S): Kysely<KyselyDatabase<S>> {
  const dialect: Dialect = {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new AnoDriver(exec),
    createQueryCompiler: () => new SqliteQueryCompiler(),
    createIntrospector: (db) => new SqliteIntrospector(db),
  }
  return new Kysely<KyselyDatabase<S>>({ dialect, plugins: [new TypedResultsPlugin(schema)] })
}
