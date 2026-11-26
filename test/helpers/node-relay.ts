import { DatabaseSync } from 'node:sqlite'
import { type AddressInfo, WebSocketServer } from 'ws'
import { RelayCore, type RelayConn, type RelayOptions, type RelaySql } from '../../src/relay/core.js'

/** node:sqlite with the `ctx.storage.sql.exec` shape of a Durable Object. */
export function nodeRelaySql(db: DatabaseSync): RelaySql {
  return {
    exec<T>(query: string, ...bindings: unknown[]) {
      const st = db.prepare(query)
      const rows = /^\s*(SELECT|WITH)\b/i.test(query) ? (st.all(...(bindings as never[])) as T[]) : (st.run(...(bindings as never[])), [])
      return { toArray: () => rows }
    },
  }
}

/** The Worker's relay engine served over ws on 127.0.0.1, storing to `file` (survives restarts). */
export class NodeRelay {
  readonly db: DatabaseSync
  core: RelayCore
  readonly conns = new Map<RelayConn, import('ws').WebSocket>()
  #wss: WebSocketServer | null = null
  #port = 0

  constructor(
    file = ':memory:',
    readonly opts: RelayOptions = {},
  ) {
    this.db = new DatabaseSync(file)
    this.core = new RelayCore(nodeRelaySql(this.db), () => this.conns.keys(), opts)
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}`
  }

  async start(port = this.#port): Promise<this> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    this.#port = (wss.address() as AddressInfo).port
    this.#wss = wss
    wss.on('connection', (ws) => {
      const conn: RelayConn = { id: crypto.randomUUID(), send: (m) => ws.send(m) }
      this.conns.set(conn, ws)
      ws.on('message', (raw) => this.core.handle(conn, raw.toString()))
      ws.on('close', () => {
        this.conns.delete(conn)
        this.core.closed(conn)
      })
    })
    return this
  }

  /** Like a Durable Object waking from hibernation: memory is gone, sockets and SQL remain. */
  hibernate(): void {
    this.core = new RelayCore(nodeRelaySql(this.db), () => this.conns.keys(), this.opts)
    this.core.prune()
  }

  /** Drop every connection and stop listening (data is kept). */
  async stop(): Promise<void> {
    const wss = this.#wss
    if (!wss) return
    this.#wss = null
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>((r) => wss.close(() => r()))
    this.conns.clear()
  }
}
