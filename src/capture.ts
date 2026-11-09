import { SYS_CREATED, SYS_DELETED, quoteIdent } from './schema.js'
import type { ColumnType, SchemaDefinition, SqlValue, SqliteDriver } from './types.js'

/**
 * Write capture: user SQL runs against the projection tables with TEMP triggers that record every
 * changed cell. The projection changes are then rolled back and the captured cells go through
 * the normal merge path (permissions, types, HLC, encryption, outbox). SQLite's own parser
 * therefore defines what SQL is accepted.
 */
export interface CapturedCell {
  op: 'i' | 'u' | 'd'
  space: string
  table: string
  rowId: string
  column: string
  value: SqlValue
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`

export function installCapture(db: SqliteDriver, schema: SchemaDefinition): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS anodb_cap (n INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, space TEXT, tbl TEXT, row_id TEXT, col TEXT, val);
    CREATE TEMP TABLE IF NOT EXISTS anodb_ctl (k INTEGER PRIMARY KEY CHECK (k = 1), capturing INTEGER NOT NULL);
    INSERT OR IGNORE INTO anodb_ctl (k, capturing) VALUES (1, 0);
  `)
  for (const [table, def] of Object.entries(schema)) {
    const t = quoteIdent(table)
    const name = (kind: string) => quoteIdent(`anodb_${kind}_${table}`)
    const when = 'WHEN (SELECT capturing FROM temp.anodb_ctl) = 1'
    const cols = Object.keys(def)
    const insRows = [
      ...cols.map((c) => `('i', NEW.space, ${lit(table)}, NEW.id, ${lit(c)}, NEW.${quoteIdent(c)})`),
      `('i', NEW.space, ${lit(table)}, NEW.id, ${lit(SYS_CREATED)}, NULL)`,
    ]
    const updStmts = cols.map(
      (c) =>
        `INSERT INTO anodb_cap (op, space, tbl, row_id, col, val) SELECT 'u', NEW.space, ${lit(table)}, NEW.id, ${lit(c)}, NEW.${quoteIdent(c)} WHERE NEW.${quoteIdent(c)} IS NOT OLD.${quoteIdent(c)};`,
    )
    db.exec(`
      DROP TRIGGER IF EXISTS temp.${name('ins')};
      DROP TRIGGER IF EXISTS temp.${name('upd')};
      DROP TRIGGER IF EXISTS temp.${name('del')};
      CREATE TEMP TRIGGER ${name('ins')} AFTER INSERT ON main.${t} ${when} BEGIN
        INSERT INTO anodb_cap (op, space, tbl, row_id, col, val) VALUES ${insRows.join(', ')};
      END;
      CREATE TEMP TRIGGER ${name('upd')} AFTER UPDATE ON main.${t} ${when} BEGIN
        SELECT RAISE(ABORT, 'anoDB: id and space of a row cannot be changed') WHERE NEW.id IS NOT OLD.id OR NEW.space IS NOT OLD.space;
        ${updStmts.join('\n        ')}
      END;
      CREATE TEMP TRIGGER ${name('del')} AFTER DELETE ON main.${t} ${when} BEGIN
        INSERT INTO anodb_cap (op, space, tbl, row_id, col, val) VALUES ('d', OLD.space, ${lit(table)}, OLD.id, ${lit(SYS_DELETED)}, 1);
      END;
    `)
  }
}

/** Start a capture transaction. Projection changes made until `endCapture` are rolled back. */
export function beginCapture(db: SqliteDriver): void {
  db.exec('BEGIN IMMEDIATE')
  db.run('UPDATE temp.anodb_ctl SET capturing = 1')
}

/** Read captured cells and roll the projection back. */
export function endCapture(db: SqliteDriver): CapturedCell[] {
  try {
    db.run('UPDATE temp.anodb_ctl SET capturing = 0')
    return db
      .all<{ op: 'i' | 'u' | 'd'; space: string; tbl: string; row_id: string; col: string; val: SqlValue }>(
        'SELECT op, space, tbl, row_id, col, val FROM temp.anodb_cap ORDER BY n',
      )
      .map((r) => ({ op: r.op, space: r.space, table: r.tbl, rowId: r.row_id, column: r.col, value: r.val }))
  } finally {
    db.exec('ROLLBACK')
    db.run('DELETE FROM temp.anodb_cap')
    db.run('UPDATE temp.anodb_ctl SET capturing = 0')
  }
}

/** Convert a captured SQLite value to the JSON wire value of the column type, or throw. */
export function fromCaptured(table: string, column: string, type: ColumnType, v: SqlValue): unknown {
  if (v === null) return null
  const bad = () => new TypeError(`anoDB: ${table}.${column} expects ${type}, got ${v instanceof Uint8Array ? 'blob' : typeof v}`)
  switch (type) {
    case 'text':
      if (typeof v !== 'string') throw bad()
      return v
    case 'integer':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad()
      return v
    case 'real':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw bad()
      return v
    case 'boolean':
      if (v === 0 || v === 1) return v === 1
      throw bad()
    case 'json':
      if (typeof v !== 'string') throw bad()
      try {
        return JSON.parse(v)
      } catch {
        throw new TypeError(`anoDB: ${table}.${column} expects JSON text`)
      }
  }
}
