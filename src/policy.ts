import type { Role } from './membership.js'
import type { Change } from './protocol.js'
import { SYS_CREATED, SYS_DELETED, isOwned, ownerOfRow } from './schema.js'
import type { SchemaDefinition } from './types.js'

/**
 * Row-level write rule, evaluated identically by every device when it applies a change (local or
 * remote). A change that fails it is ignored everywhere, so the shared state cannot contain it.
 *
 * - Always: a row id that names an identity can only be *created* by that identity (so
 *   `createdBy` cannot be forged).
 * - Plain tables (default): any writer may change or delete any row, like a database without RLS.
 * - `owned(...)` tables: only the creator may change a row; deleting is also allowed for admins /
 *   the owner of the space (moderation). Admins cannot edit other people's rows.
 */
export function changeAllowed(schema: SchemaDefinition, c: Change, writer: string, role: Role | undefined): boolean {
  const [table, rowId, column] = c
  const owner = ownerOfRow(rowId)
  if (owner === null || owner === writer) return true
  if (column === SYS_CREATED) return false
  if (!isOwned(schema[table])) return true
  if (column === SYS_DELETED) return role === 'owner' || role === 'admin'
  return false
}

/** Message for a local write that the rule refuses. */
export const policyMessage = (c: Change) =>
  c[2] === SYS_DELETED
    ? `anoDB: ${c[0]} is owned(): only the member who created this row (or an admin) can delete it`
    : `anoDB: ${c[0]} is owned(): only the member who created this row can change it`
