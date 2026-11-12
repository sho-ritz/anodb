import { describe, expect, it } from 'vitest'
import { defineSchema, owned } from '../src/index.js'
import { until } from './helpers/mock-relay.js'
import { open, relay, sleep } from './helpers/setup.js'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean' },
  posts: owned({ text: 'text' }),
})

const app = { defaultSpace: 'app' } as const

describe('app space (the default: one database for every user of the app)', () => {
  it('two unrelated users read and write the same tables without invites', async () => {
    const r = await relay()
    const a = await open(schema, [r], app)
    const b = await open(schema, [r], app)
    expect(a.appSpace).toBe(b.appSpace)
    expect(a.defaultSpace).toBe(a.appSpace)
    await a.insertInto('todo').values({ title: 'milk', done: false }).execute()
    await until(async () => (await b.selectFrom('todo').selectAll().execute()).length === 1, 4000, 'b sees a')
    // Like a table without RLS: anyone may edit and delete anyone's row.
    await b.updateTable('todo').set({ done: true }).where('title', '=', 'milk').execute()
    await until(async () => (await a.selectFrom('todo').select('done').execute())[0]?.done === true, 4000, 'a sees b')
    const row = (await a.selectFrom('todo').select(['space', 'createdBy', 'updatedBy']).execute())[0]!
    expect(row).toEqual({ space: a.appSpace, createdBy: a.pubkey, updatedBy: b.pubkey })
    await b.deleteFrom('todo').execute()
    await until(async () => (await a.selectFrom('todo').selectAll().execute()).length === 0, 4000, 'delete')
  })

  it('owned() tables keep rows editable only by their creator', async () => {
    const r = await relay()
    const a = await open(schema, [r], app)
    const b = await open(schema, [r], app)
    await a.insertInto('posts').values({ text: 'hello' }).execute()
    await until(async () => (await b.selectFrom('posts').selectAll().execute()).length === 1, 4000, 'delivery')
    await expect(b.updateTable('posts').set({ text: 'hacked' }).execute()).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(b.deleteFrom('posts').execute()).rejects.toMatchObject({ code: 'unauthorized' })
    await a.updateTable('posts').set({ text: 'edited' }).execute()
    await until(async () => (await b.selectFrom('posts').select('text').execute())[0]?.text === 'edited', 4000, 'own edit')
  })

  it('is not listed as a space, has no members and stays separate per appId', async () => {
    const r = await relay()
    const a = await open(schema, [r], app)
    const other = await open(schema, [r], { ...app, appId: 'another-app' })
    expect(a.spaces().some((s) => s.id === a.appSpace)).toBe(false)
    await expect(a.invite(a.appSpace, other.npub, 'writer')).rejects.toThrow(/app space/)
    expect(other.appSpace).not.toBe(a.appSpace)
    await a.insertInto('todo').values({ title: 'only in test' }).execute()
    await sleep(600)
    expect(await other.selectFrom('todo').selectAll().execute()).toEqual([])
  })

  it('personal and shared spaces stay private next to it', async () => {
    const r = await relay()
    const a = await open(schema, [r], app)
    const b = await open(schema, [r], app)
    await a.insertInto('todo').values({ title: 'secret', space: a.personalSpace }).execute()
    await a.insertInto('todo').values({ title: 'public' }).execute()
    await until(async () => (await b.selectFrom('todo').selectAll().execute()).length === 1, 4000, 'public row')
    await sleep(300)
    expect((await b.selectFrom('todo').select('title').execute()).map((t) => t.title)).toEqual(['public'])
  })
})
