/**
 * Negentropy range-based set reconciliation (protocol version 1, NIP-77).
 * Ported from nostr-tools (Unlicense) / hoytech/negentropy, with the responder side added
 * (a responder answers IdList ranges with its own ids) and a byte-offset-safe accumulator.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

const PROTOCOL_VERSION = 0x61
const ID_SIZE = 32
const FINGERPRINT_SIZE = 16
const Mode = { Skip: 0, Fingerprint: 1, IdList: 2 } as const
const MAX_TS = Number.MAX_VALUE

interface Item {
  timestamp: number
  id: Uint8Array
}

class Buf {
  #raw: Uint8Array
  length: number
  constructor(init?: Uint8Array) {
    this.#raw = init ? new Uint8Array(init) : new Uint8Array(512)
    this.length = init ? init.length : 0
  }
  unwrap(): Uint8Array {
    return this.#raw.subarray(0, this.length)
  }
  extend(b: Uint8Array | Buf): void {
    const buf = b instanceof Buf ? b.unwrap() : b
    const need = this.length + buf.length
    if (this.#raw.byteLength < need) {
      const next = new Uint8Array(Math.max(this.#raw.byteLength * 2, need))
      next.set(this.#raw.subarray(0, this.length))
      this.#raw = next
    }
    this.#raw.set(buf, this.length)
    this.length += buf.length
  }
  shift(): number {
    if (this.length < 1) throw new Error('negentropy: parse ends prematurely')
    const b = this.#raw[0]!
    this.#raw = this.#raw.subarray(1)
    this.length--
    return b
  }
  shiftN(n: number): Uint8Array {
    if (this.length < n) throw new Error('negentropy: parse ends prematurely')
    const out = this.#raw.subarray(0, n)
    this.#raw = this.#raw.subarray(n)
    this.length -= n
    return out
  }
}

function decodeVarInt(b: Buf): number {
  let res = 0
  for (;;) {
    const byte = b.shift()
    res = res * 128 + (byte & 127)
    if ((byte & 128) === 0) return res
  }
}

function encodeVarInt(n: number): Uint8Array {
  if (n === 0) return new Uint8Array([0])
  const o: number[] = []
  while (n !== 0) {
    o.push(n % 128)
    n = Math.floor(n / 128)
  }
  o.reverse()
  for (let i = 0; i < o.length - 1; i++) o[i]! |= 128
  return new Uint8Array(o)
}

function fingerprint(items: Item[], begin: number, end: number): Uint8Array {
  const acc = new Uint8Array(ID_SIZE)
  const dv = new DataView(acc.buffer)
  for (let k = begin; k < end; k++) {
    const id = items[k]!.id
    const ov = new DataView(id.buffer, id.byteOffset, id.byteLength)
    let carry = 0
    for (let i = 0; i < 8; i++) {
      const sum = dv.getUint32(i * 4, true) + ov.getUint32(i * 4, true) + carry
      dv.setUint32(i * 4, sum >>> 0, true)
      carry = sum > 0xffffffff ? 1 : 0
    }
  }
  const input = new Buf()
  input.extend(acc)
  input.extend(encodeVarInt(end - begin))
  return sha256(input.unwrap()).subarray(0, FINGERPRINT_SIZE)
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  return a.length - b.length
}
const cmpItem = (a: Item, b: Item) => (a.timestamp === b.timestamp ? cmpBytes(a.id, b.id) : a.timestamp - b.timestamp)

export class Negentropy {
  readonly #items: Item[]
  readonly #initiator: boolean
  readonly #frameSizeLimit: number
  #lastIn = 0
  #lastOut = 0

  /** `items`: (created_at, id hex) of the local set. */
  constructor(items: ReadonlyArray<{ created_at: number; id: string }>, opts: { initiator: boolean; frameSizeLimit?: number }) {
    this.#items = items.map((i) => ({ timestamp: i.created_at, id: hexToBytes(i.id) })).sort(cmpItem)
    this.#initiator = opts.initiator
    this.#frameSizeLimit = opts.frameSizeLimit ?? 60_000
  }

  initiate(): string {
    const out = new Buf()
    out.extend(new Uint8Array([PROTOCOL_VERSION]))
    this.#splitRange(0, this.#items.length, { timestamp: MAX_TS, id: new Uint8Array(0) }, out)
    return bytesToHex(out.unwrap())
  }

  /**
   * Process a message. Initiator: returns the next message or null when done, reporting ids we
   * have that they lack (`have`) and ids they have that we lack (`need`).
   */
  reconcile(msgHex: string, have?: (id: string) => void, need?: (id: string) => void): string | null {
    const q = new Buf(hexToBytes(msgHex))
    this.#lastIn = this.#lastOut = 0
    const full = new Buf()
    full.extend(new Uint8Array([PROTOCOL_VERSION]))
    const version = q.shift()
    if (version !== PROTOCOL_VERSION) throw new Error(`negentropy: unsupported protocol version ${version}`)
    const n = this.#items.length
    let prevBound: Item = { timestamp: 0, id: new Uint8Array(0) }
    let prevIndex = 0
    let skip = false
    while (q.length !== 0) {
      const o = new Buf()
      const doSkip = () => {
        if (skip) {
          skip = false
          o.extend(this.#encodeBound(prevBound))
          o.extend(encodeVarInt(Mode.Skip))
        }
      }
      const curr = this.#decodeBound(q)
      const mode = decodeVarInt(q)
      const lower = prevIndex
      const upper = this.#lowerBound(prevIndex, n, curr)
      if (mode === Mode.Skip) {
        skip = true
      } else if (mode === Mode.Fingerprint) {
        const theirs = q.shiftN(FINGERPRINT_SIZE)
        if (cmpBytes(theirs, fingerprint(this.#items, lower, upper)) !== 0) {
          doSkip()
          this.#splitRange(lower, upper, curr, o)
        } else skip = true
      } else if (mode === Mode.IdList) {
        const count = decodeVarInt(q)
        const theirs = new Map<string, true>()
        for (let i = 0; i < count; i++) theirs.set(bytesToHex(q.shiftN(ID_SIZE)), true)
        if (this.#initiator) {
          skip = true
          for (let k = lower; k < upper; k++) {
            const id = bytesToHex(this.#items[k]!.id)
            if (theirs.has(id)) theirs.delete(id)
            else have?.(id)
          }
          for (const id of theirs.keys()) need?.(id)
        } else {
          doSkip()
          o.extend(this.#encodeBound(curr))
          o.extend(encodeVarInt(Mode.IdList))
          o.extend(encodeVarInt(upper - lower))
          for (let k = lower; k < upper; k++) o.extend(this.#items[k]!.id)
        }
      } else throw new Error('negentropy: unexpected mode')

      if (full.length + o.length > this.#frameSizeLimit - 200) {
        full.extend(this.#encodeBound({ timestamp: MAX_TS, id: new Uint8Array(0) }))
        full.extend(encodeVarInt(Mode.Fingerprint))
        full.extend(fingerprint(this.#items, upper, n))
        break
      }
      full.extend(o)
      prevIndex = upper
      prevBound = curr
    }
    return full.length === 1 ? null : bytesToHex(full.unwrap())
  }

  #lowerBound(begin: number, end: number, bound: Item): number {
    let lo = begin
    let hi = end
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cmpItem(this.#items[mid]!, bound) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  #splitRange(lower: number, upper: number, upperBound: Item, o: Buf): void {
    const num = upper - lower
    const buckets = 16
    if (num < buckets * 2) {
      o.extend(this.#encodeBound(upperBound))
      o.extend(encodeVarInt(Mode.IdList))
      o.extend(encodeVarInt(num))
      for (let k = lower; k < upper; k++) o.extend(this.#items[k]!.id)
      return
    }
    const per = Math.floor(num / buckets)
    const extra = num % buckets
    let curr = lower
    for (let i = 0; i < buckets; i++) {
      const size = per + (i < extra ? 1 : 0)
      const fp = fingerprint(this.#items, curr, curr + size)
      curr += size
      const bound = curr === upper ? upperBound : this.#minimalBound(this.#items[curr - 1]!, this.#items[curr]!)
      o.extend(this.#encodeBound(bound))
      o.extend(encodeVarInt(Mode.Fingerprint))
      o.extend(fp)
    }
  }

  #minimalBound(prev: Item, curr: Item): Item {
    if (curr.timestamp !== prev.timestamp) return { timestamp: curr.timestamp, id: new Uint8Array(0) }
    let shared = 0
    while (shared < ID_SIZE && curr.id[shared] === prev.id[shared]) shared++
    return { timestamp: curr.timestamp, id: curr.id.subarray(0, shared + 1) }
  }

  #encodeBound(b: Item): Uint8Array {
    const out = new Buf()
    if (b.timestamp === MAX_TS) {
      this.#lastOut = MAX_TS
      out.extend(encodeVarInt(0))
    } else {
      const delta = b.timestamp - this.#lastOut
      this.#lastOut = b.timestamp
      out.extend(encodeVarInt(delta + 1))
    }
    out.extend(encodeVarInt(b.id.length))
    out.extend(b.id)
    return out.unwrap().slice()
  }

  #decodeBound(b: Buf): Item {
    let ts = decodeVarInt(b)
    ts = ts === 0 ? MAX_TS : ts - 1
    if (this.#lastIn === MAX_TS || ts === MAX_TS) {
      this.#lastIn = MAX_TS
      ts = MAX_TS
    } else {
      ts += this.#lastIn
      this.#lastIn = ts
    }
    const len = decodeVarInt(b)
    if (len > ID_SIZE) throw new Error('negentropy: bound key too long')
    return { timestamp: ts, id: b.shiftN(len).slice() }
  }
}
