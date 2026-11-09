/**
 * Default relays. Must accept regular events of unknown kinds.
 * Checked 2026-11-09 with `npm run smoke:public` (nos.lol and nostr.mom did not store kind 7303).
 * Revalidate before each release.
 */
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://offchain.pub',
]

/** Relays commonly indexing kind 0 / 10002 for discovery (NIP-65 outbox model). */
export const DEFAULT_DISCOVERY_RELAYS: readonly string[] = ['wss://purplepag.es', 'wss://relay.damus.io']

/** Seconds subtracted from sync cursors to tolerate clock skew and late relay arrival. */
export const CURSOR_SKEW_SEC = 600

/** Outbox events older than this are re-signed with a fresh created_at before resending. */
export const RESIGN_AFTER_SEC = 300

export const BACKFILL_PAGE = 500
