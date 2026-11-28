/** FIFO async lock. */
export class Mutex {
  #p: Promise<void> = Promise.resolve()
  lock(): Promise<() => void> {
    let release!: () => void
    const next = new Promise<void>((r) => (release = r))
    const prev = this.#p
    this.#p = prev.then(() => next)
    return prev.then(() => release)
  }
}
