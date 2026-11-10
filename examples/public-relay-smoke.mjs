// Checks the default public relays with real traffic (not part of `npm test`).
// Run: npm run smoke:public [relay…]
import { DEFAULT_RELAYS, createAnoDB, defineSchema, memoryKeyStore } from '../dist/index.js'
import { checkRelay } from '../dist/cli/init.js'
import { nodeSqlite } from '../dist/node.js'

const relays = process.argv.slice(2).length ? process.argv.slice(2) : [...DEFAULT_RELAYS]
console.log('1) store-and-serve check per relay')
const ok = []
for (const url of relays) {
  const good = await checkRelay(url)
  if (good) ok.push(url)
  console.log(`   ${good ? '✔' : '✖'} ${url}`)
}

console.log('2) anoDB write acknowledged by every healthy relay')
const db = await createAnoDB({
  appId: `anodb-smoke-${Date.now()}`,
  schema: defineSchema({ ping: { at: 'integer' } }),
  driver: nodeSqlite(':memory:'),
  keyStore: memoryKeyStore(),
  relays: ok,
  minAcks: ok.length,
  discoveryRelays: [],
})
db.onError((e) => console.error('   error:', e.code, e.message))
await db.insertInto('ping').values({ at: Date.now() }).execute()
const t0 = Date.now()
const s = await db.waitForSync(20_000)
console.log(`   state=${s.state} pending=${s.pendingEvents} after ${Date.now() - t0} ms`)

console.log('3) NIP-77 reconciliation per relay')
for (const url of ok) {
  const t = Date.now()
  const supported = await db.reconcile(url)
  console.log(`   ${supported ? '✔ NIP-77' : '– no NIP-77 (time-based fallback)'}  ${url}  (${Date.now() - t} ms)`)
}
console.log('   gaps:', JSON.stringify(db.syncHealth().gaps))

console.log('4) encrypted blob on each default Blossom server')
let blobsOk = true
for (const server of db.blobs.servers) {
  try {
    const ref = await db.blobs.put(new TextEncoder().encode(`anodb smoke ${Date.now()}`), { servers: [server] })
    const back = await db.blobs.get({ ...ref, servers: [server] })
    const del = (await db.blobs.delete(ref))[0]
    console.log(`   ✔ ${server}  (${back.data.length} bytes back, delete ${del.ok ? 'ok' : del.status})`)
  } catch (e) {
    blobsOk = false
    console.log(`   ✖ ${server}  ${e.reports?.[0]?.status ?? ''} ${e.reports?.[0]?.reason ?? e.message}`)
  }
}
await db.close()
process.exit(ok.length === relays.length && s.pendingEvents === 0 && blobsOk ? 0 : 1)
