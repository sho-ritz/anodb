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

export type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'json'

export type TableDefinition = Readonly<Record<string, ColumnType>>
export type SchemaDefinition = Readonly<Record<string, TableDefinition>>

type ColumnTs<C extends ColumnType> = C extends 'text'
  ? string
  : C extends 'integer' | 'real'
    ? number
    : C extends 'boolean'
      ? boolean
      : unknown

/** Columns a user may write. Every column is nullable because cells merge independently. */
export type Writable<T extends TableDefinition> = { [K in keyof T]?: ColumnTs<T[K]> | null }

/** A row as read from the local projection. */
export type Row<T extends TableDefinition> = { id: string; createdAt: number | null; updatedAt: number } & {
  [K in keyof T]: ColumnTs<T[K]> | null
}

export type SortDirection = 'asc' | 'desc'

export interface FindOptions<T extends TableDefinition> {
  /** Equality match per column. `null` matches SQL NULL. */
  where?: { [K in keyof Row<T>]?: Row<T>[K] }
  orderBy?: { [K in keyof Row<T>]?: SortDirection }
  limit?: number
  offset?: number
}

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
