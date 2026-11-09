import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import type { EventTemplate, NostrEvent } from './types.js'

export type SecretKeyInput = Uint8Array | string

/** Accepts raw 32 bytes, 64-char hex, or an `nsec1…` string. */
export function parseSecretKey(input: SecretKeyInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length !== 32) throw new Error('anoDB: secret key must be 32 bytes')
    return input
  }
  if (input.startsWith('nsec1')) {
    const decoded = nip19.decode(input)
    if (decoded.type !== 'nsec') throw new Error('anoDB: expected nsec')
    return decoded.data
  }
  if (/^[0-9a-f]{64}$/i.test(input)) return hexToBytes(input.toLowerCase())
  throw new Error('anoDB: unrecognised secret key format')
}

export class OwnerKey {
  readonly secret: Uint8Array
  readonly pubkey: string
  readonly #selfKey: Uint8Array

  constructor(secret: Uint8Array) {
    this.secret = secret
    this.pubkey = getPublicKey(secret)
    // NIP-44 conversation key with ourselves: only holders of the owner secret can read.
    this.#selfKey = nip44.getConversationKey(secret, this.pubkey)
  }

  static generate(): OwnerKey {
    return new OwnerKey(generateSecretKey())
  }

  get nsec(): string {
    return nip19.nsecEncode(this.secret)
  }

  get npub(): string {
    return nip19.npubEncode(this.pubkey)
  }

  get hex(): string {
    return bytesToHex(this.secret)
  }

  encryptToSelf(plaintext: string): string {
    return nip44.encrypt(plaintext, this.#selfKey)
  }

  decryptFromSelf(payload: string): string {
    return nip44.decrypt(payload, this.#selfKey)
  }

  sign(template: EventTemplate): NostrEvent {
    return finalizeEvent(template, this.secret) as NostrEvent
  }
}

/**
 * Opaque namespace tag value. Hides the appId from relays while letting the owner filter
 * by it: hex(sha256("anodb/v1/" + appId + "/" + pubkey))[0..32]
 */
export function namespaceTag(appId: string, pubkey: string): string {
  return bytesToHex(sha256(utf8ToBytes(`anodb/v1/${appId}/${pubkey}`))).slice(0, 32)
}

export function verifySignedEvent(event: NostrEvent): boolean {
  try {
    // Copy so that nostr-tools' verification cache on the object cannot be spoofed.
    return verifyEvent({ ...event })
  } catch {
    return false
  }
}

export function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 22-char base62 random row id (~131 bits). */
export function newRowId(): string {
  const buf = crypto.getRandomValues(new Uint8Array(22))
  let out = ''
  for (const b of buf) out += ID_ALPHABET[b % 62]
  return out
}
