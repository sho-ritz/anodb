import type { ColumnType, SchemaDefinition, SqlValue, TableDefinition } from './types.js'

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/
export const RESERVED_COLUMNS = new Set(['id', 'createdAt', 'updatedAt', 'isDeleted'])
const COLUMN_TYPES = new Set<ColumnType>(['text', 'integer', 'real', 'boolean', 'json'])

/** System cells. They travel in the change log like user cells. */
export const SYS_DELETED = '$deleted'
export const SYS_CREATED = '$createdAt'

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

export function createTableSql(table: string, def: TableDefinition): string {
  const cols = Object.entries(def).map(([c, t]) => `${quoteIdent(c)} ${SQL_TYPE[t]}`)
  return `CREATE TABLE ${quoteIdent(table)} (id TEXT PRIMARY KEY, ${[...cols, '"createdAt" INTEGER', '"updatedAt" INTEGER NOT NULL'].join(', ')})`
}

/** Stable fingerprint of a table definition; projection is rebuilt when it changes. */
export function tableFingerprint(def: TableDefinition): string {
  return JSON.stringify(Object.entries(def).sort(([a], [b]) => (a < b ? -1 : 1)))
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
