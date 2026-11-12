import { describe, expect, it } from 'vitest'
import { defineSchema, owned } from '../src/index.js'
import { until } from './helpers/mock-relay.js'
import { open, relay, sleep } from './helpers/setup.js'

const schema = defineSchema({
  messages: owned({ text: 'text' }),
  items: { title: 'text', done: 'boolean' },
})
type DB = Awaited<ReturnType<typeof open<typeof schema>>>

/** Bypass the local check, like a modified client would: sign and send arbitrary changes. */
const forge = (db: DB, space: string, changes: Array<[string, string, string, unknown]>) => {
  const d = db as unknown as { sendToSpace: (s: string, t: string, p: unknown) => void; clock: { tick: () => string }; sync?: { flush: () => Promise<void> } }
  d.sendToSpace(space, 'ch', { c: changes.map(([t, r, c, v]) => [t, r, c, v, d.clock.tick()]) })
  void d.sync?.flush()
}

const texts = async (d: DB, space: string) => (await d.selectFrom('messages').select(['id', 'text', 'createdBy', 'updatedBy']).where('space', '=', space).orderBy('text').execute())

async function room() {
  const r = await relay()
  const owner = await open(schema, [r])
  const alice = await open(schema, [r])
  const bob = await open(schema, [r])
  for (const d of [alice, bob]) await d.publishKeyPackage()
  await until(() => alice.status.pendingEvents === 0 && bob.status.pendingEvents === 0)
  const space = await owner.createSpace('room')
  for (const d of [alice, bob]) {
    await owner.invite(space, d.npub, 'writer')
    await until(() => d.invitations().length === 1, 3000, 'invitation')
    await d.acceptInvitation(space)
  }
  await until(() => owner.members(space).length === 3 && alice.members(space).length === 3 && bob.members(space).length === 3, 5000, 'members')
  return { owner, alice, bob, space }
}

describe('owned() tables (createdBy / updatedBy and the row rule)', () => {
  it('fills createdBy / updatedBy from signatures and ids are owned by the writer', async () => {
    const { alice, bob, space } = await room()
    await alice.insertInto('messages').values({ text: 'hi from alice', space }).execute()
    await until(async () => (await texts(bob, space)).length === 1, 4000, 'delivery')
    const [m] = await texts(bob, space)
    expect(m!.id.startsWith(`${alice.pubkey}-`)).toBe(true)
    expect(m).toMatchObject({ createdBy: alice.pubkey, updatedBy: alice.pubkey })
  })

  it('a member cannot edit or delete someone else’s row (local refusal + remote drop)', async () => {
    const { owner, alice, bob, space } = await room()
    await alice.insertInto('messages').values({ text: 'original', space }).execute()
    await until(async () => (await texts(bob, space)).length === 1, 4000, 'delivery')
    const id = (await texts(bob, space))[0]!.id

    await expect(bob.updateTable('messages').set({ text: 'edited by bob' }).where('id', '=', id).execute()).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(bob.deleteFrom('messages').where('id', '=', id).execute()).rejects.toMatchObject({ code: 'unauthorized' })
    expect((await texts(bob, space))[0]!.text).toBe('original')

    // A modified client sends the edit and the delete anyway: every other device drops them.
    forge(bob, space, [
      ['messages', id, 'text', 'edited by bob'],
      ['messages', id, '$deleted', true],
    ])
    await sleep(800)
    for (const d of [owner, alice]) expect((await texts(d, space)).map((m) => m.text)).toEqual(['original'])
  })

  it('cannot impersonate: a row id naming someone else is refused', async () => {
    const { owner, alice, bob, space } = await room()
    await expect(bob.insertInto('messages').values({ id: `${alice.pubkey}-fake`, text: 'I am alice', space }).execute()).rejects.toMatchObject({ code: 'unauthorized' })
    forge(bob, space, [
      ['messages', `${alice.pubkey}-fake`, '$createdAt', Date.now()],
      ['messages', `${alice.pubkey}-fake`, 'text', 'I am alice'],
    ])
    await sleep(800)
    for (const d of [owner, alice]) expect(await texts(d, space)).toEqual([])
  })

  it('admins and the owner may delete (moderate) but not edit other people’s rows', async () => {
    const { owner, alice, space } = await room()
    await alice.insertInto('messages').values({ text: 'spam', space }).execute()
    await until(async () => (await texts(owner, space)).length === 1, 4000, 'delivery')
    const id = (await texts(owner, space))[0]!.id
    await expect(owner.updateTable('messages').set({ text: 'changed' }).where('id', '=', id).execute()).rejects.toMatchObject({ code: 'unauthorized' })
    await owner.deleteFrom('messages').where('id', '=', id).execute()
    await until(async () => (await texts(alice, space)).length === 0, 4000, 'moderated')
  })

  it('plain tables are editable by every writer, with updatedBy telling who', async () => {
    const { alice, bob, space } = await room()
    await alice.insertInto('items').values({ title: 'milk', done: false, space }).execute()
    await until(async () => (await bob.selectFrom('items').selectAll().execute()).length === 1, 4000, 'delivery')
    await bob.updateTable('items').set({ done: true }).where('title', '=', 'milk').execute()
    await until(async () => (await alice.selectFrom('items').select('done').execute())[0]?.done === true, 4000, 'tick')
    const row = (await alice.selectFrom('items').select(['createdBy', 'updatedBy']).execute())[0]!
    expect(row).toEqual({ createdBy: alice.pubkey, updatedBy: bob.pubkey })
  })

  it('a plain writer’s snapshot is not trusted (it could restate anyone’s rows)', async () => {
    const { owner, alice, bob, space } = await room()
    await alice.insertInto('messages').values({ text: 'real', space }).execute()
    await until(async () => (await texts(bob, space)).length === 1, 4000, 'delivery')
    const id = (await texts(bob, space))[0]!.id
    // Bob rewrites Alice's row in his own store and posts a snapshot of it.
    const b = bob as unknown as { store: { transaction: (f: () => void) => void; applyChanges: (s: string, c: unknown[], by?: string) => void }; clock: { tick: () => string }; snapshot: (s: string) => void }
    b.store.transaction(() => b.store.applyChanges(space, [['messages', id, 'text', 'forged via snapshot', b.clock.tick()]], alice.pubkey))
    b.snapshot(space)
    await sleep(1000)
    for (const d of [owner, alice]) expect((await texts(d, space)).map((m) => m.text)).toEqual(['real'])
  })

  it('plain tables still refuse rows created in someone else’s name', async () => {
    const { owner, alice, bob, space } = await room()
    await expect(bob.insertInto('items').values({ id: `${alice.pubkey}-fake`, title: 'by alice?', space }).execute()).rejects.toMatchObject({ code: 'unauthorized' })
    // Without $createdAt the row is never born, even if its other cells are accepted.
    forge(bob, space, [['items', `${alice.pubkey}-fake`, 'title', 'by alice?']])
    await sleep(800)
    for (const d of [owner, alice]) expect(await d.selectFrom('items').selectAll().execute()).toEqual([])
  })
})
