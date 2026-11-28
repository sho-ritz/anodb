import {
  type ColumnType,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'
import { Mutex } from './mutex.js'
import { TypedResultsPlugin } from './result-types.js'
import type { ColumnType as AnoColumnType, JsonColumn, SchemaDefinition, SqlDialectName, TableDefinition } from './types.js'

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
  /** Identity (pubkey) that created the row, from the row id — cannot be forged. Null for rows with custom ids. */
  createdBy: ColumnType<string | null, never, never>
  /** Identity whose signed change last touched the row. */
  updatedBy: ColumnType<string | null, never, never>
} & { [K in Exclude<keyof D, symbol>]: ColumnType<SelectTs<D[K]> | null, WriteTs<D[K]> | null | undefined, WriteTs<D[K]> | null> }

export type KyselyDatabase<S extends SchemaDefinition> = { -readonly [T in keyof S]: KyselyTable<S[T]> }

/** Implemented by AnoDB: runs SQL through the capture/merge path. */
export interface SqlExecutor {
  /** One statement in its own transaction. */
  execute(sql: string, params: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; changedRows: number }>
  begin(): Promise<void>
  /** Statement inside a transaction opened with `begin`. */
  executeInTransaction(sql: string, params: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; changedRows: number }>
  commit(): Promise<void>
  rollback(): Promise<void>
}

/**
 * Bind values the way users expect from Kysely. SQLite: booleans → 0/1, objects → JSON text.
 * Postgres: booleans stay booleans (native columns), objects → JSON text (cast by jsonb columns).
 */
export function toBindValue(v: unknown, pg = false): unknown {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return pg ? v : v ? 1 : 0
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' || typeof v === 'number' || v instanceof Uint8Array) return v
  return JSON.stringify(v)
}

class AnoConnection implements DatabaseConnection {
  inTransaction = false
  constructor(
    readonly exec: SqlExecutor,
    readonly pg: boolean,
  ) {}

  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const params = q.parameters.map((v) => toBindValue(v, this.pg))
    const r = this.inTransaction ? await this.exec.executeInTransaction(q.sql, params) : await this.exec.execute(q.sql, params)
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
  constructor(exec: SqlExecutor, pg: boolean) {
    this.#conn = new AnoConnection(exec, pg)
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

export function createKysely<S extends SchemaDefinition>(exec: SqlExecutor, schema: S, sqlDialect: SqlDialectName = 'sqlite'): Kysely<KyselyDatabase<S>> {
  const pg = sqlDialect === 'postgres'
  const dialect: Dialect = {
    createAdapter: () => (pg ? new PostgresAdapter() : new SqliteAdapter()),
    createDriver: () => new AnoDriver(exec, pg),
    createQueryCompiler: () => (pg ? new PostgresQueryCompiler() : new SqliteQueryCompiler()),
    createIntrospector: (db) => (pg ? new PostgresIntrospector(db) : new SqliteIntrospector(db)),
  }
  // Postgres returns booleans and parsed jsonb already; SQLite needs the typed-results plugin.
  return new Kysely<KyselyDatabase<S>>({ dialect, plugins: pg ? [] : [new TypedResultsPlugin(schema)] })
}
