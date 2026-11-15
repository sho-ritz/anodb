/**
 * Default relays. Must accept regular events of unknown kinds.
 * Checked 2026-11-15 with `npm run smoke:public`: relay.damus.io was down (HTTP 521) and
 * offchain.pub refuses pubkeys outside its web of trust (every throwaway envelope key), so both
 * were dropped; nos.lol and nostr.mom store kind 7303 again. Revalidate before each release.
 */
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://relay.snort.social',
  'wss://nos.lol',
  'wss://nostr.mom',
]

/** Relays commonly indexing kind 0 / 10002 for discovery (NIP-65 outbox model). */
export const DEFAULT_DISCOVERY_RELAYS: readonly string[] = ['wss://purplepag.es', 'wss://relay.primal.net']

/** Seconds subtracted from sync cursors to tolerate clock skew and late relay arrival. */
export const CURSOR_SKEW_SEC = 600

/** Outbox events older than this are re-signed with a fresh created_at before resending. */
export const RESIGN_AFTER_SEC = 300

export const BACKFILL_PAGE = 500
