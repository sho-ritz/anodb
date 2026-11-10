import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { bytesToHex, signWith, verifySignedEvent } from './crypto.js'
import { isEvent } from './identity.js'
import type { NostrEvent } from './types.js'

/** Kind of the device proof exchanged over WebRTC (never published). */
const PROOF_KIND = 27305

export type P2PMode = 'own-devices' | 'members' | 'off'

export interface P2POptions {
  /**
   * `'own-devices'` (default where WebRTC exists): your own devices sync directly with each other.
   * `'members'`: also connect directly to other members of shared spaces — they learn your IP address.
   * `'off'`: relays only.
   */
  mode?: P2PMode
  /** WebRTC implementation outside browsers, e.g. `{ RTCPeerConnection }` from node-datachannel/polyfill. */
  rtc?: { RTCPeerConnection: typeof RTCPeerConnection }
  iceServers?: RTCIceServer[]
  /** How long a new change waits for acknowledgements from all devices before also going to relays. Default 2000 ms. */
  graceMs?: number
}

/** What the database provides to the P2P layer. */
export interface P2PHost {
  appId: string
  relays: () => string[]
  deviceSk: Uint8Array
  devicePubkey: string
  /** Spaces that should have a room, with their current epoch key. */
  rooms: () => Array<{ space: string; keyId: string; key: Uint8Array }>
  /** Devices allowed in a space's room (active, not revoked; includes this device). */
  allowedDevices: (space: string) => Set<string>
  /** Deliver an envelope received from a peer; returns true if it was valid. */
  ingest: (envelope: NostrEvent) => boolean
  /** All devices acknowledged a held envelope: drop it from the outbox, keep it local. */
  delivered: (entryId: string) => void
  /** Not everyone acknowledged in time: send it to relays. */
  release: (entryId: string) => void
}

interface NostrP2P {
  joinRoom: (appId: string, room: string, opts: Record<string, unknown>) => P2PRoom
}
interface P2PPeer {
  readonly id: string
  readonly state: string
  readonly transport: string | null
}
interface P2PRoom {
  readonly roomId: string
  readonly peers: readonly P2PPeer[]
  channel(name: string): { send(data: unknown, to?: P2PPeer | P2PPeer[]): Promise<void>; on(h: (d: unknown, p: P2PPeer) => void): () => void }
  on(event: 'join' | 'leave', h: (p: P2PPeer) => void): () => void
  leave(): Promise<void>
}

interface RoomState {
  space: string
  keyId: string
  room: P2PRoom
  /** session id → verified device pubkey */
  devices: Map<string, string>
}

interface Pending {
  space: string
  need: Set<string>
  timer: ReturnType<typeof setTimeout>
}

export interface PeerInfo {
  space: string
  device: string
  transport: string | null
}

/**
 * Direct WebRTC delivery of envelopes between devices (via nostr-p2p). Relays remain the store for
 * offline devices: an envelope skips relays only when every device of the space acknowledged it.
 */
export class P2PSync {
  readonly #host: P2PHost
  readonly #opts: Required<Pick<P2POptions, 'graceMs'>> & P2POptions
  readonly #rooms = new Map<string, RoomState>()
  readonly #pending = new Map<string, Pending>()
  #lib: Promise<NostrP2P> | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #closed = false

  constructor(host: P2PHost, opts: P2POptions) {
    this.#host = host
    this.#opts = { graceMs: 2000, ...opts }
  }

  start(): void {
    void this.refresh()
    this.#timer = setInterval(() => void this.refresh(), 2000)
    ;(this.#timer as { unref?: () => void }).unref?.()
  }

  /** Join rooms for current epoch keys; leave rooms of old keys / spaces we left. */
  async refresh(): Promise<void> {
    if (this.#closed) return
    const want = new Map(this.#host.rooms().map((r) => [r.space, r]))
    for (const [space, st] of this.#rooms) {
      const w = want.get(space)
      if (!w || w.keyId !== st.keyId) {
        this.#rooms.delete(space)
        void st.room.leave()
      }
    }
    for (const [space, w] of want) {
      if (this.#rooms.has(space)) continue
      const lib = await (this.#lib ??= import('nostr-p2p') as unknown as Promise<NostrP2P>)
      if (this.#closed || this.#rooms.has(space)) return
      // The room name is derived from the epoch key: only members can find it, and a key rotation
      // moves everyone still a member into a new room (removed members are left behind).
      const name = bytesToHex(sha256(utf8ToBytes(`anodb/v2/p2p/${bytesToHex(w.key)}`)))
      const room = lib.joinRoom(`anodb:${this.#host.appId}`, name, {
        transport: 'direct',
        relays: this.#host.relays(),
        ...(this.#opts.rtc ? { rtc: this.#opts.rtc } : {}),
        ...(this.#opts.iceServers ? { iceServers: this.#opts.iceServers } : {}),
      })
      const st: RoomState = { space, keyId: w.keyId, room, devices: new Map() }
      this.#rooms.set(space, st)
      const ch = room.channel('anodb')
      room.on('join', (peer) => void ch.send({ t: 'hi', proof: this.#proof(room.roomId, peer.id) }, peer).catch(() => {}))
      room.on('leave', (peer) => st.devices.delete(peer.id))
      ch.on((data, peer) => this.#onMessage(st, data, peer))
    }
  }

  /** Proof that this session belongs to our device, bound to the room and the recipient session. */
  #proof(roomId: string, peerSession: string): NostrEvent {
    return signWith(this.#host.deviceSk, { kind: PROOF_KIND, created_at: Math.floor(Date.now() / 1000), tags: [], content: `${roomId}:${peerSession}` })
  }

  #onMessage(st: RoomState, data: unknown, peer: P2PPeer): void {
    if (typeof data !== 'object' || data === null) return
    const m = data as { t?: unknown; proof?: unknown; e?: unknown; id?: unknown }
    if (m.t === 'hi') {
      const proof = m.proof
      const mySession = (st.room as unknown as { selfId: string }).selfId
      if (!isEvent(proof) || proof.kind !== PROOF_KIND || proof.content !== `${st.room.roomId}:${mySession}` || !verifySignedEvent(proof)) {
        this.#rejected.push('bad proof')
        return
      }
      if (!this.#host.allowedDevices(st.space).has(proof.pubkey) || proof.pubkey === this.#host.devicePubkey) {
        this.#rejected.push(`device not allowed: ${proof.pubkey.slice(0, 8)}`)
        return
      }
      st.devices.set(peer.id, proof.pubkey)
      return
    }
    const device = st.devices.get(peer.id)
    if (!device) return // only verified devices may talk
    if (m.t === 'e' && isEvent(m.e)) {
      if (this.#host.ingest(m.e)) void st.room.channel('anodb').send({ t: 'a', id: m.e.id }, peer).catch(() => {})
    } else if (m.t === 'a' && typeof m.id === 'string') {
      const p = this.#pending.get(m.id)
      if (!p || p.space !== st.space) return
      p.need.delete(device)
      if (p.need.size === 0) {
        clearTimeout(p.timer)
        this.#pending.delete(m.id)
        this.#host.delivered(m.id)
      }
    }
  }

  /** Connected, verified devices of a space. */
  #connected(space: string): Map<string, P2PPeer> {
    const st = this.#rooms.get(space)
    const out = new Map<string, P2PPeer>()
    if (!st) return out
    for (const peer of st.room.peers) {
      const d = st.devices.get(peer.id)
      if (d && peer.state === 'connected' && peer.transport === 'direct') out.set(d, peer)
    }
    return out
  }

  /** Hold a new envelope back from relays iff every other device of the space is connected. */
  holdMs(space: string): number {
    const connected = this.#connected(space)
    if (connected.size === 0) return 0
    const others = [...this.#host.allowedDevices(space)].filter((d) => d !== this.#host.devicePubkey)
    return others.length > 0 && others.every((d) => connected.has(d)) ? this.#opts.graceMs : 0
  }

  /** Send a new envelope to connected peers (after the write transaction). */
  send(space: string, envelope: NostrEvent, held: boolean): void {
    const connected = this.#connected(space)
    if (held) {
      const timer = setTimeout(() => {
        this.#pending.delete(envelope.id)
        this.#host.release(envelope.id)
      }, this.#opts.graceMs)
      ;(timer as { unref?: () => void }).unref?.()
      this.#pending.set(envelope.id, { space, need: new Set(connected.keys()), timer })
    }
    if (connected.size === 0) return
    const st = this.#rooms.get(space)!
    void st.room.channel('anodb').send({ t: 'e', e: envelope }, [...connected.values()]).catch(() => {})
  }

  /** Raw room state for troubleshooting. */
  diagnostics(): Array<{ space: string; keyId: string; roomId: string; self: string; peers: Array<{ session: string; state: string; transport: string | null; device: string | null }>; rejected: string[] }> {
    return [...this.#rooms.values()].map((st) => ({
      space: st.space,
      keyId: st.keyId,
      roomId: st.room.roomId,
      self: (st.room as unknown as { selfId: string }).selfId,
      peers: st.room.peers.map((p) => ({ session: p.id, state: p.state, transport: p.transport, device: st.devices.get(p.id) ?? null })),
      rejected: [...this.#rejected],
    }))
  }

  readonly #rejected: string[] = []

  peers(): PeerInfo[] {
    const out: PeerInfo[] = []
    for (const st of this.#rooms.values()) {
      for (const peer of st.room.peers) {
        const device = st.devices.get(peer.id)
        if (device) out.push({ space: st.space, device, transport: peer.transport })
      }
    }
    return out
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    for (const p of this.#pending.values()) clearTimeout(p.timer)
    this.#pending.clear()
    await Promise.all([...this.#rooms.values()].map((st) => st.room.leave().catch(() => {})))
    this.#rooms.clear()
  }
}
