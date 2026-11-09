// Checks that the default public relays accept and serve anoDB change events.
// Run: npm run smoke:public   (talks to real relays; not part of `npm test`)
import { DEFAULT_RELAYS, createAnoDB, defineSchema } from '../dist/index.js'
import { nodeSqlite } from '../dist/node.js'

const relays = process.argv.slice(2).length ? process.argv.slice(2) : [...DEFAULT_RELAYS]
const schema = defineSchema({ ping: { at: 'integer' } })
const common = { appId: `anodb-smoke-${Date.now()}`, schema, relays, discoveryRelays: [] }

const a = createAnoDB({ ...common, driver: nodeSqlite(':memory:') })
const b = createAnoDB({ ...common, driver: nodeSqlite(':memory:'), secretKey: a.exportSecretKey() })
a.onError((e) => console.error('A error:', e.code, e.message))

console.log('relays:', relays.join(', '))
console.log('A status:', (await a.waitForSync(10_000)).state)
const id = a.table('ping').insert({ at: Date.now() })
const t0 = Date.now()
const sa = await a.waitForSync(15_000)
console.log(`A outbox: ${sa.pendingEvents} pending after ${Date.now() - t0} ms; connected: ${sa.connectedRelays.join(', ')}`)

const deadline = Date.now() + 15_000
while (!b.table('ping').findById(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
const ok = Boolean(b.table('ping').findById(id))
console.log(ok ? `B received the row after ${Date.now() - t0} ms` : 'B did NOT receive the row')
a.close()
b.close()
process.exit(ok ? 0 : 1)
