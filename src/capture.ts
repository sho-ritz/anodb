import { SYS_CREATED, SYS_DELETED, quoteIdent } from './schema.js'
import type { Store } from './store.js'
import type { ColumnType, SchemaDefinition } from './types.js'

/**
 * Write capture: user SQL runs against the projection tables with triggers that record every
 * changed cell. The projection changes are then rolled back and the captured cells go through
 * the normal merge path (permissions, types, HLC, encryption, outbox). The database's own parser
 * therefore defines what SQL is accepted.
 *
 * SQLite: TEMP triggers that only fire while `temp.anodb_ctl.capturing = 1`.
 * Postgres: ordinary triggers. Inside anoDB's capture transaction they write to `anodb_cap`; in
 * anoDB's own transactions (`anodb.mode = 'internal'`) they do nothing; for every other writer
 * (Prisma, psql, …) they queue the cells in `anodb_ext` and NOTIFY `anodb_ext`, and anoDB then
 * commits those writes like its own (or restores the rows when they are not allowed).
 */
export interface CapturedCell {
  op: 'i' | 'u' | 'd'
  space: string
  table: string
  rowId: string
  column: string
  value: unknown
}

export const EXTERNAL_CHANNEL = 'anodb_ext'

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`

export async function installCapture(s: Store, schema: SchemaDefinition): Promise<void> {
  if (s.pg) return installPgCapture(s, schema)
  await s.exec(`
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
    await s.exec(`
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

async function installPgCapture(s: Store, schema: SchemaDefinition): Promise<void> {
  for (const [table, def] of Object.entries(schema)) {
    const t = quoteIdent(table)
    const fn = quoteIdent(`anodb_cap_${table}`)
    const cols = Object.keys(def)
    // Values travel as jsonb so one column holds every type; anoDB reads them back as JS values.
    const body = (target: string) => {
      const ins = [
        ...cols.map((c) => `('i', NEW.space, ${lit(table)}, NEW.id, ${lit(c)}, to_jsonb(NEW.${quoteIdent(c)}))`),
        `('i', NEW.space, ${lit(table)}, NEW.id, ${lit(SYS_CREATED)}, NULL)`,
      ]
      const upd = cols.map(
        (c) =>
          `IF NEW.${quoteIdent(c)} IS DISTINCT FROM OLD.${quoteIdent(c)} THEN INSERT INTO ${target} (op, space, tbl, row_id, col, val) VALUES ('u', NEW.space, ${lit(table)}, NEW.id, ${lit(c)}, to_jsonb(NEW.${quoteIdent(c)})); END IF;`,
      )
      return `
      IF TG_OP = 'INSERT' THEN
        INSERT INTO ${target} (op, space, tbl, row_id, col, val) VALUES ${ins.join(', ')};
      ELSIF TG_OP = 'UPDATE' THEN
        ${upd.join('\n        ') || 'NULL;'}
      ELSE
        INSERT INTO ${target} (op, space, tbl, row_id, col, val) VALUES ('d', OLD.space, ${lit(table)}, OLD.id, ${lit(SYS_DELETED)}, to_jsonb(1));
      END IF;`
    }
    await s.exec(`
      CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $anodb$
      DECLARE m text := current_setting('anodb.mode', true);
      BEGIN
        IF m = 'internal' THEN RETURN NULL; END IF;
        IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.space IS DISTINCT FROM OLD.space) THEN
          RAISE EXCEPTION 'anoDB: id and space of a row cannot be changed';
        END IF;
        IF m = 'capture' THEN${body('anodb_cap')}
        ELSE${body('anodb_ext')}
          PERFORM pg_notify('${EXTERNAL_CHANNEL}', ${lit(table)});
        END IF;
        RETURN NULL;
      END
      $anodb$;
      DROP TRIGGER IF EXISTS ${fn} ON ${t};
      CREATE TRIGGER ${fn} AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION ${fn}();
    `)
  }
}

const capTable = (s: Store) => (s.pg ? 'anodb_cap' : 'temp.anodb_cap')

/** Turn capture on inside a capture transaction (`store.capture()`). */
export async function beginCapture(s: Store): Promise<void> {
  if (!s.pg) await s.run('UPDATE temp.anodb_ctl SET capturing = 1')
}

/** Number of cells captured so far. */
export async function capturedCount(s: Store): Promise<number> {
  return Number((await s.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${capTable(s)}`))[0]?.n ?? 0)
}

type CapRow = { op: 'i' | 'u' | 'd'; space: string; tbl: string; row_id: string; col: string; val: unknown }

const toCell = (r: CapRow): CapturedCell => ({ op: r.op, space: r.space, table: r.tbl, rowId: r.row_id, column: r.col, value: r.val })

/** Read the captured cells (the capture transaction is rolled back afterwards by its owner). */
export async function readCaptured(s: Store): Promise<CapturedCell[]> {
  return (await s.all<CapRow>(`SELECT op, space, tbl, row_id, col, val FROM ${capTable(s)} ORDER BY n`)).map(toCell)
}

/** Take queued writes made outside anoDB (Postgres). Run inside a transaction. */
export async function takeExternal(s: Store, limit = 2000): Promise<CapturedCell[]> {
  const rows = await s.all<CapRow & { n: number }>(`SELECT n, op, space, tbl, row_id, col, val FROM anodb_ext ORDER BY n LIMIT ${limit}`)
  if (rows.length === 0) return []
  await s.run('DELETE FROM anodb_ext WHERE n <= ?', [Number(rows[rows.length - 1]!.n)])
  return rows.map(toCell)
}

/**
 * Convert a captured value to the JSON wire value of the column type, or throw. SQLite hands
 * back storage values (0/1, JSON text); Postgres hands back the jsonb-decoded value.
 */
export function fromCaptured(table: string, column: string, type: ColumnType, v: unknown, pg = false): unknown {
  if (v === null || v === undefined) return null
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
      if (pg) {
        if (typeof v !== 'boolean') throw bad()
        return v
      }
      if (v === 0 || v === 1) return v === 1
      throw bad()
    case 'json':
      if (pg) return v
      if (typeof v !== 'string') throw bad()
      try {
        return JSON.parse(v)
      } catch {
        throw new TypeError(`anoDB: ${table}.${column} expects JSON text`)
      }
  }
}
