import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAnoDB, defineSchema } from '../src/index.js'
import { memoryKeyStore } from '../src/keystore/memory.js'
import { nodeSqlite } from '../src/node.js'
import { until } from './helpers/mock-relay.js'
import { onCleanup, open, relay, sleep } from './helpers/setup.js'

const schema = defineSchema({ todo: { title: 'text', done: 'boolean' } })
type DB = Awaited<ReturnType<typeof open<typeof schema>>>
const titles = async (d: DB, space?: string) =>
  (await d.selectFrom('todo').select('title').$if(space !== undefined, (q) => q.where('space', '=', space!)).orderBy('title').execute()).map((r) => r.title)

async function shared(r: Awaited<ReturnType<typeof relay>>) {
  const owner = await open(schema, [r])
  const alice = await open(schema, [r])
  await alice.publishKeyPackage()
  await until(() => alice.status.pendingEvents === 0)
  const space = await owner.createSpace('family')
  return { owner, alice, space }
}

describe('sharing (v0.3)', () => {
  it('invites by npub; nothing syncs until the invitee accepts', async () => {
    const r = await relay()
    const { owner, alice, space } = await shared(r)
    await owner.insertInto('todo').values({ title: 'milk', space }).execute()
    const invited: string[] = []
    alice.onInvitation((i) => invited.push(i.space))
    await owner.invite(space, alice.npub, 'writer')
    await until(() => invited.length === 1, 3000, 'invitation')
    expect(alice.invitations()).toMatchObject([{ space, role: 'writer', name: 'family', from: owner.pubkey }])
    await sleep(100)
    expect(await titles(alice)).toEqual([])

    await alice.acceptInvitation(space)
    await until(async () => (await titles(alice, space)).includes('milk'), 3000, 'snapshot')
    await alice.insertInto('todo').values({ title: 'eggs', space }).execute()
    await until(async () => (await titles(owner, space)).includes('eggs'), 3000, 'alice write reaches owner')
    expect(owner.members(space).map((m) => m.role).sort()).toEqual(['owner', 'writer'])
  })

  it('new members get the current state only, never deleted history', async () => {
    const r = await relay()
    const { owner, alice, space } = await shared(r)
    await owner.insertInto('todo').values({ title: 'TOP-SECRET-DRAFT', space }).execute()
    await owner.deleteFrom('todo').where('title', '=', 'TOP-SECRET-DRAFT').execute()
    await owner.insertInto('todo').values({ title: 'public plan', space }).execute()
    await owner.invite(space, alice.npub, 'writer')
    await until(() => alice.invitations().length === 1)
    await alice.acceptInvitation(space)
    await until(async () => (await titles(alice, space)).includes('public plan'))
    const dump = JSON.stringify(await alice.execute('SELECT * FROM anodb_cells')) + JSON.stringify(await alice.execute('SELECT payload FROM anodb_messages'))
    expect(dump).not.toContain('TOP-SECRET-DRAFT')
  })

  it('readers can read but their writes are rejected locally and remotely', async () => {
    const r = await relay()
    const { owner, alice, space } = await shared(r)
    await owner.invite(space, alice.npub, 'reader')
    await until(() => alice.invitations().length === 1)
    await alice.acceptInvitation(space)
    await owner.insertInto('todo').values({ title: 'visible', space }).execute()
    await until(async () => (await titles(alice, space)).includes('visible'))
    await expect(alice.insertInto('todo').values({ title: 'nope', space }).execute()).rejects.toThrow(/no write permission/)
    // bypass the local check: the owner still rejects the forged write
    const a = alice as unknown as { store: { transaction<T>(f: () => T): T }; sendToSpace(s: string, t: string, b: object): void; clock: { tick(): string } }
    a.store.transaction(() => a.sendToSpace(space, 'ch', { c: [['todo', 'forged', 'title', 'forged', a.clock.tick()]] }))
    await alice.flush()
    await sleep(300)
    expect(await titles(owner, space)).toEqual(['visible'])
  })

  it('removal: cut-off rejects later writes and the removed member cannot read new data', async () => {
    const r = await relay()
    const { owner, alice, space } = await shared(r)
    await owner.invite(space, alice.npub, 'writer')
    await until(() => alice.invitations().length === 1)
    await alice.acceptInvitation(space)
    await alice.insertInto('todo').values({ title: 'before removal', space }).execute()
    await until(async () => (await titles(owner, space)).includes('before removal'))

    await r.stop()
    await until(() => alice.status.state === 'offline')
    await owner.removeMember(space, alice.npub)
    await alice.insertInto('todo').values({ title: 'written after removal', space }).execute()
    await r.start()
    await owner.insertInto('todo').values({ title: 'after rotation', space }).execute()
    await until(() => owner.status.pendingEvents === 0 && alice.status.pendingEvents === 0, 4000)
    await sleep(300)
    expect(await titles(owner, space)).toEqual(['after rotation', 'before removal'])
    expect(await titles(alice, space)).not.toContain('after rotation')
    expect(owner.members(space).map((m) => m.identity)).toEqual([owner.pubkey])
    await until(() => alice.spaces().find((s) => s.id === space)?.status === 'removed', 3000, 'alice notices removal')
  })

  it('invite links: request → approval → automatic join; links are single-use', async () => {
    const r = await relay()
    const owner = await open(schema, [r])
    const bob = await open(schema, [r])
    const eve = await open(schema, [r])
    const space = await owner.createSpace('team')
    await owner.insertInto('todo').values({ title: 'team task', space }).execute()
    const link = await owner.createInviteLink(space, { role: 'writer', expiresInMs: 60_000 })
    // opening your own link (same browser) explains itself instead of waiting forever
    await expect(owner.requestJoin(link, 'me')).rejects.toMatchObject({ code: 'own-invite' })
    const requests: string[] = []
    owner.onJoinRequest((req) => requests.push(req.id))
    await bob.requestJoin(link, 'Bob')
    await until(() => requests.length === 1, 3000, 'join request')
    expect(owner.joinRequests()[0]).toMatchObject({ identity: bob.pubkey, name: 'Bob', role: 'writer' })
    await owner.approveJoinRequest(requests[0]!)
    await until(async () => (await titles(bob, space)).includes('team task'), 4000, 'bob joins')
    // the link is used up: a second requester is ignored
    await eve.requestJoin(link)
    await sleep(300)
    expect(owner.joinRequests()).toEqual([])
    await expect(owner.approveJoinRequest(requests[0]!)).rejects.toThrow()
  })

  it('pairs a new device by QR (identity key is not copied) and revokes a device', async () => {
    const r = await relay()
    const a = await open(schema, [r])
    await a.insertInto('todo').values({ title: 'mine' }).execute()
    const file = join(mkdtempSync(join(tmpdir(), 'anodb-pair-')), 'b.sqlite')
    const ksB = memoryKeyStore()
    const optsB = {
      appId: 'test',
      schema,
      keyStore: ksB,
      relays: [r.url],
      discoveryRelays: [],
      relayOptions: { reconnectMinMs: 30, reconnectMaxMs: 100, publishTimeoutMs: 500 },
      retryIntervalMs: 100,
    }
    const b0 = await createAnoDB({ ...optsB, driver: nodeSqlite(file) })
    const offer = await b0.startPairing()
    const req = a.parsePairing(offer.uri)
    expect(req.code).toBe(offer.code)
    await req.approve('laptop')
    await offer.done
    await b0.close()
    const b = await createAnoDB({ ...optsB, driver: nodeSqlite(file) })
    onCleanup(() => b.close())
    expect(b.pubkey).toBe(a.pubkey)
    expect(await ksB.get('identity')).toBeNull()
    expect(b.personalSpace).toBe(a.personalSpace)
    await until(async () => (await titles(b)).includes('mine'), 4000, 'b catches up')
    await b.insertInto('todo').values({ title: 'from laptop' }).execute()
    await until(async () => (await titles(a)).includes('from laptop'), 3000)
    expect(a.devices().map((d) => d.name).sort()).toEqual(['device', 'laptop'])

    await a.revokeDevice(b.devicePubkey)
    await b.insertInto('todo').values({ title: 'from revoked laptop' }).execute()
    await a.insertInto('todo').values({ title: 'after revoke' }).execute()
    await until(() => a.status.pendingEvents === 0 && b.status.pendingEvents === 0, 4000)
    await sleep(300)
    expect(await titles(a)).not.toContain('from revoked laptop')
    expect(await titles(b)).not.toContain('after revoke')
  })

  it('rotates keys that are older than 30 days on start', async () => {
    const ks = memoryKeyStore()
    const file = join(mkdtempSync(join(tmpdir(), 'anodb-rot-')), 'db.sqlite')
    let offset = 0
    const mk = () => createAnoDB({ appId: 'rot', schema, driver: nodeSqlite(file), keyStore: ks, relays: [], now: () => Date.now() + offset })
    const d1 = await mk()
    const k1 = (d1 as unknown as { keysBySpace: Map<string, Array<{ num: number }>> }).keysBySpace.get(d1.personalSpace)![0]!.num
    await d1.close()
    offset = 31 * 24 * 3600_000
    const d2 = await mk()
    onCleanup(() => d2.close())
    const k2 = (d2 as unknown as { keysBySpace: Map<string, Array<{ num: number }>> }).keysBySpace.get(d2.personalSpace)![0]!.num
    expect(k2).toBe(k1 + 1)
  })
})
