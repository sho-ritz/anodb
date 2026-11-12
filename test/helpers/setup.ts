import { afterEach } from 'vitest'
import { type AnoDBOptions, createAnoDB } from '../../src/index.js'
import { memoryKeyStore } from '../../src/keystore/memory.js'
import { nodeSqlite } from '../../src/node.js'
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

export async function open<const S extends SchemaDefinition>(
  schema: S,
  relays: MockRelay[] = [],
  extra: Partial<AnoDBOptions<S>> = {},
) {
  const db = await createAnoDB({
    appId: 'test',
    schema,
    driver: nodeSqlite(':memory:'),
    keyStore: memoryKeyStore(),
    relays: relays.map((r) => r.url),
    discoveryRelays: [],
    relayOptions: { reconnectMinMs: 30, reconnectMaxMs: 100, publishTimeoutMs: 500 },
    retryIntervalMs: 100,
    defaultSpace: 'personal', // most suites exercise the private personal space
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
      discoveryRelays: [],
      relayOptions: { reconnectMinMs: 30, reconnectMaxMs: 100, publishTimeoutMs: 500 },
      retryIntervalMs: 100,
      defaultSpace: 'personal',
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
