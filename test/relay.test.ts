import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { defineSchema } from '../src/index.js'
import { ANODB_KINDS, RelayCore, type RelayConn } from '../src/relay/core.js'
import { DELEGATION_KIND, KEY_PACKAGE_KIND } from '../src/identity.js'
import { EVENT_KIND } from '../src/events.js'
import { EVENT_KIND as P2P_SIGNAL_KIND } from 'nostr-p2p'
import { optionsFromEnv } from '../src/relay/worker.js'
import { WRAP_KIND } from '../src/protocol.js'
import { until } from './helpers/mock-relay.js'
import { NodeRelay, nodeRelaySql } from './helpers/node-relay.js'
import { onCleanup, open, sleep } from './helpers/setup.js'
import { DatabaseSync } from 'node:sqlite'

const schema = defineSchema({ todo: { title: 'text', done: 'boolean' } })

async function startRelay(file?: string) {
  const r = await new NodeRelay(file).start()
  onCleanup(() => r.stop())
  return r
}

/** A raw protocol client: collects every message, `next(pred)` waits for one. */
async function client(url: string) {
  const ws = new WebSocket(url)
  await new Promise((r) => ws.once('open', r))
  const got: unknown[][] = []
  ws.on('message', (m) => got.push(JSON.parse(m.toString()) as unknown[]))
  onCleanup(() => ws.close())
  return {
    send: (...m: unknown[]) => ws.send(JSON.stringify(m)),
    got,
    next: async (pred: (m: unknown[]) => boolean) => {
      await until(() => got.some(pred), 3000, 'relay message')
      return got.find(pred)!
    },
  }
}

const sk = generateSecretKey()
const ev = (kind: number, tags: string[][] = [], content = '', created_at = Math.floor(Date.now() / 1000), key = sk) =>
  finalizeEvent({ kind, tags, content, created_at }, key)

describe('self-hosted relay (Worker engine)', () => {
  it('stores, queries and streams events; rejects bad signatures and foreign kinds', async () => {
    const r = await startRelay()
    const c = await client(r.url)
    const a = ev(WRAP_KIND, [['t', 'tag1']], 'a', 100)
    const b = ev(WRAP_KIND, [['t', 'tag2']], 'b', 200)
    c.send('EVENT', a)
    c.send('EVENT', b)
    expect(await c.next((m) => m[0] === 'OK' && m[1] === b.id)).toEqual(['OK', b.id, true, ''])
    c.send('EVENT', a)
    expect((await c.next((m) => m[0] === 'OK' && m[1] === a.id && m[3] !== ''))[3]).toMatch(/^duplicate/)
    c.send('EVENT', { ...ev(WRAP_KIND), content: 'tampered' })
    expect((await c.next((m) => m[0] === 'OK' && m[2] === false))[3]).toMatch(/^invalid/)
    const note = ev(1, [], 'hello')
    c.send('EVENT', note)
    expect(await c.next((m) => m[0] === 'OK' && m[1] === note.id)).toMatchObject(['OK', note.id, false, expect.stringMatching(/^blocked/)])

    // Tag filter, newest first, limit, EOSE, then live delivery.
    c.send('REQ', 's1', { kinds: [WRAP_KIND], '#t': ['tag1', 'tag2'], limit: 1 })
    await c.next((m) => m[0] === 'EOSE' && m[1] === 's1')
    expect(c.got.filter((m) => m[0] === 'EVENT' && m[1] === 's1').map((m) => (m[2] as { id: string }).id)).toEqual([b.id])
    const live = ev(WRAP_KIND, [['t', 'tag2']], 'live')
    const other = await client(r.url)
    other.send('EVENT', live)
    expect((await c.next((m) => m[0] === 'EVENT' && (m[2] as { id: string }).id === live.id))[1]).toBe('s1')
    c.send('CLOSE', 's1')
    await sleep(50)
    const after = ev(WRAP_KIND, [['t', 'tag2']], 'after close')
    other.send('EVENT', after)
    await other.next((m) => m[0] === 'OK' && m[1] === after.id)
    await sleep(50)
    expect(c.got.some((m) => m[0] === 'EVENT' && (m[2] as { id: string }).id === after.id)).toBe(false)
  })

  it('NIP-09 deletions, replaceable key packages and ephemeral events', async () => {
    const r = await startRelay()
    const c = await client(r.url)
    const e = ev(WRAP_KIND, [['t', 'x']])
    c.send('EVENT', e)
    await c.next((m) => m[0] === 'OK' && m[1] === e.id)
    // Someone else's deletion is ignored; the author's removes it and blocks re-publishing.
    const foreign = ev(5, [['e', e.id]], '', undefined, generateSecretKey())
    c.send('EVENT', foreign)
    await c.next((m) => m[0] === 'OK' && m[1] === foreign.id)
    c.send('REQ', 'q1', { ids: [e.id] })
    await c.next((m) => m[0] === 'EOSE' && m[1] === 'q1')
    expect(c.got.some((m) => m[1] === 'q1' && m[0] === 'EVENT')).toBe(true)
    const del = ev(5, [['e', e.id], ['k', String(WRAP_KIND)]])
    c.send('EVENT', del)
    await c.next((m) => m[0] === 'OK' && m[1] === del.id)
    c.send('REQ', 'q2', { ids: [e.id] })
    await c.next((m) => m[0] === 'EOSE' && m[1] === 'q2')
    expect(c.got.some((m) => m[1] === 'q2' && m[0] === 'EVENT')).toBe(false)
    c.send('EVENT', e)
    expect((await c.next((m) => m[0] === 'OK' && m[1] === e.id && m[2] === false))[3]).toMatch(/deleted/)

    const k1 = ev(10304, [], 'old', 100)
    const k2 = ev(10304, [], 'new', 200)
    c.send('EVENT', k2)
    c.send('EVENT', k1)
    await c.next((m) => m[0] === 'OK' && m[1] === k1.id)
    c.send('REQ', 'kp', { kinds: [10304] })
    await c.next((m) => m[0] === 'EOSE' && m[1] === 'kp')
    expect(c.got.filter((m) => m[1] === 'kp' && m[0] === 'EVENT').map((m) => (m[2] as { content: string }).content)).toEqual(['new'])

    const sub = await client(r.url)
    sub.send('REQ', 'eph', { kinds: [27303] })
    await sub.next((m) => m[0] === 'EOSE')
    const eph = ev(27303, [['t', 'x']], 'typing…')
    c.send('EVENT', eph)
    await sub.next((m) => m[0] === 'EVENT' && (m[2] as { id: string }).id === eph.id)
    sub.send('REQ', 'eph2', { kinds: [27303] })
    await sub.next((m) => m[0] === 'EOSE' && m[1] === 'eph2')
    expect(sub.got.some((m) => m[1] === 'eph2' && m[0] === 'EVENT')).toBe(false) // never stored
  })

  it('subscriptions survive Durable Object hibernation', async () => {
    const r = await startRelay()
    const c = await client(r.url)
    c.send('REQ', 'live', { kinds: [WRAP_KIND], '#t': ['h'] })
    await c.next((m) => m[0] === 'EOSE')
    r.hibernate()
    const e = ev(WRAP_KIND, [['t', 'h']])
    const w = await client(r.url)
    w.send('EVENT', e)
    await c.next((m) => m[0] === 'EVENT' && m[1] === 'live' && (m[2] as { id: string }).id === e.id)
  })

  it('limits and NIP-11 info; env options', () => {
    const sent: string[] = []
    const conn: RelayConn = { id: 'c', send: (m) => sent.push(m) }
    const core = new RelayCore(nodeRelaySql(new DatabaseSync(':memory:')), () => [conn], { maxSubscriptions: 2 })
    core.handle(conn, JSON.stringify(['REQ', 'a', {}]))
    core.handle(conn, JSON.stringify(['REQ', 'b', {}]))
    core.handle(conn, JSON.stringify(['REQ', 'c', {}]))
    core.handle(conn, JSON.stringify(['REQ', 'a', { kinds: [1] }])) // replacing an existing one is fine
    expect(sent.map((m) => JSON.parse(m)[0])).toEqual(['EOSE', 'EOSE', 'CLOSED', 'EOSE'])
    core.handle(conn, JSON.stringify(['REQ', 'd', { kinds: 'x' }]))
    core.handle(conn, 'nope')
    expect(sent.slice(-2).map((m) => JSON.parse(m)[0])).toEqual(['CLOSED', 'NOTICE'])
    expect(core.info()).toMatchObject({ supported_nips: [1, 9, 11, 77], limitation: { restricted_writes: true, max_subscriptions: 2 } })
    expect(optionsFromEnv({ RELAY_KINDS: '*' }).kinds).toBeNull()
    expect(optionsFromEnv({ RELAY_KINDS: '1, 7303' }).kinds).toEqual([1, 7303])
    expect(optionsFromEnv({}).kinds).toBeUndefined()
    expect([...ANODB_KINDS].sort()).toEqual([5, WRAP_KIND, DELEGATION_KIND, KEY_PACKAGE_KIND, P2P_SIGNAL_KIND, EVENT_KIND, 27305].sort())
  })

  it('anoDB apps sync through it, reconcile with NIP-77, and keep data across relay restarts', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'anodb-relay-')), 'relay.sqlite')
    let r = await startRelay(file)
    const relays = () => ({ relays: [r.url] })
    const owner = await open(schema, [], relays())
    const alice = await open(schema, [], relays())
    await alice.publishKeyPackage()
    await until(() => alice.status.pendingEvents === 0, 5000, 'key package')
    const space = await owner.createSpace('family')
    await owner.insertInto('todo').values({ title: 'milk', done: false, space }).execute()
    await owner.addMember(space, alice.npub, 'writer')
    await until(() => alice.invitations().some((i) => i.space === space), 5000, 'invitation')
    await until(() => owner.status.pendingEvents === 0, 5000, 'owner flushed')
    expect(await owner.reconcile(r.url)).toBe(true) // NIP-77 is supported
    await owner.close()

    // Redeploy: a new process on the same storage (same port, so clients reconnect).
    const port = Number(new URL(r.url).port)
    await r.stop()
    r = await new NodeRelay(file).start(port)
    onCleanup(() => r.stop())

    // The owner is gone; everything alice gets now comes from the relay's storage.
    await alice.acceptInvitation(space)
    await until(async () => (await alice.selectFrom('todo').select('title').where('space', '=', space).execute()).length === 1, 8000, 'data from storage')
  })
})

/** Against a real deployment: `ANODB_RELAY_URL=wss://… npx vitest run test/relay.test.ts` (or ws://localhost:8787 for `relay dev`). */
describe.runIf(process.env.ANODB_RELAY_URL)('deployed relay', () => {
  const url = process.env.ANODB_RELAY_URL!
  it('serves NIP-11 and syncs two anoDB apps, with NIP-77', async () => {
    const info = (await (await fetch(url.replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' } })).json()) as { supported_nips: number[] }
    expect(info.supported_nips).toContain(77)
    const owner = await open(schema, [], { relays: [url] })
    const alice = await open(schema, [], { relays: [url] })
    await alice.publishKeyPackage()
    await until(() => alice.status.pendingEvents === 0, 10000, 'key package')
    const space = await owner.createSpace('family')
    await owner.insertInto('todo').values({ title: 'milk', done: false, space }).execute()
    await owner.addMember(space, alice.npub, 'writer')
    await until(() => alice.invitations().some((i) => i.space === space), 10000, 'invitation')
    await alice.acceptInvitation(space)
    await until(async () => (await alice.selectFrom('todo').select('title').where('space', '=', space).execute()).length === 1, 10000, 'snapshot')
    await alice.insertInto('todo').values({ title: 'eggs', done: false, space }).execute()
    await until(async () => (await owner.selectFrom('todo').select('title').where('space', '=', space).execute()).length === 2, 10000, 'live write')
    await until(() => owner.status.pendingEvents === 0, 10000, 'flushed')
    expect(await owner.reconcile(url)).toBe(true)
  }, 60_000)
})
