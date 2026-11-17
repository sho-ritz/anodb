import { describe, expect, it } from 'vitest'
import { defineSchema } from '../src/index.js'
import type { SpaceEvent } from '../src/index.js'
import { until } from './helpers/mock-relay.js'
import { open, relay, sleep } from './helpers/setup.js'

const schema = defineSchema({ notes: { text: 'text' } })

async function pair() {
  const r = await relay()
  const a = await open(schema, [r])
  const b = await open(schema, [r])
  const outsider = await open(schema, [r])
  await b.publishKeyPackage()
  await until(() => b.status.pendingEvents === 0)
  const space = await a.createSpace('room')
  await a.addMember(space, b.npub, 'reader')
  await until(() => b.invitations().length === 1, 3000, 'invitation')
  await b.acceptInvitation(space)
  await until(() => b.members(space).length === 2, 3000, 'members')
  return { r, a, b, outsider, space }
}

describe('ephemeral events', () => {
  it('reach online members with the sender identity; not stored, not echoed', async () => {
    const { a, b, space } = await pair()
    const gotB: SpaceEvent[] = []
    const gotA: SpaceEvent[] = []
    b.onEvent((e) => gotB.push(e), { space, type: 'typing' })
    a.onEvent((e) => gotA.push(e), { space })
    await sleep(200)
    await a.emit(space, 'typing', { on: true })
    await until(() => gotB.length === 1, 3000, 'delivery')
    expect(gotB[0]).toMatchObject({ space, type: 'typing', data: { on: true }, from: a.pubkey })
    // readers may send events too (typing indicators, read cursors)
    await b.emit(space, 'typing', { on: false })
    await until(() => gotA.length === 1, 3000, 'reply')
    expect(gotA[0]!.from).toBe(b.pubkey)
    await sleep(200)
    expect(gotB).toHaveLength(1) // b does not hear its own event
    // nothing reached the database
    expect(await a.execute('SELECT COUNT(*) AS n FROM anodb_messages WHERE type NOT IN (?, ?)', ['op', 'snap'])).toEqual([{ n: 0 }])
  })

  it('outsiders can neither send to nor read a space', async () => {
    const { a, outsider, space } = await pair()
    await expect(outsider.emit(space, 'typing')).rejects.toThrow(/not a member/)
    const heard: SpaceEvent[] = []
    outsider.onEvent((e) => heard.push(e))
    await sleep(200)
    await a.emit(space, 'typing')
    await sleep(500)
    expect(heard).toEqual([])
  })

  it('a removed member stops receiving after the key rotation', async () => {
    const { a, b, space } = await pair()
    const heard: SpaceEvent[] = []
    b.onEvent((e) => heard.push(e), { space })
    await a.removeMember(space, b.pubkey)
    await sleep(2500) // lets b's subscription notice the space change
    await a.emit(space, 'typing')
    await sleep(500)
    expect(heard).toEqual([])
  })
})
