// A TypeScript device and a Rust device (crates/anodb-engine/examples/peer.rs) share spaces through
// a relay: each invites the other, and writes from both sides arrive on both sides.
//   cargo build -p anodb-engine --example peer && ANODB_RUST_PEER=target/debug/examples/peer npx vitest run test/rust-interop.test.ts
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { defineSchema } from '../src/index.js'
import { until } from './helpers/mock-relay.js'
import { open, relay } from './helpers/setup.js'

const PEER = process.env.ANODB_RUST_PEER
const schema = defineSchema({ todo: { title: 'text', done: 'boolean' } })

class Peer {
  readonly #p: ChildProcessWithoutNullStreams
  readonly #lines: AsyncIterator<string>
  constructor(bin: string) {
    this.#p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.#lines = createInterface({ input: this.#p.stdout })[Symbol.asyncIterator]()
  }
  async call<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    this.#p.stdin.write(`${JSON.stringify({ cmd, ...args })}\n`)
    const { value } = await this.#lines.next()
    const r = JSON.parse(value as string) as { ok?: T; error?: string }
    if (r.error !== undefined) throw new Error(`rust peer: ${cmd}: ${r.error}`)
    return r.ok as T
  }
  close(): void {
    this.#p.kill()
  }
}

let peer: Peer | null = null
afterEach(() => {
  peer?.close()
  peer = null
})

describe.skipIf(!PEER)('interop with the Rust engine', () => {
  it('shares spaces both ways through a relay', async () => {
    const r = await relay()
    const ts = await open(schema, [r])
    peer = new Peer(PEER!)
    const rs = await peer.call<{ pubkey: string; delegation: unknown }>('hello')
    const sync = () => peer!.call<{ rejected: unknown[] }>('sync', { relay: r.url })
    const titles = async (space: string) =>
      (await ts.selectFrom('todo').select('title').where('space', '=', space).orderBy('title').execute()).map((x) => x.title)

    // TypeScript owns a space and invites the Rust device.
    const family = await ts.createSpace('Family')
    await ts.insertInto('todo').values({ space: family, title: 'milk' }).execute()
    await ts.addMember(family, rs.pubkey, 'writer', { devices: [rs.delegation as never] })
    await until(() => ts.status.pendingEvents === 0, 5000, 'ts published')
    await sync()
    const inv = await peer.call<Array<{ space: string; role: string; from: string }>>('invitations')
    expect(inv).toEqual([expect.objectContaining({ space: family, role: 'writer', from: ts.pubkey })])
    await peer.call('accept', { space: family })
    await sync()
    expect(await peer.call('titles', { space: family })).toEqual(['milk'])

    // The Rust device writes; TypeScript sees it.
    await peer.call('insert', { space: family, table: 'todo', values: { title: 'eggs' } })
    expect((await sync()).rejected).toEqual([])
    await until(async () => (await titles(family)).includes('eggs'), 5000, 'ts sees the rust write')

    // Rust owns a space and invites the TypeScript identity.
    const garage = await peer.call<string>('create_space', { name: 'Garage' })
    await peer.call('insert', { space: garage, table: 'todo', values: { title: 'from rust' } })
    await peer.call('add_member', { space: garage, identity: ts.pubkey, role: 'writer', delegations: ts.deviceDelegations() })
    expect((await sync()).rejected).toEqual([])
    await until(() => ts.invitations().some((i) => i.space === garage), 5000, 'ts invitation')
    expect(ts.invitations().find((i) => i.space === garage)).toMatchObject({ name: 'Garage', role: 'writer', from: rs.pubkey })
    await ts.acceptInvitation(garage)
    await until(async () => (await titles(garage)).includes('from rust'), 5000, 'ts catches up from the rust snapshot')
    expect(ts.roleIn(garage)).toBe('writer')

    // TypeScript writes in the Rust-owned space; Rust sees it.
    await ts.insertInto('todo').values({ space: garage, title: 'from ts' }).execute()
    await until(() => ts.status.pendingEvents === 0, 5000, 'ts published')
    await sync()
    expect(await peer.call('titles', { space: garage })).toEqual(['from rust', 'from ts'])
  }, 30_000)
})
