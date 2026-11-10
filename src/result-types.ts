import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from 'kysely'
import type { ColumnType, SchemaDefinition } from './types.js'

/**
 * Typed results for Kysely queries: `boolean` columns read as `true / false` and `json` columns as
 * parsed values instead of SQLite's 0 / 1 and JSON text. The output type of each column is worked
 * out from the query tree (tables, aliases, selections), so JOINs and aliases work. Expressions
 * (functions, sub-queries) and raw SQL strings keep SQLite values.
 */

type Node = { kind: string; [k: string]: unknown }
type Converter = (row: Record<string, unknown>) => Record<string, unknown>

const name = (n: unknown): string | undefined => {
  const node = n as Node | undefined
  if (!node) return undefined
  if (node.kind === 'IdentifierNode') return node.name as string
  if (node.kind === 'SchemableIdentifierNode') return name(node.identifier)
  if (node.kind === 'TableNode') return name(node.table)
  if (node.kind === 'ColumnNode') return name(node.column)
  return undefined
}

/** alias (or table name) → schema table, from FROM / JOIN / INTO / UPDATE targets. */
function sources(schema: SchemaDefinition, nodes: unknown[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of nodes) {
    const n = raw as Node | undefined
    if (!n) continue
    if (n.kind === 'TableNode') {
      const t = name(n)
      if (t && t in schema) out.set(t, t)
    } else if (n.kind === 'AliasNode' && (n.node as Node).kind === 'TableNode') {
      const t = name(n.node)
      const alias = name(n.alias)
      if (t && alias && t in schema) out.set(alias, t)
    }
  }
  return out
}

function columnTypes(schema: SchemaDefinition, src: Map<string, string>, selections: unknown[] | undefined): Map<string, ColumnType> {
  const out = new Map<string, ColumnType>()
  const typeOf = (column: string, table?: string): ColumnType | undefined => {
    if (table !== undefined) {
      const t = src.get(table)
      return t ? schema[t]![column] : undefined
    }
    const found = new Set<ColumnType>()
    for (const t of src.values()) {
      const c = schema[t]![column]
      if (c) found.add(c)
    }
    return found.size === 1 ? [...found][0] : undefined
  }
  const allOf = (table?: string) => {
    const tables = table !== undefined ? [src.get(table)].filter((t): t is string => !!t) : [...src.values()]
    for (const t of tables) for (const [c, type] of Object.entries(schema[t]!)) out.set(c, type)
  }
  const ref = (n: Node, as?: string) => {
    if (n.kind === 'ColumnNode') {
      const c = name(n)!
      const type = typeOf(c)
      if (type) out.set(as ?? c, type)
    } else if (n.kind === 'ReferenceNode') {
      const table = n.table ? name(n.table) : undefined
      const col = n.column as Node
      if (col.kind === 'SelectAllNode') {
        if (!as) allOf(table)
        return
      }
      const c = name(col)!
      const type = typeOf(c, table)
      if (type) out.set(as ?? c, type)
    } else if (n.kind === 'SelectAllNode' && !as) {
      allOf()
    }
  }
  for (const s of selections ?? []) {
    const sel = ((s as Node).selection ?? s) as Node
    if (sel.kind === 'AliasNode') {
      const inner = sel.node as Node
      // Only plain column references keep their type through an alias.
      out.delete(name(sel.alias)!)
      ref(inner, name(sel.alias))
    } else ref(sel)
  }
  return out
}

/** Builds the row converter for one query, or null when nothing needs converting. */
export function resultConverter(schema: SchemaDefinition, node: RootOperationNode): Converter | null {
  const n = node as unknown as Node
  let types: Map<string, ColumnType>
  if (n.kind === 'SelectQueryNode') {
    const froms = ((n.from as Node | undefined)?.froms as unknown[]) ?? []
    const joins = ((n.joins as Node[] | undefined) ?? []).map((j) => j.table)
    types = columnTypes(schema, sources(schema, [...froms, ...joins]), n.selections as unknown[])
  } else if (n.kind === 'InsertQueryNode' || n.kind === 'UpdateQueryNode' || n.kind === 'DeleteQueryNode') {
    const returning = n.returning as Node | undefined
    if (!returning) return null
    const targets =
      n.kind === 'InsertQueryNode' ? [n.into] : n.kind === 'UpdateQueryNode' ? [n.table] : (((n.from as Node | undefined)?.froms as unknown[]) ?? [])
    types = columnTypes(schema, sources(schema, targets), returning.selections as unknown[])
  } else return null
  const convert = [...types].filter(([, t]) => t === 'boolean' || t === 'json')
  if (convert.length === 0) return null
  return (row) => {
    const out: Record<string, unknown> = { ...row }
    for (const [col, type] of convert) {
      if (!(col in out)) continue
      const v = out[col]
      if (type === 'boolean') {
        if (typeof v === 'number') out[col] = v !== 0
      } else if (typeof v === 'string') {
        try {
          out[col] = JSON.parse(v)
        } catch {
          // leave non-JSON text as is
        }
      }
    }
    return out
  }
}

export class TypedResultsPlugin implements KyselyPlugin {
  readonly #pending = new WeakMap<object, Converter>()
  constructor(readonly schema: SchemaDefinition) {}

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const conv = resultConverter(this.schema, args.node)
    if (conv) this.#pending.set(args.queryId, conv)
    return args.node
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const conv = this.#pending.get(args.queryId)
    if (!conv) return args.result
    this.#pending.delete(args.queryId)
    return { ...args.result, rows: args.result.rows.map((r) => conv(r) as UnknownRow) }
  }
}
