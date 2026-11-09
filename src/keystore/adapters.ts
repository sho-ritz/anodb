import { aesOpen, aesSeal, aesKeyFromBytes, bytesToHex, hexToBytes, randomBytes } from '../crypto.js'
import type { KeyName, KeyStore } from './types.js'

/** Minimal async string storage, e.g. expo-secure-store or a file. */
export interface SecureStringStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  deleteItem(key: string): Promise<void>
}

/**
 * Key store on top of a platform secure storage (expo-secure-store: `{ getItem: getItemAsync, … }`).
 * A random sealing key is kept in the same secure storage.
 */
export function secureStorageKeyStore(storage: SecureStringStorage, prefix = 'anodb'): KeyStore {
  const sealKey = (async () => {
    let raw = await storage.getItem(`${prefix}.seal`)
    if (!raw) {
      raw = bytesToHex(randomBytes(32))
      await storage.setItem(`${prefix}.seal`, raw)
    }
    return aesKeyFromBytes(hexToBytes(raw))
  })()
  return {
    kind: 'secure-storage',
    get: (n: KeyName) => storage.getItem(`${prefix}.${n}`),
    set: (n: KeyName, v: string) => storage.setItem(`${prefix}.${n}`, v),
    remove: (n: KeyName) => storage.deleteItem(`${prefix}.${n}`),
    seal: async (p) => aesSeal(await sealKey, p),
    open: async (s) => aesOpen(await sealKey, s),
  }
}

/** Electron `safeStorage` (OS keychain backed) + a file path for the encrypted blobs. */
export interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Uint8Array
  decryptString(encrypted: Uint8Array): string
}

export function electronKeyStore(
  safeStorage: ElectronSafeStorage,
  files: { read(name: string): Promise<Uint8Array | null>; write(name: string, data: Uint8Array): Promise<void>; remove(name: string): Promise<void> },
): KeyStore {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('anoDB: Electron safeStorage encryption is not available')
  const storage: SecureStringStorage = {
    getItem: async (k) => {
      const data = await files.read(k)
      return data ? safeStorage.decryptString(data) : null
    },
    setItem: (k, v) => files.write(k, safeStorage.encryptString(v)),
    deleteItem: (k) => files.remove(k),
  }
  return { ...secureStorageKeyStore(storage), kind: 'electron' }
}
