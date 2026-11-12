import type { Role } from './membership.js'
import type { Change } from './protocol.js'
import { SYS_CREATED, SYS_DELETED, isShared, ownerOfRow } from './schema.js'
import type { SchemaDefinition } from './types.js'

/**
 * Row-level write rule, evaluated identically by every device when it applies a change (local or
 * remote). A change that fails it is ignored everywhere, so the shared state cannot contain it.
 *
 * - Owned row (id starts with an identity): only that identity may create it or change its cells.
 *   Deleting is also allowed for admins / the owner of the space (moderation). Admins cannot edit
 *   other people's rows.
 * - `shared(...)` tables: any writer may change any row, but a row id that names an identity can
 *   still only be *created* by that identity (so `createdBy` cannot be forged).
 * - Rows without an identity prefix: any writer (createdBy is null).
 * - Tables this app version does not know follow the owned-row rule (the strict one).
 */
export function changeAllowed(schema: SchemaDefinition, c: Change, writer: string, role: Role | undefined): boolean {
  const [table, rowId, column] = c
  const def = schema[table]
  const owner = ownerOfRow(rowId)
  if (owner === null || owner === writer) return true
  if (column === SYS_CREATED) return false
  if (def && isShared(def)) return true
  if (column === SYS_DELETED) return role === 'owner' || role === 'admin'
  return false
}

/** Message for a local write that the rule refuses. */
export const policyMessage = (c: Change) =>
  c[2] === SYS_DELETED
    ? `anoDB: only the member who created this ${c[0]} row (or an admin) can delete it`
    : `anoDB: only the member who created this ${c[0]} row can change it`
