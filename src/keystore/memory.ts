import { aesKeyFromBytes, aesOpen, aesSeal, randomBytes } from '../crypto.js'
import type { KeyName, KeyStore } from './types.js'

/** Keeps secrets in memory only. For tests and throwaway databases (pair with an in-memory SQLite). */
export function memoryKeyStore(initial: Partial<Record<KeyName, string>> = {}): KeyStore {
  const values = new Map<KeyName, string>(Object.entries(initial) as Array<[KeyName, string]>)
  const key = aesKeyFromBytes(randomBytes(32))
  return {
    kind: 'memory',
    get: async (n) => values.get(n) ?? null,
    set: async (n, v) => void values.set(n, v),
    remove: async (n) => void values.delete(n),
    seal: async (p) => aesSeal(await key, p),
    open: async (s) => aesOpen(await key, s),
  }
}
