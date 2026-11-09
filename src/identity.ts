import { verifySignedEvent } from './crypto.js'
import type { Signer } from './signer.js'
import type { NostrEvent } from './types.js'

/** Identity → device delegation / revocation (regular event, carried inside encrypted messages). */
export const DELEGATION_KIND = 7304
/** Public, replaceable list of a user's current device delegations (for invites by npub). */
export const KEY_PACKAGE_KIND = 10304

export async function createDelegation(signer: Signer, devicePubkey: string, name: string, now: number): Promise<NostrEvent> {
  return signer.signEvent({
    kind: DELEGATION_KIND,
    created_at: Math.floor(now / 1000),
    tags: [['device', devicePubkey]],
    content: JSON.stringify({ name }),
  })
}

export async function createRevocation(signer: Signer, devicePubkey: string, now: number): Promise<NostrEvent> {
  return signer.signEvent({
    kind: DELEGATION_KIND,
    created_at: Math.floor(now / 1000),
    tags: [['revoke', devicePubkey]],
    content: '',
  })
}

/** Returns the identity pubkey if `ev` validly delegates to `devicePubkey`. */
export function verifyDelegation(ev: unknown, devicePubkey: string): string | null {
  if (!isEvent(ev) || ev.kind !== DELEGATION_KIND) return null
  if (!ev.tags.some((t) => t[0] === 'device' && t[1] === devicePubkey)) return null
  return verifySignedEvent(ev) ? ev.pubkey : null
}

/** Returns `{ identity, device }` if `ev` is a valid revocation. */
export function verifyRevocation(ev: unknown): { identity: string; device: string } | null {
  if (!isEvent(ev) || ev.kind !== DELEGATION_KIND) return null
  const t = ev.tags.find((x) => x[0] === 'revoke' && typeof x[1] === 'string')
  if (!t || !verifySignedEvent(ev)) return null
  return { identity: ev.pubkey, device: t[1]! }
}

export function delegationName(ev: NostrEvent): string {
  try {
    const n = (JSON.parse(ev.content) as { name?: unknown }).name
    return typeof n === 'string' ? n.slice(0, 64) : ''
  } catch {
    return ''
  }
}

export async function createKeyPackage(signer: Signer, delegations: NostrEvent[], now: number): Promise<NostrEvent> {
  return signer.signEvent({
    kind: KEY_PACKAGE_KIND,
    created_at: Math.floor(now / 1000),
    tags: delegations.map((d) => ['device', d.tags.find((t) => t[0] === 'device')![1]!]),
    content: JSON.stringify({ v: 2, delegations }),
  })
}

/** Verified device pubkeys (with their delegations) from a key package. */
export function parseKeyPackage(ev: NostrEvent): Array<{ device: string; delegation: NostrEvent }> {
  if (ev.kind !== KEY_PACKAGE_KIND || !verifySignedEvent(ev)) return []
  try {
    const { delegations } = JSON.parse(ev.content) as { delegations?: unknown[] }
    const out: Array<{ device: string; delegation: NostrEvent }> = []
    for (const d of delegations ?? []) {
      if (!isEvent(d)) continue
      const device = d.tags.find((t) => t[0] === 'device')?.[1]
      if (device && verifyDelegation(d, device) === ev.pubkey) out.push({ device, delegation: d })
    }
    return out
  } catch {
    return []
  }
}

export function isEvent(e: unknown): e is NostrEvent {
  if (typeof e !== 'object' || e === null) return false
  const o = e as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.pubkey === 'string' &&
    typeof o.created_at === 'number' &&
    typeof o.kind === 'number' &&
    Array.isArray(o.tags) &&
    o.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string')) &&
    typeof o.content === 'string' &&
    typeof o.sig === 'string'
  )
}
