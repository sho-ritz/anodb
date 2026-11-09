import { type AnoDBOptions, prepare } from './db.js'
import { AnoDBSharing } from './sharing.js'
import type { SchemaDefinition } from './types.js'

/** anoDB database handle: SQL-like API, spaces & sharing, sync. */
export class AnoDB<S extends SchemaDefinition> extends AnoDBSharing<S> {}

export async function createAnoDB<const S extends SchemaDefinition>(opts: AnoDBOptions<S>): Promise<AnoDB<S>> {
  const db = new AnoDB<S>(await prepare(opts))
  await db._init()
  return db
}
