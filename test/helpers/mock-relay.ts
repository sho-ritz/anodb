import { type AddressInfo, WebSocketServer, type WebSocket } from 'ws'
import { type Filter, matchFilters } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'
import type { NostrEvent } from '../../src/types.js'

export interface MockRelayOptions {
  /** Max events returned per REQ before EOSE (like real relays). */
  maxLimit?: number
  /** Return a rejection message to refuse an event. */
  reject?: (e: NostrEvent) => string | null
  /** Accept (OK true) but do not store or broadcast — a relay that silently loses data. */
  blackhole?: boolean
  /** Do not answer EVENT with OK. */
  silent?: boolean
  /** Support NIP-77 (Negentropy). */
  negentropy?: boolean
}

/** In-process NIP-01 relay with fault injection. */
export class MockRelay {
  readonly events = new Map<string, NostrEvent>()
  readonly received: NostrEvent[] = []
  opts: MockRelayOptions
  #wss: WebSocketServer | null = null
  #port = 0
  readonly #subs = new Map<WebSocket, Map<string, Filter[]>>()
  readonly #negs = new Map<string, { reconcile(m: string): string | null }>()
  negOpens = 0

  constructor(opts: MockRelayOptions = {}) {
    this.opts = opts
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}`
  }

  async start(): Promise<this> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: this.#port })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    this.#port = (wss.address() as AddressInfo).port
    this.#wss = wss
    wss.on('connection', (ws) => {
      this.#subs.set(ws, new Map())
      ws.on('message', (raw) => this.#onMessage(ws, raw.toString()))
      ws.on('close', () => this.#subs.delete(ws))
    })
    return this
  }

  /** Stop accepting connections and drop clients (events are kept, like a restart). */
  async stop(): Promise<void> {
    const wss = this.#wss
    if (!wss) return
    this.#wss = null
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>((r) => wss.close(() => r()))
    this.#subs.clear()
  }

  get clientCount(): number {
    return this.#subs.size
  }

  /** Insert an event directly (as if another client published it). */
  inject(e: NostrEvent): void {
    this.#store(e)
  }

  #store(e: NostrEvent): void {
    if (this.events.has(e.id)) return
    const replaceable = e.kind === 0 || e.kind === 3 || (e.kind >= 10000 && e.kind < 20000)
    if (replaceable) {
      for (const [id, old] of this.events) {
        if (old.kind === e.kind && old.pubkey === e.pubkey) {
          if (old.created_at > e.created_at) return
          this.events.delete(id)
        }
      }
    }
    this.events.set(e.id, e)
    for (const [ws, subs] of this.#subs) {
      for (const [id, filters] of subs) if (matchFilters(filters, e)) ws.send(JSON.stringify(['EVENT', id, e]))
    }
  }

  #onMessage(ws: WebSocket, raw: string): void {
    let msg: unknown[]
    try {
      msg = JSON.parse(raw) as unknown[]
    } catch {
      return
    }
    const [type, ...rest] = msg
    if (type === 'EVENT') {
      const e = rest[0] as NostrEvent
      this.received.push(e)
      if (this.opts.silent) return
      if (!verifyEvent({ ...e })) return void ws.send(JSON.stringify(['OK', e.id, false, 'invalid: bad signature']))
      const reason = this.opts.reject?.(e)
      if (reason) return void ws.send(JSON.stringify(['OK', e.id, false, reason]))
      const dup = this.events.has(e.id)
      if (!this.opts.blackhole) this.#store(e)
      ws.send(JSON.stringify(['OK', e.id, true, dup ? 'duplicate: already have it' : '']))
    } else if (type === 'REQ') {
      const [id, ...filters] = rest as [string, ...Filter[]]
      this.#subs.get(ws)?.set(id, filters)
      const max = this.opts.maxLimit ?? 500
      const matched = [...this.events.values()]
        .filter((e) => matchFilters(filters, e))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      const limit = Math.min(max, ...filters.map((f) => f.limit ?? max))
      for (const e of matched.slice(0, limit)) ws.send(JSON.stringify(['EVENT', id, e]))
      ws.send(JSON.stringify(['EOSE', id]))
    } else if (type === 'NEG-OPEN' || type === 'NEG-MSG') {
      const id = rest[0] as string
      if (!this.opts.negentropy) return void ws.send(JSON.stringify(['NOTICE', 'unknown command']))
      void import('../../src/sync/negentropy.js').then(({ Negentropy }) => {
        let neg = this.#negs.get(id)
        if (type === 'NEG-OPEN') {
          const filter = rest[1] as Filter
          const items = [...this.events.values()].filter((e) => matchFilters([filter], e))
          neg = new Negentropy(items, { initiator: false })
          this.#negs.set(id, neg)
          this.negOpens++
        }
        if (!neg) return void ws.send(JSON.stringify(['NEG-ERR', id, 'closed: no session']))
        const out = neg.reconcile(rest[type === 'NEG-OPEN' ? 2 : 1] as string)
        ws.send(JSON.stringify(['NEG-MSG', id, out ?? '61']))
      })
    } else if (type === 'NEG-CLOSE') {
      this.#negs.delete(rest[0] as string)
    } else if (type === 'CLOSE') {
      this.#subs.get(ws)?.delete(rest[0] as string)
    }
  }
}

export async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
