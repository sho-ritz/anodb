import { RelayCore, type RelayConn, type RelayOptions, type RelaySql } from './core.js'

/**
 * Cloudflare Worker entry for a self-hosted anoDB relay (`npx @anodb/cli relay deploy`).
 * All connections go to one SQLite-backed Durable Object, which keeps the events and uses the
 * WebSocket Hibernation API so idle connections cost nothing.
 *
 * Minimal local types keep this file free of a dependency on @cloudflare/workers-types.
 */

interface CfWebSocket {
  send(message: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}
interface DurableObjectState {
  storage: { sql: RelaySql }
  acceptWebSocket(ws: CfWebSocket): void
  getWebSockets(): CfWebSocket[]
}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}
interface Env {
  RELAY: DurableObjectNamespace
  /** Comma-separated kinds, or `*` for every kind. Default: the kinds anoDB uses. */
  RELAY_KINDS?: string
  RELAY_NAME?: string
  RELAY_DESCRIPTION?: string
}
declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } }

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }

export function optionsFromEnv(env: Partial<Env>): RelayOptions {
  const o: RelayOptions = {}
  const kinds = env.RELAY_KINDS?.trim()
  if (kinds === '*') o.kinds = null
  else if (kinds) o.kinds = kinds.split(',').map((k) => Number(k.trim())).filter((k) => Number.isSafeInteger(k))
  if (env.RELAY_NAME) o.name = env.RELAY_NAME
  if (env.RELAY_DESCRIPTION) o.description = env.RELAY_DESCRIPTION
  return o
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    return env.RELAY.get(env.RELAY.idFromName('main')).fetch(request)
  },
}

export class Relay {
  readonly #ctx: DurableObjectState
  readonly #core: RelayCore
  readonly #conns = new WeakMap<CfWebSocket, RelayConn>()

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx
    this.#core = new RelayCore(ctx.storage.sql, () => ctx.getWebSockets().map((ws) => this.#conn(ws)), optionsFromEnv(env))
    // Woken from hibernation: surviving sockets keep their subscriptions; others are gone.
    this.#core.prune()
  }

  #conn(ws: CfWebSocket): RelayConn {
    let c = this.#conns.get(ws)
    if (!c) {
      const id = (ws.deserializeAttachment() as { id?: string } | null)?.id ?? crypto.randomUUID()
      c = { id, send: (m) => ws.send(m) }
      this.#conns.set(ws, c)
    }
    return c
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      if ((request.headers.get('Accept') ?? '').includes('application/nostr+json')) {
        return new Response(JSON.stringify(this.#core.info()), { headers: { 'Content-Type': 'application/nostr+json', ...CORS } })
      }
      const url = new URL(request.url)
      return new Response(`anoDB relay — connect with wss://${url.host}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } })
    }
    const pair = new WebSocketPair()
    const server = pair[1]
    this.#ctx.acceptWebSocket(server)
    server.serializeAttachment({ id: crypto.randomUUID() })
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
  }

  webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): void {
    this.#core.handle(this.#conn(ws), typeof message === 'string' ? message : new TextDecoder().decode(message))
  }

  webSocketClose(ws: CfWebSocket): void {
    this.#core.closed(this.#conn(ws))
  }

  webSocketError(ws: CfWebSocket): void {
    this.#core.closed(this.#conn(ws))
  }
}
