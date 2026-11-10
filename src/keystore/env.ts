import { sha256 } from '@noble/hashes/sha2.js'
import { aesKeyFromBytes, aesOpen, aesSeal, parseSecretKey } from '../crypto.js'
import type { KeyName, KeyStore } from './types.js'

const VARS: Record<KeyName, string> = {
  identity: 'ANODB_IDENTITY_KEY',
  device: 'ANODB_DEVICE_KEY',
  delegation: 'ANODB_DELEGATION',
}

/**
 * Node default: reads `ANODB_DEVICE_KEY` and `ANODB_DELEGATION` (written by `npx @anodb/cli init`).
 * Read-only. Group keys in SQLite are sealed with a key derived from the device key.
 */
export function envKeyStore(env: Record<string, string | undefined> = globalThis.process?.env ?? {}): KeyStore {
  const read = (n: KeyName) => {
    const v = env[VARS[n]]
    if (!v) return null
    return n === 'delegation' && !v.trim().startsWith('{') ? new TextDecoder().decode(base64ToBytes(v.trim())) : v.trim()
  }
  const device = read('device')
  if (!device || !read('delegation')) {
    throw new Error(
      'anoDB: ANODB_DEVICE_KEY / ANODB_DELEGATION are not set. Run `npx @anodb/cli init` to create them, ' +
        'or pass `keyStore` (e.g. memoryKeyStore() for tests).',
    )
  }
  const sealKey = aesKeyFromBytes(sha256(new Uint8Array([...parseSecretKey(device), ...new TextEncoder().encode('anodb/v2/seal')])))
  return {
    kind: 'env',
    get: async (n) => read(n),
    set: async (n) => {
      throw new Error(`anoDB: envKeyStore is read-only (tried to store ${n}); run \`npx @anodb/cli init\``)
    },
    remove: async () => {},
    seal: async (p) => aesSeal(await sealKey, p),
    open: async (s) => aesOpen(await sealKey, s),
  }
}

export function bytesToBase64(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}
export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
