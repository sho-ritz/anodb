import { afterEach } from 'vitest'
import { type AnoDBOptions, createAnoDB } from '../../src/index.js'
import { memoryKeyStore } from '../../src/keystore/memory.js'
import { nodeSqlite } from '../../src/node.js'
import { pgDriver } from '../../src/drivers/pg.js'
import { pgliteDriver } from '../../src/drivers/pglite.js'
import type { SchemaDefinition } from '../../src/types.js'
import { MockRelay } from './mock-relay.js'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

export function onCleanup(fn: () => unknown): void {
  cleanup.push(fn)
}

export async function relay(opts?: ConstructorParameters<typeof MockRelay>[0]): Promise<MockRelay> {
  const r = await new MockRelay(opts).start()
  cleanup.push(() => r.stop())
  return r
}

/** Admin connection for `ANODB_TEST_DRIVER=pg` (the Docker Postgres of `npm run test:pg`). */
export const TEST_PG_URL = process.env.ANODB_TEST_PG_URL ?? 'postgres://app:app@127.0.0.1:5432/postgres'

/** A new, empty database on the test Postgres server (dropped after the test). */
export async function freshPgDatabase(): Promise<string> {
  const { default: pg } = await import('pg')
  const name = `anodb_test_${Math.random().toString(36).slice(2, 12)}`
  const admin = new pg.Client({ connectionString: TEST_PG_URL })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  cleanup.push(async () => {
    const c = new pg.Client({ connectionString: TEST_PG_URL })
    await c.connect()
    try {
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    } finally {
      await c.end()
    }
  })
  const url = new URL(TEST_PG_URL)
  url.pathname = `/${name}`
  return url.toString()
}

/** A pool on `url`, ended after the test. */
export async function pgPool(url: string) {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: url, max: 5 })
  cleanup.push(() => (pool.ended ? undefined : pool.end()))
  return pool
}

/**
 * Default storage for `open()`: node:sqlite, PGlite with `ANODB_TEST_DRIVER=pglite`, or a fresh
 * database on a Postgres server with `ANODB_TEST_DRIVER=pg` (`npm run test:pglite` / `test:pg` run
 * the whole suite on Postgres).
 */
async function defaultDriver() {
  if (process.env.ANODB_TEST_DRIVER === 'pg') return pgDriver(await pgPool(await freshPgDatabase()))
  if (process.env.ANODB_TEST_DRIVER !== 'pglite') return nodeSqlite(':memory:')
  const { PGlite } = await import('@electric-sql/pglite')
  return pgliteDriver(await PGlite.create())
}

export async function open<const S extends SchemaDefinition>(
  schema: S,
  relays: MockRelay[] = [],
  extra: Partial<AnoDBOptions<S>> = {},
) {
  const db = await createAnoDB({
    appId: 'test',
    schema,
    driver: extra.driver ?? (await defaultDriver()),
    keyStore: memoryKeyStore(),
    relays: relays.map((r) => r.url),
    relayOptions: { reconnectMinMs: 30, reconnectMaxMs: 100, publishTimeoutMs: 500 },
    retryIntervalMs: 100,
    ...extra,
  })
  cleanup.push(() => db.close())
  return db
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A second device of `a`'s identity via real QR pairing, backed by a file so it can be reopened
 * after pairing (as apps do). Returns `{ db, reopen }`.
 */
export async function pairedDevice<const S extends SchemaDefinition>(
  a: { parsePairing(uri: string): { approve(name?: string): Promise<void> } },
  schema: S,
  relays: MockRelay[],
  extra: Partial<AnoDBOptions<S>> = {},
) {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const file = join(mkdtempSync(join(tmpdir(), 'anodb-dev-')), 'db.sqlite')
  const keyStore = memoryKeyStore()
  const mk = async () => {
    const d = await createAnoDB({
      appId: 'test',
      schema,
      driver: nodeSqlite(file),
      keyStore,
      relays: relays.map((r) => r.url),
        relayOptions: { reconnectMinMs: 30, reconnectMaxMs: 100, publishTimeoutMs: 500 },
      retryIntervalMs: 100,
      ...extra,
    })
    cleanup.push(() => d.close())
    return d
  }
  const fresh = await mk()
  const offer = await fresh.startPairing()
  await a.parsePairing(offer.uri).approve('paired')
  await offer.done
  await fresh.close()
  return { db: await mk(), reopen: mk }
}
