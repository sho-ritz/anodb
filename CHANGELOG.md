# Changelog

## Unreleased — self-hosted relay on Cloudflare

- `npx anodb relay deploy`: deploys a Nostr relay to your Cloudflare account, on Workers with a
  SQLite-backed Durable Object. It uses Wrangler's browser login and prints the `wss://` URL.
  Running it again updates the same Worker and keeps the stored events.
- `npx anodb relay dev` runs the same relay locally, and `--dry-run` only builds it.
- The relay supports NIP-01, 09, 11 and 77. By default it accepts only the kinds anoDB uses.
  Subscriptions are stored in SQL, so they survive WebSocket hibernation.

## 0.12.0 — automatic relay selection, phase 1 (compatible)

anoDB is moving from a few fixed relays to relays **picked per space from a vetted candidate list**
(docs/DECISIONS.md, rows 29–30). The move happens in three phases so that devices on older versions
never lose sync. **This release is phase 1: nothing is removed, the picked relays are added.**

### What changes

- Envelopes are still written to and read from the fixed relays (`DEFAULT_RELAYS`), exactly as before.
- In addition, each space (per epoch key), this device's inbox and an open pairing link are routed
  to **5 relays picked from `RELAY_CANDIDATES`** by rendezvous hashing over a secret seed (epoch
  key / device pubkey / link secret). Members of a space land on the same relays; relays and
  removed members cannot tell which ones.
- A write counts as delivered when the fixed relays accepted it (`minAcks`), as before. The picked
  relays get extra copies (sent when they connect, and topped up by NIP-77 reconciliation).
- Devices that read the picked relays add `rp: 1` to their space messages. Older versions ignore it.
  Phase 2 uses it to know when a space can switch.
- Ephemeral events (`db.emit`) follow the same routes. WebRTC signaling stays on the fixed relays.

### Options

- `autoRelays` — on by default; **off when you pass `relays`** (your relays stay exactly as
  configured). Pass `autoRelays: true` to add picked relays to your own.
- `relayCandidates` — replace the bundled candidate list.
- `maxAutoRelays` — at most this many extra connections (default 20). Tags beyond the budget stay on
  the fixed relays only.
- New exports: `RELAY_CANDIDATES`, `RELAY_CANDIDATES_VERSION`, `rankRelays`.

### `@anodb/cli` 0.12.0

- Depends on `@anodb/core` `^0.12.0` (with 0.x versions, `^0.11.0` would have kept installs on 0.11).
- The setup wizard's relay choice now reads "Pick automatically (recommended)" / "Enter my own (turns
  automatic selection off)". The generated code is unchanged: the default writes no `relays`
  option, so automatic selection is on.

### Compatibility

- Wire protocol stays **v2**. 0.12.0 and older versions sync with each other in the same space.
- More connections: up to 5 fixed relays plus up to `maxAutoRelays` picked ones.
- The candidate list is **version 1, provisional**: 337 relays that answered every check of the
  relay survey on 2026-11-20/21 (`scripts/relay-survey/`). Retention (7/30 days) and the
  operator/software/region caps are not yet applied; later versions keep every relay that passes the full criteria
  under those caps (no fixed size, at least 20).

### Next phases (not in this release)

- **Phase 2:** once every active device of a space sends `rp: 1`, an admin device switches the space
  automatically at the next epoch: new data goes to the picked relays only, the fixed relays are
  still read for 30 days. The candidate list version is pinned in the space's signed settings, and
  the fault-tolerance rules (ranks 6–10, time-range gap queries) are added.
- **Phase 3:** stop using the fixed relays once old versions are gone. Inbox messages and
  invite/pairing links keep going to the fixed relays until then.
