import { isHlc } from './hlc.js'
import { isEvent } from './identity.js'
import type { NostrEvent } from './types.js'

/** Protocol version carried inside every encrypted message. */
export const PROTOCOL_VERSION = 2
/** Outer "envelope" event: signed by a throwaway key, content encrypted. Provisional kind. */
export const WRAP_KIND = 7303
/** Inner message: signed by a device key, never published unencrypted. */
export const MESSAGE_KIND = 7305
/** Tag carrying the opaque routing value. Single-letter so relays index it. */
export const TAG = 'n'
/** NIP-44 v2 plaintext limit is 65535 bytes; inner messages stay below this. */
export const MAX_PLAINTEXT_BYTES = 60 * 1024
/** Budget for the payload body (inner event + delegation overhead fits in the rest). */
export const MAX_BODY_BYTES = 44 * 1024

/** [table, rowId, column, value, hlc] */
export type Change = readonly [table: string, rowId: string, column: string, value: unknown, hlc: string]

/** Fields common to messages in a space stream. */
export interface StreamHeader {
  v: 2
  /** space id */
  sp: string
  /** key id of the epoch key the message is encrypted with */
  ep: string
  /** per (space, device) sequence number, starting at 1 */
  seq: number
  /** identity → device delegation */
  dlg: NostrEvent
}

export type StreamPayload =
  | (StreamHeader & { t: 'ch'; c: Change[] })
  | (StreamHeader & { t: 'op'; op: Record<string, unknown>; par: string[] })
  | (StreamHeader & { t: 'snap'; sid: string; i: number; n: number; body: unknown })

/** Messages delivered to a device inbox. */
export type InboxPayload = { v: 2; t: string; dlg: NostrEvent; [k: string]: unknown }

const NAME_RE = /^\$?[A-Za-z][A-Za-z0-9_]*$/
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`)
const HEX32 = HEX(32)
const HEX16 = HEX(16)

export function isChange(c: unknown): c is Change {
  if (!Array.isArray(c) || c.length !== 5) return false
  const [table, rowId, column, , hlc] = c
  return (
    typeof table === 'string' &&
    NAME_RE.test(table) &&
    !table.startsWith('$') &&
    typeof rowId === 'string' &&
    rowId.length > 0 &&
    rowId.length <= 128 &&
    typeof column === 'string' &&
    NAME_RE.test(column) &&
    isHlc(hlc)
  )
}

/** Structural validation of a decrypted stream payload (signatures are checked by the caller). */
export function parseStreamPayload(json: string): StreamPayload | null {
  let p: Record<string, unknown>
  try {
    p = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof p !== 'object' || p === null || p.v !== PROTOCOL_VERSION) return null
  if (typeof p.sp !== 'string' || !HEX32.test(p.sp)) return null
  if (typeof p.ep !== 'string' || !HEX16.test(p.ep)) return null
  if (typeof p.seq !== 'number' || !Number.isSafeInteger(p.seq) || p.seq < 1) return null
  if (!isEvent(p.dlg)) return null
  switch (p.t) {
    case 'ch':
      return Array.isArray(p.c) && p.c.every(isChange) ? (p as unknown as StreamPayload) : null
    case 'op':
      return typeof p.op === 'object' && p.op !== null && Array.isArray(p.par) && p.par.every((x) => typeof x === 'string')
        ? (p as unknown as StreamPayload)
        : null
    case 'snap':
      return typeof p.sid === 'string' && Number.isSafeInteger(p.i) && Number.isSafeInteger(p.n) && (p.i as number) >= 0 && (p.i as number) < (p.n as number) && (p.n as number) <= 10_000
        ? (p as unknown as StreamPayload)
        : null
    default:
      return null
  }
}

export function parseInboxPayload(json: string): InboxPayload | null {
  try {
    const p = JSON.parse(json) as Record<string, unknown>
    if (typeof p !== 'object' || p === null || p.v !== PROTOCOL_VERSION || typeof p.t !== 'string' || !isEvent(p.dlg)) return null
    return p as InboxPayload
  } catch {
    return null
  }
}

const encoder = new TextEncoder()
export const byteLength = (s: string) => encoder.encode(s).length

/** Split changes into groups whose JSON stays under `maxBytes`. */
export function splitChanges(changes: Change[], maxBytes = MAX_BODY_BYTES): Change[][] {
  if (changes.length === 0) return []
  if (byteLength(JSON.stringify(changes)) <= maxBytes) return [changes]
  if (changes.length === 1) {
    const [t, r, c] = changes[0]!
    throw new Error(`anoDB: value of ${t}.${c} (row ${r}) exceeds ${maxBytes} bytes; store large data as a blob`)
  }
  const mid = Math.ceil(changes.length / 2)
  return [...splitChanges(changes.slice(0, mid), maxBytes), ...splitChanges(changes.slice(mid), maxBytes)]
}
