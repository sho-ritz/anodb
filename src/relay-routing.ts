import { sha256Hex } from './crypto.js'
import { normalizeRelayUrl } from './relay-pool.js'

/** Automatically picked relays a device reads and writes per routing seed (DECISIONS 29 ⑤). */
export const AUTO_RELAYS_PER_SEED = 5

/**
 * Rendezvous (highest random weight) ranking of `candidates` for one secret seed: the epoch key
 * (hex) for a space, the device pubkey for an inbox, the link secret for pairing. Every device
 * holding the same seed and the same candidate list gets the same order; someone without the seed
 * (a removed member, a relay) cannot tell which relays it lands on.
 */
export function rankRelays(seed: string, candidates: readonly string[]): string[] {
  const k = sha256Hex(`anodb/v2/relays/${seed}`)
  return candidates
    .map((url) => [url, sha256Hex(`${k}/${url}`)] as const)
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([url]) => url)
}

export interface RouteSeed {
  seed: string
  /** Lower first when the relay budget runs out (0: inbox / pairing, 1: current epoch, 2: older epochs). */
  prio: number
}

/**
 * Migration phase 1 (DECISIONS 30): every tag keeps the fixed relays, and the tags this device
 * subscribes to are also routed to their top automatically picked relays, within a connection budget.
 */
export class RelayRouter {
  readonly fixed: readonly string[]
  readonly #candidates: readonly string[]
  readonly #maxAuto: number
  readonly #ranked = new Map<string, string[]>()
  #routes = new Map<string, string[]>()

  constructor(fixed: readonly string[], candidates: readonly string[] | null, maxAuto: number) {
    this.fixed = [...new Set(fixed.map(normalizeRelayUrl))]
    this.#candidates = candidates ? [...new Set(candidates.map(normalizeRelayUrl))] : []
    this.#maxAuto = Math.max(0, maxAuto)
  }

  get enabled(): boolean {
    return this.#candidates.length > 0 && this.#maxAuto > 0
  }

  #top(seed: string): string[] {
    let r = this.#ranked.get(seed)
    if (!r) {
      r = rankRelays(seed, this.#candidates).slice(0, AUTO_RELAYS_PER_SEED)
      if (this.#ranked.size > 1000) this.#ranked.clear()
      this.#ranked.set(seed, r)
    }
    return r
  }

  /**
   * Recompute the automatic part of every tag's route. Tags are taken by priority; a tag whose
   * relays would push the number of extra (non-fixed) connections over the budget stays fixed-only.
   * Returns every relay the pool should keep connected.
   */
  plan(tags: Array<{ tag: string; route: RouteSeed | null }>): string[] {
    const routes = new Map<string, string[]>()
    const fixed = new Set(this.fixed)
    const extra = new Set<string>()
    if (this.enabled) {
      const ordered = tags.filter((t) => t.route).sort((a, b) => a.route!.prio - b.route!.prio)
      for (const { tag, route } of ordered) {
        const top = this.#top(route!.seed)
        const added = top.filter((r) => !fixed.has(r) && !extra.has(r))
        if (extra.size + added.length > this.#maxAuto) continue
        for (const r of added) extra.add(r)
        routes.set(tag, top)
      }
    }
    this.#routes = routes
    return [...this.fixed, ...extra]
  }

  /** Automatically picked relays for a tag (empty when not routed). */
  auto(tag: string): readonly string[] {
    return this.#routes.get(tag) ?? []
  }

  /** Fixed relays plus the tag's automatically picked ones, without duplicates. */
  relaysFor(tag: string): string[] {
    const auto = this.#routes.get(tag)
    return auto ? [...new Set([...this.fixed, ...auto])] : [...this.fixed]
  }

  /** Whether this device reads `tag` on `relay`. */
  reads(tag: string, relay: string): boolean {
    return this.fixed.includes(relay) || (this.#routes.get(tag)?.includes(relay) ?? false)
  }
}
