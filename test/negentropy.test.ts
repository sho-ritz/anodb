import { describe, expect, it } from 'vitest'
import { randomHex } from '../src/crypto.js'
import { Negentropy } from '../src/sync/negentropy.js'
// nostr-tools' reference implementation (not exported via package.json "exports")
// @ts-expect-error untyped deep import
import * as ref from '../node_modules/nostr-tools/lib/esm/nip77.js'

const item = (t: number) => ({ created_at: t, id: randomHex(32) })

function run(client: { initiate(): string; reconcile(m: string, h?: (x: string) => void, n?: (x: string) => void): string | null }, server: { reconcile(m: string): string | null }) {
  const have: string[] = []
  const need: string[] = []
  let msg: string | null = client.initiate()
  for (let rounds = 0; msg !== null && rounds < 50; rounds++) {
    const reply = server.reconcile(msg) ?? '61'
    msg = client.reconcile(reply, (x) => have.push(x), (x) => need.push(x))
  }
  return { have: have.sort(), need: need.sort() }
}

describe('negentropy', () => {
  for (const [label, sizes] of [
    ['small sets', [10, 10, 5]],
    ['large sets with many shared items', [3000, 40, 25]],
    ['empty client', [0, 0, 100]],
  ] as const) {
    it(`finds exact differences (${label})`, () => {
      const [shared, onlyClient, onlyServer] = sizes
      const common = Array.from({ length: shared }, (_, i) => item(1000 + (i % 50)))
      const mine = Array.from({ length: onlyClient }, (_, i) => item(1000 + i))
      const theirs = Array.from({ length: onlyServer }, (_, i) => item(2000 + i))
      const r = run(new Negentropy([...common, ...mine], { initiator: true }), new Negentropy([...common, ...theirs], { initiator: false }))
      expect(r.have).toEqual(mine.map((x) => x.id).sort())
      expect(r.need).toEqual(theirs.map((x) => x.id).sort())
    })
  }

  it('is wire-compatible with the nostr-tools reference implementation', () => {
    const common = Array.from({ length: 500 }, (_, i) => item(i))
    const mine = Array.from({ length: 7 }, (_, i) => item(10_000 + i))
    const theirs = Array.from({ length: 9 }, (_, i) => item(20_000 + i))
    const storage = new ref.NegentropyStorageVector()
    for (const x of [...common, ...mine]) storage.insert(x.created_at, x.id)
    storage.seal()
    const refClient = new ref.Negentropy(storage)
    const r = run(refClient, new Negentropy([...common, ...theirs], { initiator: false }))
    expect(r.have).toEqual(mine.map((x) => x.id).sort())
    expect(r.need).toEqual(theirs.map((x) => x.id).sort())
  })
})
