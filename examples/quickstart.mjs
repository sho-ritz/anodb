// Minimal usage. Run twice with the same ANODB_KEY on two machines to see sync:
//   node examples/quickstart.mjs "buy milk"
import { createAnoDB, defineSchema } from '../dist/index.js'
import { nodeSqlite } from '../dist/node.js'

const schema = defineSchema({
  todo: { title: 'text', done: 'boolean' },
})

const db = createAnoDB({
  appId: 'com.example.todo',
  schema,
  driver: nodeSqlite(process.env.ANODB_FILE ?? 'todo.sqlite'),
  ...(process.env.ANODB_KEY ? { secretKey: process.env.ANODB_KEY } : {}),
})

console.log('owner:', db.npub)
console.log('export this to sync another device: ANODB_KEY=' + db.exportSecretKey())

const title = process.argv[2]
if (title) db.table('todo').insert({ title, done: false })

await db.waitForSync(10_000)
for (const t of db.table('todo').findMany({ orderBy: { createdAt: 'asc' } })) {
  console.log(`${t.done ? '[x]' : '[ ]'} ${t.title}`)
}
console.log('status:', db.status)
db.close()
