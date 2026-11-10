import { createHash } from 'node:crypto'
import { type AddressInfo, createServer, type Server } from 'node:net'
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http'
import { verifyEvent } from 'nostr-tools/pure'

void createServer
type Opts = {
  /** Serve modified bytes (malicious / broken server). */
  corrupt?: boolean
  /** Accept only standard base64 tokens (older servers). */
  legacyBase64?: boolean
  /** Reject uploads with this status. */
  rejectUploads?: number
}

/** In-process Blossom server validating BUD-11 authorization like real servers. */
export class MockBlossom {
  readonly blobs = new Map<string, { data: Buffer; owner: string }>()
  readonly authFailures: string[] = []
  opts: Opts
  #srv: Server | null = null
  #port = 0
  constructor(opts: Opts = {}) {
    this.opts = opts
  }
  get url(): string {
    return `http://127.0.0.1:${this.#port}`
  }
  async start(): Promise<this> {
    const srv = createHttp((req, res) => void this.#handle(req, res))
    await new Promise<void>((r) => srv.listen(this.#port, '127.0.0.1', () => r()))
    this.#port = (srv.address() as AddressInfo).port
    this.#srv = srv as unknown as Server
    return this
  }
  async stop(): Promise<void> {
    const s = this.#srv
    this.#srv = null
    if (s) await new Promise<void>((r) => s.close(() => r()))
  }

  #auth(req: IncomingMessage, action: string, hash: string): string | null {
    const h = req.headers.authorization ?? ''
    if (!h.startsWith('Nostr ')) return this.#fail('missing auth')
    const token = h.slice(6)
    const isUrl = /[-_]/.test(token) || !token.endsWith('=') // heuristic like real servers differ
    if (this.opts.legacyBase64 && (/[-_]/.test(token) || (token.length % 4 !== 0))) return this.#fail('expects base64')
    let ev: { kind: number; created_at: number; pubkey: string; tags: string[][] }
    try {
      ev = JSON.parse(Buffer.from(token.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    } catch {
      return this.#fail('bad token')
    }
    void isUrl
    const now = Math.floor(Date.now() / 1000)
    const tag = (n: string) => ev.tags.filter((t) => t[0] === n).map((t) => t[1])
    if (!verifyEvent(ev as never)) return this.#fail('bad signature')
    if (ev.kind !== 24242) return this.#fail('kind')
    if (ev.created_at > now) return this.#fail('created_at in future')
    if (!(Number(tag('expiration')[0]) > now)) return this.#fail('expired')
    if (!tag('t').includes(action)) return this.#fail('t')
    if (!tag('x').includes(hash)) return this.#fail('x')
    const servers = tag('server')
    if (servers.length && !servers.includes('127.0.0.1')) return this.#fail('server')
    return ev.pubkey
  }
  #fail(why: string): null {
    this.authFailures.push(why)
    return null
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const path = new URL(req.url ?? '/', this.url).pathname
    const body = await new Promise<Buffer>((r) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => r(Buffer.concat(chunks)))
    })
    if (req.method === 'PUT' && path === '/upload') {
      if (this.opts.rejectUploads) return void res.writeHead(this.opts.rejectUploads, { 'X-Reason': 'policy' }).end()
      const hash = createHash('sha256').update(body).digest('hex')
      if (req.headers['x-sha-256'] && req.headers['x-sha-256'] !== hash) return void res.writeHead(409).end()
      const owner = this.#auth(req, 'upload', hash)
      if (!owner) return void res.writeHead(401, { 'X-Reason': 'unauthorized' }).end()
      const existed = this.blobs.has(hash)
      if (!existed) this.blobs.set(hash, { data: body, owner })
      res.writeHead(existed ? 200 : 201, { 'Content-Type': 'application/json' })
      return void res.end(JSON.stringify({ url: `${this.url}/${hash}.bin`, sha256: hash, size: body.length, type: 'application/octet-stream', uploaded: 0 }))
    }
    const m = path.match(/^\/([0-9a-f]{64})(\.\w+)?$/)
    if (m && req.method === 'GET') {
      const b = this.blobs.get(m[1]!)
      if (!b) return void res.writeHead(404).end()
      const data = this.opts.corrupt ? Buffer.from(b.data.map((x, i) => (i === 20 ? x ^ 1 : x))) : b.data
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length })
      return void res.end(data)
    }
    if (m && req.method === 'DELETE') {
      const b = this.blobs.get(m[1]!)
      if (!b) return void res.writeHead(404).end()
      const who = this.#auth(req, 'delete', m[1]!)
      if (!who) return void res.writeHead(401).end()
      if (who !== b.owner) return void res.writeHead(403, { 'X-Reason': 'not the uploader' }).end()
      this.blobs.delete(m[1]!)
      return void res.writeHead(204).end()
    }
    res.writeHead(404).end()
  }
}
