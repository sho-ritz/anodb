import { RTCPeerConnection } from 'node-datachannel/polyfill'
import { describe, expect, it } from 'vitest'
import { WRAP_KIND, defineSchema } from '../src/index.js'
import { until } from './helpers/mock-relay.js'
import { open, pairedDevice, relay, sleep } from './helpers/setup.js'

const schema = defineSchema({ todo: { title: 'text' } })
const p2p = { rtc: { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection }, iceServers: [] }
type DB = Awaited<ReturnType<typeof open<typeof schema>>>
const titles = async (d: DB) => (await d.selectFrom('todo').select('title').orderBy('title').execute()).map((r) => r.title)
const directTo = (a: DB, b: DB) => a.p2pPeers().some((p) => p.device === b.devicePubkey && p.transport === 'direct')

describe('direct WebRTC sync between own devices', () => {
  it('delivers changes peer-to-peer even when relays do not carry them', async () => {
    const r = await relay()
    const a = await open(schema, [r], { p2p })
    const b = (await pairedDevice(a, schema, [r], { p2p })).db // pairing uses relays
    await until(() => directTo(a, b) && directTo(b, a), 15000, 'direct connection')
    r.opts.dropKinds = [WRAP_KIND] // from now on relays forward WebRTC signaling only
    expect(a.p2pMode).toBe('own-devices')
    await a.insertInto('todo').values({ title: 'via webrtc' }).execute()
    await until(async () => (await titles(b)).includes('via webrtc'), 5000, 'p2p delivery')
  }, 30000)

  it('skips relays when every device acknowledged; falls back to relays when one is offline', async () => {
    const r = await relay()
    const a = await open(schema, [r], { p2p })
    const dev = await pairedDevice(a, schema, [r], { p2p })
    await until(() => directTo(a, dev.db) && directTo(dev.db, a), 15000, 'direct connection')
    await until(() => a.status.pendingEvents === 0)
    const before = new Set(r.received.map((e) => e.id))
    await a.insertInto('todo').values({ title: 'both online' }).execute()
    await until(async () => (await titles(dev.db)).includes('both online'))
    await until(() => a.status.pendingEvents === 0, 4000, 'acknowledged')
    await sleep(300)
    expect(r.received.filter((e) => !before.has(e.id) && e.kind === WRAP_KIND)).toHaveLength(0) // never hit a relay

    await dev.db.close()
    await until(() => !directTo(a, dev.db), 20000, 'peer gone')
    const before2 = new Set(r.received.map((e) => e.id))
    await a.insertInto('todo').values({ title: 'b offline' }).execute()
    await until(() => r.received.some((e) => !before2.has(e.id) && e.kind === WRAP_KIND), 5000, 'relay fallback')
    const b2 = await dev.reopen()
    await until(async () => (await titles(b2)).includes('b offline'), 5000, 'offline device catches up from relay')
  }, 40000)

  it('stays off without WebRTC (Node default) and can be disabled', async () => {
    const r = await relay()
    expect((await open(schema, [r])).p2pMode).toBe('off')
    expect((await open(schema, [r], { p2p: { ...p2p, mode: 'off' } })).p2pMode).toBe('off')
  })
})
