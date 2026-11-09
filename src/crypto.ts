import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import type { EventTemplate, NostrEvent } from './types.js'

export { bytesToHex, hexToBytes, generateSecretKey, getPublicKey }

export type SecretKeyInput = Uint8Array | string

/** Accepts raw 32 bytes, 64-char hex, or an `nsec1…` string. */
export function parseSecretKey(input: SecretKeyInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length !== 32) throw new Error('anoDB: secret key must be 32 bytes')
    return input
  }
  const s = input.trim()
  if (s.startsWith('nsec1')) {
    const decoded = nip19.decode(s)
    if (decoded.type !== 'nsec') throw new Error('anoDB: expected nsec')
    return decoded.data
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return hexToBytes(s.toLowerCase())
  throw new Error('anoDB: unrecognised secret key format')
}

export const nsecEncode = (sk: Uint8Array) => nip19.nsecEncode(sk)
export const npubEncode = (pk: string) => nip19.npubEncode(pk)

/** Accepts hex or npub. */
export function parsePubkey(input: string): string {
  const s = input.trim()
  if (s.startsWith('npub1')) {
    const d = nip19.decode(s)
    if (d.type !== 'npub') throw new Error('anoDB: expected npub')
    return d.data
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase()
  throw new Error('anoDB: unrecognised public key format')
}

export function signWith(sk: Uint8Array, template: EventTemplate): NostrEvent {
  return finalizeEvent(template, sk) as NostrEvent
}

export function verifySignedEvent(event: NostrEvent): boolean {
  try {
    // Copy only the NIP-01 fields: object spread would also copy nostr-tools' cached
    // verification flag (a symbol property) and let a tampered copy pass.
    const { id, pubkey, created_at, kind, tags, content, sig } = event
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
  } catch {
    return false
  }
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function randomHex(bytes: number): string {
  return bytesToHex(randomBytes(bytes))
}

const h32 = (s: string) => bytesToHex(sha256(utf8ToBytes(s))).slice(0, 32)

/** Tag of a space stream for one key epoch. Only holders of the key can compute it. */
export function spaceTag(epochKey: Uint8Array): string {
  return h32(`anodb/v2/space/${bytesToHex(epochKey)}`)
}

/** Tag of a device inbox (key delivery, invites, pairing). */
export function inboxTag(devicePubkey: string): string {
  return h32(`anodb/v2/inbox/${devicePubkey}`)
}

/** Tag and symmetric key derived from an invite link / pairing secret. */
export function secretTag(secret: string): string {
  return h32(`anodb/v2/secret-tag/${secret}`)
}
export function secretKeyFor(secret: string): Uint8Array {
  return sha256(utf8ToBytes(`anodb/v2/secret-key/${secret}`))
}

export function keyId(epochKey: Uint8Array): string {
  return h32(`anodb/v2/key-id/${bytesToHex(epochKey)}`).slice(0, 16)
}

export const conversationKey = (sk: Uint8Array, pk: string) => nip44.getConversationKey(sk, pk)
export const encrypt = (plaintext: string, convKey: Uint8Array) => nip44.encrypt(plaintext, convKey)
export const decrypt = (payload: string, convKey: Uint8Array) => nip44.decrypt(payload, convKey)

export const sha256Hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)))

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** 22-char base62 random id (~131 bits, rejection-sampled). */
export function newId(): string {
  let out = ''
  while (out.length < 22) {
    for (const b of randomBytes(32)) {
      if (b < 248 && out.length < 22) out += ID_ALPHABET[b % 62]
    }
  }
  return out
}

// ---- AES-GCM sealing for key stores ---------------------------------------

export async function aesKeyFromBytes(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt'])
}

export async function aesSeal(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}

export async function aesOpen(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  const iv = sealed.subarray(0, 12)
  const ct = sealed.subarray(12)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource))
}
