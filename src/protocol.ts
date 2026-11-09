import { isHlc } from './hlc.js'

/** Protocol version carried inside the encrypted payload. Independent of the npm version. */
export const PROTOCOL_VERSION = 1

/**
 * Regular (stored, non-replaceable) event kind for encrypted anoDB change batches.
 * Provisional: to be checked against the NIP registry before v1.
 */
export const CHANGE_KIND = 7303

/** Tag carrying the opaque namespace (see `namespaceTag`). Single-letter so relays index it. */
export const NAMESPACE_TAG = 'n'

/** NIP-44 v2 plaintext limit is 65535 bytes; stay below it and below common relay limits. */
export const MAX_PLAINTEXT_BYTES = 48 * 1024

/** [table, rowId, column, value, hlc] */
export type Change = readonly [table: string, rowId: string, column: string, value: unknown, hlc: string]

export interface ChangePayload {
  v: number
  changes: Change[]
}

const NAME_RE = /^\$?[A-Za-z][A-Za-z0-9_]*$/
const MAX_ROW_ID = 128

export function encodePayload(changes: Change[]): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, changes } satisfies ChangePayload)
}

/** Parse and validate a decrypted payload. Returns null if it is malformed or from a newer protocol. */
export function decodePayload(plaintext: string): ChangePayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { v, changes } = parsed as Record<string, unknown>
  if (v !== PROTOCOL_VERSION || !Array.isArray(changes)) return null
  for (const c of changes) {
    if (!isChange(c)) return null
  }
  return { v, changes: changes as Change[] }
}

function isChange(c: unknown): c is Change {
  if (!Array.isArray(c) || c.length !== 5) return false
  const [table, rowId, column, , hlc] = c
  return (
    typeof table === 'string' &&
    NAME_RE.test(table) &&
    !table.startsWith('$') &&
    typeof rowId === 'string' &&
    rowId.length > 0 &&
    rowId.length <= MAX_ROW_ID &&
    typeof column === 'string' &&
    NAME_RE.test(column) &&
    isHlc(hlc)
  )
}

const encoder = new TextEncoder()

/**
 * Split a transaction into payloads under `maxBytes`. Changes of one row stay together
 * where possible; a single oversized change throws.
 */
export function splitChanges(changes: Change[], maxBytes = MAX_PLAINTEXT_BYTES): Change[][] {
  if (changes.length === 0) return []
  if (encoder.encode(encodePayload(changes)).length <= maxBytes) return [changes]
  if (changes.length === 1) {
    const [t, r, c] = changes[0]!
    throw new Error(`anoDB: value of ${t}.${c} (row ${r}) exceeds ${maxBytes} bytes; store large data as a blob`)
  }
  const mid = Math.ceil(changes.length / 2)
  return [...splitChanges(changes.slice(0, mid), maxBytes), ...splitChanges(changes.slice(mid), maxBytes)]
}
