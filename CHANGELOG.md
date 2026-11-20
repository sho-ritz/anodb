# Changelog

## 0.13.0 — relay selection, phase 2: spaces switch to picked relays automatically

Second phase of the compatible migration (docs/DECISIONS.md, rows 29–30). Wire protocol stays
**v2**; spaces that still contain a device on a version before 0.12 keep working exactly as in 0.12.

### Automatic switch per space

- When every active device of a space announced `rp` (0.12+), an owner/admin device **rotates the
  epoch key automatically**. The key grant pins the candidate list (`rl`); from that epoch on, the
  space lives on its picked relays only.
- New spaces start there directly when all of the creator's devices are on 0.12+.
- **Switching back:** pairing a device on an older version, or inviting a member on one, puts the
  space back on the fixed relays at the next epoch. When pairing, this happens before the pairing
  answer is sent, so the older device receives the fixed-relay key directly.
- `rp` now names the device's candidate list (bundled version number, or 8 hex of a custom list's
  hash) and is also sent in inbox messages, key packages and pairing links.

### Reading and writing picked relays (DECISIONS 29 ③–⑤)

- After a switch, the earlier fixed-relay epochs are still read for **30 days**. After a later
  epoch change, the previous epoch's picked relays are read for `relayGraceDays` (default **7**).
  Older epochs are read only by `repair()`.
- Writes go to the first 5 reachable relays of the top 10, and stay in the outbox until 5 accepted
  them. When the top relays come back, they get a re-signed copy.
- Every device checks ranks 6–10 periodically (`relayCheckIntervalMs`, default 10 min) and copies
  what it finds there to the top 5, so an envelope is found even if its writer never returns.
- Sequence gaps trigger a time-range query over the top 10. `repair()` reads every relay that may
  hold a tag, retired epochs included.
- Connections:
  - Spaces get live connections up to `maxAutoRelays` (default now **10**, was 20). The personal
    space, or the one passed to `db.focusSpace()`, comes first.
  - Other spaces are polled every `relayPollIntervalMs` (default 3 min).
  - The device's own inbox and a pending pairing link are always live.
- Inboxes and pairing links still go to the fixed relays, with copies on picked relays (phase 3
  changes this).

### API

- New options: `relayGraceDays`, `relayPollIntervalMs`, `relayCheckIntervalMs`.
- New method: `db.focusSpace(space | null)`.
- New exports: `RELAY_CANDIDATE_VERSIONS`, `candidateListId`.
- `RelayPool.publish` connects temporarily to relays outside the pool, like `query`.

### Compatibility notes

- **Versions before 0.12 cannot follow a space on picked relays.** Pairing or inviting them
  switches the space back, but a device that reaches a switched space another way (for example an
  old backup) will not see its new data until the next epoch.
- Key grants carry the pinned candidate list (about 10 KB for version 1).
- Writes to spaces beyond the live budget, and the check of ranks 6–10, open short-lived connections.
- The candidate list is still version 1 (provisional). Narrow it before relying on phase 2 in
  production.

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

### Compatibility

- Wire protocol stays **v2**. 0.12.0 and older versions sync with each other in the same space.
- More connections: up to 5 fixed relays plus up to `maxAutoRelays` picked ones.
- The candidate list is **version 1, provisional**: 337 relays that answered every check of the
  relay survey on 2026-11-20/21 (`scripts/relay-survey/`). Retention (7/30 days) and the
  operator/software/region caps are not yet applied; later versions will narrow it to about 100.

### Next phases (not in this release)

- **Phase 2:** once every active device of a space sends `rp: 1`, an admin device switches the space
  automatically at the next epoch: new data goes to the picked relays only, the fixed relays are
  still read for 30 days. The candidate list version is pinned in the space's signed settings, and
  the fault-tolerance rules (ranks 6–10, time-range gap queries) are added.
- **Phase 3:** stop using the fixed relays once old versions are gone. Inbox messages and
  invite/pairing links keep going to the fixed relays until then.
