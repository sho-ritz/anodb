import { sha256 } from '@noble/hashes/sha2.js'
import { aesKeyFromBytes, aesOpen, aesSeal, bytesToHex, hexToBytes, randomBytes, sha256Hex, signWith } from './crypto.js'
import type { NostrEvent } from './types.js'

/**
 * Public Blossom servers used when `blobServers` is not given. Checked 2026-11-10 with
 * `npm run smoke:public`: they accept encrypted (application/octet-stream) uploads. Most public
 * servers only allow images/video and reject ciphertext (blossom.primal.net, blossom.band,
 * nostr.build, nostrcheck, azzamo, 24242.io returned 400/415). Revalidate before each release.
 */
export const DEFAULT_BLOB_SERVERS: readonly string[] = ['https://nostr.download', 'https://blossom.yakihonne.com', 'https://blossom.data.haus']

/** Blossom authorization event kind (BUD-11). */
export const BLOSSOM_AUTH_KIND = 24242

/**
 * Reference to an encrypted blob. Store it in a `json` column: it is synced end-to-end encrypted
 * like any other value, so only members of the space learn the decryption key.
 */
export interface BlobRef {
  v: 1
  /** sha256 of the stored ciphertext (Blossom address) */
  sha256: string
  /** plaintext size in bytes */
  size: number
  /** MIME type of the plaintext */
  type: string
  /** AES-256-GCM key (hex) */
  key: string
  /** servers that accepted the upload */
  servers: string[]
  /** salt of the per-blob upload key (lets the uploading device delete it later) */
  salt: string
  name?: string
}

export interface BlobPutOptions {
  type?: string
  name?: string
  /** Servers to upload to. Default: the database's `blobServers`. */
  servers?: readonly string[]
  /** Require at least this many servers to accept the upload. Default 1. */
  minServers?: number
}

export interface BlobUploadReport {
  server: string
  ok: boolean
  status?: number
  reason?: string
}

export class BlobError extends Error {
  readonly reports: BlobUploadReport[]
  constructor(message: string, reports: BlobUploadReport[] = []) {
    super(message)
    this.name = 'BlobError'
    this.reports = reports
  }
}

type Fetch = typeof fetch

const nowSec = () => Math.floor(Date.now() / 1000)

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
function base64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function normalizeServer(url: string): string {
  const u = new URL(url)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`anoDB: blob server must be http(s): ${url}`)
  return u.origin
}

async function toBytes(data: Uint8Array | ArrayBuffer | Blob | string): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(await data.arrayBuffer())
}

/**
 * Encrypted file storage on Blossom servers (BUD-01/02/11/12). Files are encrypted on the device;
 * servers only ever see ciphertext, its size, upload time and the uploader's IP.
 */
export class BlobStore {
  readonly #deviceSk: Uint8Array
  readonly #servers: string[]
  readonly #fetch: Fetch

  constructor(opts: { deviceSk: Uint8Array; servers: readonly string[]; fetch?: Fetch }) {
    this.#deviceSk = opts.deviceSk
    this.#servers = opts.servers.map(normalizeServer)
    this.#fetch = opts.fetch ?? ((...a) => fetch(...a))
  }

  get servers(): string[] {
    return [...this.#servers]
  }

  /** Throwaway signing key for one blob, derivable only by this device. */
  #uploadKey(salt: string): Uint8Array {
    return hexToBytes(sha256Hex(`anodb/v2/blob/${bytesToHex(this.#deviceSk)}/${salt}`))
  }

  #auth(sk: Uint8Array, action: 'upload' | 'delete' | 'get', hash: string, server: string, b64: (b: Uint8Array) => string): string {
    const ev: NostrEvent = signWith(sk, {
      kind: BLOSSOM_AUTH_KIND,
      created_at: nowSec() - 5,
      content: `${action[0]!.toUpperCase()}${action.slice(1)} Blob`,
      tags: [
        ['t', action],
        ['x', hash],
        ['expiration', String(nowSec() + 300)],
        ['server', new URL(server).hostname.toLowerCase()],
      ],
    })
    return `Nostr ${b64(new TextEncoder().encode(JSON.stringify(ev)))}`
  }

  /** Encrypt and upload. Returns a reference to store in a `json` column. */
  async put(data: Uint8Array | ArrayBuffer | Blob | string, opts: BlobPutOptions = {}): Promise<BlobRef> {
    const plain = await toBytes(data)
    const keyBytes = randomBytes(32)
    const cipher = await aesSeal(await aesKeyFromBytes(keyBytes), plain)
    const hash = bytesToHex(sha256(cipher))
    const salt = bytesToHex(randomBytes(16))
    const sk = this.#uploadKey(salt)
    const servers = (opts.servers ?? this.#servers).map(normalizeServer)
    if (servers.length === 0) throw new BlobError('anoDB: no blob servers configured (blobServers)')
    const reports = await Promise.all(servers.map((s) => this.#upload(s, cipher, hash, sk)))
    const ok = reports.filter((r) => r.ok).map((r) => r.server)
    if (ok.length < (opts.minServers ?? 1)) {
      throw new BlobError(`anoDB: blob upload failed (${ok.length}/${servers.length} servers accepted it)`, reports)
    }
    const ref: BlobRef = {
      v: 1,
      sha256: hash,
      size: plain.length,
      type: opts.type ?? (data instanceof Blob && data.type ? data.type : 'application/octet-stream'),
      key: bytesToHex(keyBytes),
      servers: ok,
      salt,
    }
    if (opts.name) ref.name = opts.name
    return ref
  }

  async #upload(server: string, cipher: Uint8Array, hash: string, sk: Uint8Array): Promise<BlobUploadReport> {
    // BUD-11 says base64url without padding; some older servers only accept standard base64.
    for (const b64 of [base64url, base64]) {
      try {
        const res = await this.#fetch(`${server}/upload`, {
          method: 'PUT',
          body: cipher as BodyInit,
          headers: {
            Authorization: this.#auth(sk, 'upload', hash, server, b64),
            'Content-Type': 'application/octet-stream',
            'X-SHA-256': hash,
          },
        })
        if (res.status === 401 && b64 === base64url) continue
        if (res.status !== 200 && res.status !== 201) {
          return { server, ok: false, status: res.status, reason: res.headers.get('x-reason') ?? res.statusText }
        }
        const desc = (await res.json().catch(() => ({}))) as { sha256?: string }
        if (desc.sha256 && desc.sha256 !== hash) return { server, ok: false, status: res.status, reason: 'server reported a different hash' }
        return { server, ok: true, status: res.status }
      } catch (e) {
        return { server, ok: false, reason: (e as Error).message }
      }
    }
    return { server, ok: false, status: 401, reason: 'unauthorized' }
  }

  /** Download, verify the hash and decrypt. Tries the reference's servers, then the configured ones. */
  async get(refOrJson: BlobRef | string): Promise<{ data: Uint8Array; type: string; name?: string }> {
    const ref = parseRef(refOrJson)
    const candidates = [...new Set([...ref.servers.map(normalizeServer), ...this.#servers])]
    const errors: string[] = []
    for (const server of candidates) {
      try {
        const res = await this.#fetch(`${server}/${ref.sha256}`)
        if (!res.ok) {
          errors.push(`${server}: HTTP ${res.status}`)
          continue
        }
        const cipher = new Uint8Array(await res.arrayBuffer())
        if (bytesToHex(sha256(cipher)) !== ref.sha256) {
          errors.push(`${server}: content does not match its hash`)
          continue
        }
        const data = await aesOpen(await aesKeyFromBytes(hexToBytes(ref.key)), cipher)
        const out: { data: Uint8Array; type: string; name?: string } = { data, type: ref.type }
        if (ref.name) out.name = ref.name
        return out
      } catch (e) {
        errors.push(`${server}: ${(e as Error).message}`)
      }
    }
    throw new BlobError(`anoDB: blob ${ref.sha256} is not available (${errors.join('; ')})`)
  }

  /** Download as a browser `Blob` (handy for `URL.createObjectURL`). */
  async getBlob(ref: BlobRef | string): Promise<Blob> {
    const { data, type } = await this.get(ref)
    return new Blob([data as BlobPart], { type })
  }

  /** Ask the servers to delete the blob. Only works from the device that uploaded it. */
  async delete(refOrJson: BlobRef | string): Promise<BlobUploadReport[]> {
    const ref = parseRef(refOrJson)
    const sk = this.#uploadKey(ref.salt)
    return Promise.all(
      ref.servers.map(async (raw) => {
        const server = normalizeServer(raw)
        for (const b64 of [base64url, base64]) {
          try {
            const res = await this.#fetch(`${server}/${ref.sha256}`, { method: 'DELETE', headers: { Authorization: this.#auth(sk, 'delete', ref.sha256, server, b64) } })
            if (res.status === 401 && b64 === base64url) continue
            const ok = res.status === 200 || res.status === 204 || res.status === 404
            return { server, ok, status: res.status, ...(ok ? {} : { reason: res.headers.get('x-reason') ?? res.statusText }) }
          } catch (e) {
            return { server, ok: false, reason: (e as Error).message }
          }
        }
        return { server, ok: false, status: 401, reason: 'unauthorized' }
      }),
    )
  }
}

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`)
export function isBlobRef(r: unknown): r is BlobRef {
  if (typeof r !== 'object' || r === null) return false
  const o = r as Record<string, unknown>
  return (
    o.v === 1 &&
    typeof o.sha256 === 'string' &&
    HEX(64).test(o.sha256) &&
    typeof o.key === 'string' &&
    HEX(64).test(o.key) &&
    typeof o.salt === 'string' &&
    Number.isSafeInteger(o.size) &&
    typeof o.type === 'string' &&
    Array.isArray(o.servers) &&
    o.servers.every((s) => typeof s === 'string')
  )
}

/** Accepts the object or the JSON text read back from a `json` column. */
function parseRef(r: BlobRef | string): BlobRef {
  let ref: unknown = r
  if (typeof r === 'string') {
    try {
      ref = JSON.parse(r)
    } catch {
      ref = null
    }
  }
  if (!isBlobRef(ref)) throw new BlobError('anoDB: invalid blob reference')
  return ref
}
