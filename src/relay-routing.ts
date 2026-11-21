import { sha256Hex } from './crypto.js'
import { normalizeRelayUrl } from './relay-pool.js'

/** Automatically picked relays a device reads per tag (DECISIONS 29 ⑤). */
export const AUTO_RELAYS_PER_SEED = 5
/** Ranks used at most: writes fall through to ranks 6–10 when top ones are down; the periodic check reads them. */
export const AUTO_RELAY_RANKS = 10

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

/**
 * Id of a candidate list, sent as `rp` so others can route to this device's inbox: the bundled
 * version number, or the first 8 hex of the hash of a custom list.
 */
export function candidateListId(list: readonly string[], bundled: Readonly<Record<number, readonly string[]>>): number | string {
  const norm = [...new Set(list.map(normalizeRelayUrl))].sort()
  const key = norm.join('\n')
  for (const [v, l] of Object.entries(bundled)) if ([...new Set(l.map(normalizeRelayUrl))].sort().join('\n') === key) return Number(v)
  return sha256Hex(key).slice(0, 8)
}

/** How one routing tag uses relays (DECISIONS 30). */
export interface TagRoute {
  /** Lower first when the connection budget runs out; 0 (own inbox, pending pairing) is always live and not counted. */
  prio: number
  /** Also use the fixed relays (read and write). */
  fixed: boolean
  /** Seed and candidate list for the automatically picked part (omitted: none). */
  auto?: { seed: string; list: readonly string[] }
  /**
   * Phase 2+: the picked relays are the store — a write needs 5 acceptances within the top 10.
   * Otherwise (phase 1) delivery is judged on the fixed relays and the picked ones get extra copies.
   */
  primary: boolean
}

export interface PlannedRoute {
  route: TagRoute
  fixed: readonly string[]
  /** Top 10 (primary) or top 5 (extra copies) picked relays. */
  ranks: readonly string[]
  /** Read live over persistent connections (within the budget); otherwise polled (primary) or fixed-only (extra). */
  live: boolean
}

/**
 * Plans which relays each tag uses and which connections stay open: fixed relays while some tag
 * needs them, plus picked relays of the highest-priority tags up to `maxAuto` extra connections.
 */
export class RelayRouter {
  readonly fixed: readonly string[]
  readonly candidates: readonly string[]
  readonly #maxAuto: number
  readonly #ranked = new Map<string, string[]>()
  #plan = new Map<string, PlannedRoute>()
  #fixedNeeded = true

  constructor(fixed: readonly string[], candidates: readonly string[] | null, maxAuto: number) {
    this.fixed = [...new Set(fixed.map(normalizeRelayUrl))]
    this.candidates = candidates ? [...new Set(candidates.map(normalizeRelayUrl))] : []
    this.#maxAuto = Math.max(0, maxAuto)
  }

  get enabled(): boolean {
    return this.candidates.length > 0
  }

  /** Whether some planned tag still uses the fixed relays. */
  get fixedNeeded(): boolean {
    return this.#fixedNeeded
  }

  ranks(seed: string, list: readonly string[], n: number): string[] {
    const key = `${seed}\u0000${list.length}\u0000${list[0] ?? ''}`
    let r = this.#ranked.get(key)
    if (!r) {
      r = rankRelays(seed, list.map(normalizeRelayUrl)).slice(0, AUTO_RELAY_RANKS)
      if (this.#ranked.size > 2000) this.#ranked.clear()
      this.#ranked.set(key, r)
    }
    return r.slice(0, n)
  }

  /** Route of any tag (planned or not, e.g. another device's inbox). */
  resolve(tag: string, route: TagRoute | null): PlannedRoute {
    const planned = this.#plan.get(tag)
    if (planned && (!route || sameRoute(planned.route, route))) return planned
    return this.#build(route ?? { prio: 9, fixed: true, primary: false }, false)
  }

  #build(route: TagRoute, live: boolean): PlannedRoute {
    const useAuto = this.enabled && route.auto !== undefined
    const fixed = route.fixed || !useAuto ? this.fixed : []
    const ranks = useAuto ? this.ranks(route.auto!.seed, route.auto!.list, route.primary ? AUTO_RELAY_RANKS : AUTO_RELAYS_PER_SEED) : []
    return { route: { ...route, primary: useAuto && route.primary }, fixed, ranks, live }
  }

  /** Recompute routes for the live tags. Returns every relay the pool should keep connected. */
  plan(tags: Array<{ tag: string; route: TagRoute | null }>): string[] {
    const plan = new Map<string, PlannedRoute>()
    const extra = new Set<string>()
    let essential = 0
    const ordered = [...tags].sort((a, b) => (a.route?.prio ?? 9) - (b.route?.prio ?? 9))
    let fixedNeeded = !this.enabled
    for (const { tag, route } of ordered) {
      const p = this.#build(route ?? { prio: 9, fixed: true, primary: false }, true)
      const read = p.ranks.slice(0, AUTO_RELAYS_PER_SEED).filter((r) => !this.fixed.includes(r) || p.fixed.length === 0)
      const added = read.filter((r) => !extra.has(r))
      // Priority 0 (own inbox, a pending pairing link) is always live: keys and pairing arrive there.
      if (added.length > 0 && p.route.prio > 0 && extra.size - essential + added.length > this.#maxAuto) {
        // Over budget: extra copies are dropped (the fixed relays hold the data), primary tags are polled.
        plan.set(tag, p.route.primary ? { ...p, live: false } : { ...p, ranks: [], live: true })
      } else {
        for (const r of added) extra.add(r)
        if (p.route.prio === 0) essential += added.length
        plan.set(tag, p)
      }
      if (plan.get(tag)!.fixed.length > 0) fixedNeeded = true
    }
    this.#plan = plan
    this.#fixedNeeded = fixedNeeded
    return [...(fixedNeeded ? this.fixed : []), ...extra].filter((r, i, a) => a.indexOf(r) === i)
  }

  planned(): ReadonlyMap<string, PlannedRoute> {
    return this.#plan
  }

  /** Whether this device reads `tag` live on `relay`. */
  reads(tag: string, relay: string): boolean {
    const p = this.#plan.get(tag)
    if (!p) return false
    return p.fixed.includes(relay) || (p.live && p.ranks.slice(0, AUTO_RELAYS_PER_SEED).includes(relay))
  }

  /** Every relay that may hold `tag` (fixed part and all used ranks): for repair and one-off sends. */
  relaysFor(tag: string, route: TagRoute | null = null): string[] {
    const p = this.resolve(tag, route)
    return [...new Set([...p.fixed, ...p.ranks])]
  }
}

function sameRoute(a: TagRoute, b: TagRoute): boolean {
  return a.fixed === b.fixed && a.primary === b.primary && a.auto?.seed === b.auto?.seed && a.auto?.list === b.auto?.list
}
