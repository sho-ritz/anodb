/** Names of secrets a key store holds. */
export type KeyName = 'identity' | 'device' | 'delegation'

/**
 * Where anoDB keeps its secrets. `seal`/`open` protect other secrets (group keys) that are
 * stored in SQLite, so a stolen database file alone does not reveal them.
 */
export interface KeyStore {
  readonly kind: string
  get(name: KeyName): Promise<string | null>
  set(name: KeyName, value: string): Promise<void>
  remove(name: KeyName): Promise<void>
  seal(plaintext: Uint8Array): Promise<Uint8Array>
  open(sealed: Uint8Array): Promise<Uint8Array>
}
