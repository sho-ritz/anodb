/**
 * Hybrid Logical Clock. Encoded as a fixed-width string so that lexicographic order equals
 * causal-then-node order:  <millis base36, 10><counter base36, 5>-<nodeId hex, 16>
 */
const MILLIS_W = 10
const COUNTER_W = 5
const MAX_COUNTER = 36 ** COUNTER_W - 1
export const NODE_ID_RE = /^[0-9a-f]{16}$/
const HLC_RE = /^[0-9a-z]{15}-[0-9a-f]{16}$/

export interface Timestamp {
  millis: number
  counter: number
  node: string
}

export function encodeHlc(t: Timestamp): string {
  return `${t.millis.toString(36).padStart(MILLIS_W, '0')}${t.counter.toString(36).padStart(COUNTER_W, '0')}-${t.node}`
}

export function decodeHlc(s: string): Timestamp {
  if (!HLC_RE.test(s)) throw new Error(`anoDB: invalid HLC "${s}"`)
  return {
    millis: parseInt(s.slice(0, MILLIS_W), 36),
    counter: parseInt(s.slice(MILLIS_W, MILLIS_W + COUNTER_W), 36),
    node: s.slice(MILLIS_W + COUNTER_W + 1),
  }
}

export function isHlc(s: unknown): s is string {
  return typeof s === 'string' && HLC_RE.test(s)
}

export class Clock {
  #millis = 0
  #counter = 0
  readonly node: string
  readonly now: () => number

  constructor(node: string, last?: string, now: () => number = Date.now) {
    if (!NODE_ID_RE.test(node)) throw new Error('anoDB: nodeId must be 16 lowercase hex chars')
    this.node = node
    this.now = now
    if (last) this.receive(last)
  }

  /** Timestamp for a local event. */
  tick(): string {
    const wall = this.now()
    if (wall > this.#millis) {
      this.#millis = wall
      this.#counter = 0
    } else {
      this.#bump()
    }
    return this.current()
  }

  /** Merge a remote timestamp so later local writes sort after it. */
  receive(remote: string): void {
    const r = decodeHlc(remote)
    const wall = this.now()
    if (wall > this.#millis && wall > r.millis) {
      this.#millis = wall
      this.#counter = 0
    } else if (r.millis > this.#millis) {
      this.#millis = r.millis
      this.#counter = r.counter
    } else if (r.millis === this.#millis) {
      this.#counter = Math.max(this.#counter, r.counter)
    }
  }

  current(): string {
    return encodeHlc({ millis: this.#millis, counter: this.#counter, node: this.node })
  }

  #bump(): void {
    if (this.#counter >= MAX_COUNTER) {
      this.#millis += 1
      this.#counter = 0
    } else {
      this.#counter += 1
    }
  }
}
