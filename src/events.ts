import { decrypt, encrypt, generateSecretKey, signWith, verifySignedEvent } from './crypto.js'
import { isEvent, verifyDelegation } from './identity.js'
import type { NostrEvent } from './types.js'

/**
 * Ephemeral events ("typing…", presence, cursors): delivered to the members of a space who are
 * online right now, never stored by anoDB and never synced later.
 *
 * Outer event: kind 27303 — in the ephemeral range, so relays forward it without storing it —
 * signed by a throwaway key, NIP-44 encrypted with the space's current epoch key and routed by the
 * same tag as the space stream. Inner event: kind 7306, signed by the device key, carrying the
 * device delegation, so receivers know which member sent it.
 */
export const EVENT_KIND = 27303
export const EVENT_INNER_KIND = 7306
/** Events older than this (by the sender's clock) are dropped. */
export const EVENT_MAX_AGE_SEC = 60
const MAX_EVENT_BYTES = 8 * 1024

export interface SpaceEvent<T = unknown> {
  space: string
  /** Application-defined type, e.g. `typing`. */
  type: string
  data: T
  /** Identity (pubkey hex) of the member who sent it. */
  from: string
  device: string
  /** Sender's time (ms). */
  at: number
}

export interface EventPayload {
  v: 2
  sp: string
  ep: string
  type: string
  d: unknown
  dlg: NostrEvent
}

export function sealEvent(deviceSk: Uint8Array, payload: EventPayload, tag: string, key: Uint8Array, nowSec: number, tagName: string): NostrEvent {
  const content = JSON.stringify(payload)
  if (new TextEncoder().encode(content).length > MAX_EVENT_BYTES) throw new Error('anoDB: event too large (max 8 KB)')
  const inner = signWith(deviceSk, { kind: EVENT_INNER_KIND, created_at: nowSec, tags: [], content })
  return signWith(generateSecretKey(), { kind: EVENT_KIND, created_at: nowSec, tags: [[tagName, tag]], content: encrypt(JSON.stringify(inner), key) })
}

/** Open an ephemeral envelope. Returns null if it is malformed, forged or stale. */
export function openEvent(outer: NostrEvent, key: Uint8Array, space: string, keyId: string, nowSec: number): (SpaceEvent & { id: string }) | null {
  if (outer.kind !== EVENT_KIND || outer.content.length > 20_000 || !verifySignedEvent(outer)) return null
  let inner: unknown
  try {
    inner = JSON.parse(decrypt(outer.content, key))
  } catch {
    return null
  }
  if (!isEvent(inner) || inner.kind !== EVENT_INNER_KIND || !verifySignedEvent(inner)) return null
  if (Math.abs(nowSec - inner.created_at) > EVENT_MAX_AGE_SEC) return null
  let p: Partial<EventPayload>
  try {
    p = JSON.parse(inner.content) as Partial<EventPayload>
  } catch {
    return null
  }
  if (p.v !== 2 || p.sp !== space || p.ep !== keyId || typeof p.type !== 'string' || p.type.length > 64) return null
  const from = verifyDelegation(p.dlg, inner.pubkey)
  if (!from) return null
  return { id: inner.id, space, type: p.type, data: p.d, from, device: inner.pubkey, at: inner.created_at * 1000 }
}
