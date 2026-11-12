import type { ColumnType, JsonColumn, SchemaDefinition, SqlValue, TableDefinition } from './types.js'

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/
export const RESERVED_COLUMNS = new Set(['id', 'space', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'isDeleted'])
const COLUMN_TYPES = new Set<ColumnType>(['text', 'integer', 'real', 'boolean', 'json'])

/** System cells. They travel in the change log like user cells. */
export const SYS_DELETED = '$deleted'
export const SYS_CREATED = '$createdAt'

/**
 * Row ids that name their creator. Default ids are `<64 hex pubkey>-<random>`, so `createdBy` can be
 * read from the id. Nobody can create a row whose id names someone else (checked on every device),
 * so `createdBy` cannot be forged. Ids without that prefix (older data, custom ids) have no creator.
 */
const OWNED_ID = /^([0-9a-f]{64})(?:-[A-Za-z0-9_]{1,63})?$/
export const ownerOfRow = (rowId: string): string | null => OWNED_ID.exec(rowId)?.[1] ?? null

const OWNED: unique symbol = Symbol.for('anodb.owned')

/**
 * Opt-in row-level rule. By default every writer may change or delete any row (like a table
 * without row-level security). In an `owned(...)` table only the row's creator may change it;
 * deleting is also allowed for admins / the owner of a shared space (moderation). Every device
 * enforces it when it applies a change, so a modified client cannot get around it.
 *
 *   defineSchema({ messages: owned({ text: 'text' }) })
 */
export function owned<const T extends TableDefinition>(def: T): T {
  return Object.assign({ ...def }, { [OWNED]: true }) as T
}

export const isOwned = (def: TableDefinition | undefined): boolean => !!def && (def as { [OWNED]?: boolean })[OWNED] === true

/** Bump to rebuild every projection (new system columns). */
const PROJECTION_VERSION = 3

/**
 * A `json` column with a TypeScript type for its value (reads return the parsed value):
 *
 *   defineSchema({ note: { meta: json<{ tags: string[] }>() } })
 */
export function json<T = unknown>(): JsonColumn<T> {
  return 'json' as JsonColumn<T>
}

/** Identity function that validates the schema and keeps literal types for inference. */
export function defineSchema<const S extends SchemaDefinition>(schema: S): S {
  validateSchema(schema)
  return schema
}

export function validateSchema(schema: SchemaDefinition): void {
  for (const [table, columns] of Object.entries(schema)) {
    if (!IDENT.test(table)) throw new Error(`anoDB: invalid table name "${table}"`)
    if (table.toLowerCase().startsWith('anodb')) throw new Error(`anoDB: table name "${table}" is reserved`)
    for (const [column, type] of Object.entries(columns)) {
      if (!IDENT.test(column)) throw new Error(`anoDB: invalid column name "${table}.${column}"`)
      if (RESERVED_COLUMNS.has(column)) throw new Error(`anoDB: column name "${table}.${column}" is reserved`)
      if (!COLUMN_TYPES.has(type)) throw new Error(`anoDB: unknown column type "${type}" for ${table}.${column}`)
    }
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

const SQL_TYPE: Record<ColumnType, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  json: 'TEXT',
}

export function createTableSql(table: string, def: TableDefinition, defaultSpace: string, owner?: string): string {
  const cols = Object.entries(def).map(([c, t]) => `${quoteIdent(c)} ${SQL_TYPE[t]}`)
  const space = `space TEXT NOT NULL DEFAULT '${defaultSpace.replaceAll("'", "''")}'`
  // New rows are owned by the writer: <pubkey>-<random>.
  const id = owner && /^[0-9a-f]{64}$/.test(owner) ? `id TEXT NOT NULL DEFAULT ('${owner}-' || lower(hex(randomblob(8))))` : 'id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))'
  return `CREATE TABLE ${quoteIdent(table)} (${[space, id, ...cols, '"createdAt" INTEGER', '"updatedAt" INTEGER NOT NULL DEFAULT 0', '"createdBy" TEXT', '"updatedBy" TEXT', 'PRIMARY KEY (space, id)'].join(', ')})`
}

/** Stable fingerprint of a table definition; projection is rebuilt when it changes. */
export function tableFingerprint(def: TableDefinition): string {
  return `v${PROJECTION_VERSION}|${isOwned(def) ? 'owned' : 'open'}|${JSON.stringify(Object.entries(def).sort(([a], [b]) => (a < b ? -1 : 1)))}`
}

/** Validate a user value against the column type. Returns the JSON-safe wire value. */
export function checkValue(table: string, column: string, type: ColumnType, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const bad = () => new TypeError(`anoDB: ${table}.${column} expects ${type}, got ${typeof value}`)
  switch (type) {
    case 'text':
      if (typeof value !== 'string') throw bad()
      return value
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw bad()
      return value
    case 'real':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad()
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw bad()
      return value
    case 'json':
      JSON.stringify(value)
      return value
  }
}

/**
 * Convert a wire value (already merged) into what goes into the projection table.
 * Remote peers may send values that do not match our type (schema drift); those become NULL.
 */
export function toSql(type: ColumnType, value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  switch (type) {
    case 'text':
      return typeof value === 'string' ? value : null
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
    case 'real':
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    case 'boolean':
      return typeof value === 'boolean' ? (value ? 1 : 0) : null
    case 'json':
      return JSON.stringify(value)
  }
}

export function fromSql(type: ColumnType, value: SqlValue): unknown {
  if (value === null) return null
  switch (type) {
    case 'boolean':
      return value === 1
    case 'json':
      return JSON.parse(value as string)
    default:
      return value
  }
}
