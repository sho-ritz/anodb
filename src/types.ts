/** A value SQLite can bind / return. */
export type SqlValue = string | number | null | Uint8Array

/**
 * Minimal synchronous SQLite driver. anoDB keeps every transaction synchronous so a
 * local write is atomic with respect to the JS event loop. In browsers run anoDB in a
 * Worker with a synchronous VFS (e.g. sqlite-wasm OPFS SAH pool) or use sql.js.
 */
export interface SqliteDriver {
  /** Execute one or more statements without parameters. */
  exec(sql: string): void
  /** Execute one statement with parameters, discarding results. */
  run(sql: string, params?: readonly SqlValue[]): void
  /** Execute one statement and return all rows as objects. */
  all<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[]
  close(): void
}

/** SQL flavour of a driver. */
export type SqlDialectName = 'sqlite' | 'postgres'

/**
 * Asynchronous SQL driver (PGlite, Postgres). anoDB serializes all access itself, so the driver
 * only needs one connection. Statements use the dialect's own placeholders (`$1` for Postgres).
 */
export interface AsyncSqlDriver {
  readonly dialect: SqlDialectName
  /** Execute one or more statements without parameters. */
  exec(sql: string): Promise<void>
  /** Execute one statement with parameters; resolves to the number of affected rows. */
  run(sql: string, params?: readonly unknown[]): Promise<number>
  /** Execute one statement and return all rows as objects. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /**
   * Run `fn` inside BEGIN … COMMIT with exclusive use of the connection (a throw rolls back).
   * Implement it when other code shares the connection (PGlite + Prisma) so their statements
   * cannot land inside anoDB's transactions. Without it anoDB issues BEGIN / COMMIT itself.
   */
  transaction?<T>(fn: (tx: AsyncSqlDriver) => Promise<T>): Promise<T>
  /** Change notifications (Postgres LISTEN). Optional: anoDB polls when it is missing. */
  listen?(channel: string, fn: (payload: string) => void): Promise<() => Promise<void>>
  close(): Promise<void>
}

/** Any driver `createAnoDB` accepts. */
export type AnyDriver = SqliteDriver | AsyncSqlDriver

export type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'json'

declare const JSON_TYPE: unique symbol
/** A `json` column with a TypeScript type for its value: `json<{ tags: string[] }>()`. */
export type JsonColumn<T> = 'json' & { readonly [JSON_TYPE]?: T }

export type TableDefinition = Readonly<Record<string, ColumnType>>
export type SchemaDefinition = Readonly<Record<string, TableDefinition>>

/** Overall sync state reported by `db.status`. */
export type SyncState = 'offline' | 'syncing' | 'synced'

export interface SyncStatus {
  state: SyncState
  /** Relays with an open WebSocket. */
  connectedRelays: string[]
  /** Signed events waiting for enough relay acknowledgements. */
  pendingEvents: number
}

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface EventTemplate {
  kind: number
  tags: string[][]
  content: string
  created_at: number
}

/** Freshness of data fetched from the network. */
export type FetchStatus = 'synced' | 'stale' | 'unavailable'
