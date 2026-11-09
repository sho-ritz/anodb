import { getPublicKey, parseSecretKey, signWith, verifySignedEvent, type SecretKeyInput } from './crypto.js'
import type { EventTemplate, NostrEvent } from './types.js'

/**
 * Signs with the user's identity key. anoDB calls it only to register/revoke devices, publish the
 * key package and publish public events — never for regular writes, so it works offline after setup.
 */
export interface Signer {
  readonly kind: string
  getPublicKey(): Promise<string>
  signEvent(template: EventTemplate): Promise<NostrEvent>
}

async function checked(signer: Signer, template: EventTemplate, event: NostrEvent): Promise<NostrEvent> {
  if (!verifySignedEvent(event) || event.pubkey !== (await signer.getPublicKey()) || event.kind !== template.kind) {
    throw new Error(`anoDB: ${signer.kind} signer returned an invalid event`)
  }
  return event
}

/** Signer holding the secret key in memory. */
export function localSigner(secret: SecretKeyInput): Signer & { readonly secretKey: Uint8Array } {
  const sk = parseSecretKey(secret)
  const pk = getPublicKey(sk)
  return {
    kind: 'local',
    secretKey: sk,
    getPublicKey: async () => pk,
    signEvent: async (t) => signWith(sk, t),
  }
}

interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(t: EventTemplate): Promise<NostrEvent>
}

/** NIP-07 browser extension (nos2x, Alby, …). */
export function nip07Signer(provider?: Nip07): Signer {
  const get = () => {
    const p = provider ?? (globalThis as { nostr?: Nip07 }).nostr
    if (!p) throw new Error('anoDB: no NIP-07 extension found (window.nostr)')
    return p
  }
  let pk: Promise<string> | null = null
  const signer: Signer = {
    kind: 'nip07',
    getPublicKey: () => (pk ??= get().getPublicKey()),
    signEvent: async (t) => checked(signer, t, await get().signEvent(t)),
  }
  return signer
}

/**
 * NIP-46 remote signer. `uri` is a `bunker://…` URL. The client key identifies this app to the
 * bunker; persist it (e.g. in your key store) to avoid re-approval on every start.
 */
export function nip46Signer(uri: string, opts: { clientSecretKey?: Uint8Array; timeoutMs?: number } = {}): Signer & { close(): Promise<void> } {
  type Bunker = {
    connect(): Promise<void>
    getPublicKey(): Promise<string>
    signEvent(t: EventTemplate): Promise<NostrEvent>
    close(): Promise<void>
  }
  let bunker: Promise<Bunker> | null = null
  const load = () =>
    (bunker ??= (async () => {
      const [{ BunkerSigner, parseBunkerInput }, { generateSecretKey }] = await Promise.all([
        import('nostr-tools/nip46'),
        import('nostr-tools/pure'),
      ])
      const bp = await parseBunkerInput(uri)
      if (!bp) throw new Error('anoDB: invalid bunker URI')
      const params = opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}
      const b = BunkerSigner.fromBunker(opts.clientSecretKey ?? generateSecretKey(), bp, params) as unknown as Bunker
      await b.connect()
      return b
    })())
  let pk: Promise<string> | null = null
  const signer = {
    kind: 'nip46',
    getPublicKey: () => (pk ??= load().then((b) => b.getPublicKey())),
    signEvent: async (t: EventTemplate) => checked(signer, t, await (await load()).signEvent(t)),
    close: async () => {
      if (bunker) await (await bunker).close()
    },
  }
  return signer
}

/**
 * NIP-55 Android signer (Amber, …). Launching Android intents needs native code, so you pass a
 * bridge (e.g. built on expo-intent-launcher or a NIP-55 React Native module).
 */
export interface Nip55Bridge {
  getPublicKey(): Promise<string>
  /** Must return the full signed event (JSON object). */
  signEvent(unsignedEventJson: string, currentUserPubkey: string): Promise<NostrEvent>
}

export function nip55Signer(bridge: Nip55Bridge): Signer {
  let pk: Promise<string> | null = null
  const signer: Signer = {
    kind: 'nip55',
    getPublicKey: () => (pk ??= bridge.getPublicKey()),
    signEvent: async (t) => {
      const me = await signer.getPublicKey()
      return checked(signer, t, await bridge.signEvent(JSON.stringify({ ...t, pubkey: me }), me))
    },
  }
  return signer
}
