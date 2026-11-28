import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Prompter, copySqlJsAssets, detectDatabase, detectEnv, runInit, wireProvider } from '../src/cli/init.js'
import { PGlite } from '@electric-sql/pglite'
import { createAnoDB, defineSchema, pgDriver, pgliteDriver } from '../src/index.js'
import { envKeyStore } from '../src/keystore/env.js'
import { nodeSqlite } from '../src/node.js'
import { TEST_PG_URL, freshPgDatabase, onCleanup, pgPool } from './helpers/setup.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'anodb-init-'))

async function reachable(url: string): Promise<boolean> {
  const { default: pg } = await import('pg')
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 })
  try {
    await c.connect()
    await c.end()
    return true
  } catch {
    return false
  }
}
const pgUp = await reachable(TEST_PG_URL)

/** Scripted prompter: answers questions in order and records the output. */
function scripted(answers: unknown[]) {
  const log: string[] = []
  const questions: string[] = []
  const next = (q: string) => {
    questions.push(q)
    if (answers.length === 0) throw new Error(`unexpected question: ${q}`)
    return answers.shift()
  }
  const p: Prompter = {
    // a number picks that choice, null takes the default, anything else is the value itself
    select: async (q, choices, defaultIndex) => {
      const a = next(q)
      if (a === null) return choices[defaultIndex]!.value
      return typeof a === 'number' ? choices[a]!.value : (a as never)
    },
    input: async (q, d) => (next(q) as string) || d,
    confirm: async (q) => next(q) as boolean,
    log: (l) => log.push(l),
  }
  return { p, log, questions }
}

describe('anodb init', () => {
  it('asks the language first and then speaks it (interactive, Node)', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'my-bot' }))
    // lang=ja, env=node(4), db=SQLite(0), appId, new identity(0), device name, default relays(0), no check, no install
    const s = scripted([0, 4, 0, 'my-bot', 0, 'bot-1', 0, false, false])
    const res = await runInit({}, { cwd, prompter: s.p, env: { LANG: 'en_US.UTF-8' } })
    expect(s.questions[0]).toBe('Language / 言語')
    expect(s.questions[1]).toBe('実行環境は？')
    expect(s.questions[2]).toBe('データベースは？')
    expect(res).toMatchObject({ env: 'node', db: 'sqlite', appId: 'my-bot' })
    expect(res.recoveryKey).toMatch(/^nsec1/)
    expect(s.log.join('\n')).toContain(res.recoveryKey!)

    // .env holds device key + delegation, never the identity key; .gitignore protects it
    const dotenv = readFileSync(join(cwd, '.env'), 'utf8')
    expect(dotenv).toMatch(/^ANODB_DEVICE_KEY=nsec1/m)
    expect(dotenv).toMatch(/^ANODB_DELEGATION=/m)
    expect(dotenv).not.toContain(res.recoveryKey!)
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain('.env')

    // the generated keys actually open a database
    const vars = Object.fromEntries(dotenv.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    const db = await createAnoDB({
      appId: vars.ANODB_APP_ID!,
      schema: defineSchema({ t: { a: 'text' } }),
      driver: nodeSqlite(':memory:'),
      keyStore: envKeyStore(vars),
      relays: [],
    })
    onCleanup(() => db.close())
    await db.insertInto('t').values({ a: 'hello' }).execute()
    expect(() => db.exportIdentityKey()).toThrow(/not stored/)
    expect(readFileSync(join(cwd, 'src/anodb/db.js'), 'utf8')).toContain("from '@anodb/core/node'")
  })

  it('never creates keys for browser apps and honours flags non-interactively', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '1', 'react-dom': '1', vite: '1' } }))
    writeFileSync(join(cwd, 'tsconfig.json'), '{}')
    expect(detectEnv(cwd)).toEqual({ env: 'browser', framework: 'react' })
    const installs: string[][] = []
    const s = scripted([])
    const res = await runInit(
      { yes: true, lang: 'en', keys: 'recovery', relays: ['wss://relay.example'], install: true },
      { cwd, prompter: s.p, install: async (pm, pkgs) => void installs.push([pm, ...pkgs]), copyAssets: () => 'public/anodb' },
    )
    expect(res).toMatchObject({ env: 'browser', framework: 'react', recoveryKey: null })
    expect(res.files).toEqual(['src/anodb/schema.ts', 'src/anodb/db.ts', 'src/anodb/provider.tsx'])
    expect(readFileSync(join(cwd, 'src/anodb/provider.tsx'), 'utf8')).toContain("from '@anodb/core/react'")
    const dbTs = readFileSync(join(cwd, 'src/anodb/db.ts'), 'utf8')
    expect(dbTs).toContain("identity: 'recovery'")
    expect(dbTs).toContain('wss://relay.example')
    expect(dbTs).toContain('browserDriver({ name: "web" })')
    expect(installs).toEqual([['npm', '@anodb/core', 'sql.js']])
    expect(() => readFileSync(join(cwd, '.env'))).toThrow()
    // assets stay in sync on every install, and are not committed
    expect(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts.postinstall).toBe('anodb assets')
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain('public/anodb/')
    expect(s.log.join('\n')).toContain('public/anodb/')
  })

  it('wires <DBProvider> into a Next.js layout', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'next-app', scripts: { postinstall: 'echo hi' }, dependencies: { next: '16', react: '19', 'react-dom': '19' } }))
    writeFileSync(join(cwd, 'tsconfig.json'), '{}')
    mkdirSync(join(cwd, 'src/app'), { recursive: true })
    writeFileSync(
      join(cwd, 'src/app/layout.tsx'),
      `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    )
    const res = await runInit({ yes: true, lang: 'en' }, { cwd, prompter: scripted([]).p, copyAssets: () => 'public/anodb' })
    expect(res.wired).toBe('src/app/layout.tsx')
    const layout = readFileSync(join(cwd, 'src/app/layout.tsx'), 'utf8')
    expect(layout).toContain(`import "./globals.css";\nimport { DBProvider } from '../anodb/provider'`)
    expect(layout).toContain('<body><DBProvider>{children}</DBProvider></body>')
    expect(readFileSync(join(cwd, 'src/anodb/provider.tsx'), 'utf8').startsWith("'use client'")).toBe(true)
    expect(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts.postinstall).toBe('echo hi && anodb assets')
    // idempotent
    expect(wireProvider(cwd, 'src/anodb/provider.tsx')).toBeNull()
  })

  it('wires a Vite main and leaves ambiguous files alone', () => {
    const cwd = tmp()
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src/main.tsx'), `import { StrictMode } from 'react'\nimport {\n  createRoot,\n} from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)\n`)
    expect(wireProvider(cwd, 'src/anodb/provider.tsx')).toBe('src/main.tsx')
    const main = readFileSync(join(cwd, 'src/main.tsx'), 'utf8')
    expect(main).toContain(`import App from './App.tsx'\nimport { DBProvider } from './anodb/provider'`)
    expect(main).toContain('<StrictMode><DBProvider><App /></DBProvider></StrictMode>')

    const other = tmp()
    mkdirSync(join(other, 'src'))
    writeFileSync(join(other, 'src/main.tsx'), '<App /> <App />')
    expect(wireProvider(other, 'src/anodb/provider.tsx')).toBeNull()
  })

  it('copies the sql.js assets into the public folder', () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'kit', devDependencies: { '@sveltejs/kit': '2' } }))
    expect(copySqlJsAssets(cwd)).toBeNull()
    mkdirSync(join(cwd, 'node_modules/sql.js/dist'), { recursive: true })
    writeFileSync(join(cwd, 'node_modules/sql.js/package.json'), JSON.stringify({ name: 'sql.js', main: 'dist/sql-wasm.js', exports: { '.': './dist/sql-wasm.js', './dist/*': './dist/*' } }))
    writeFileSync(join(cwd, 'node_modules/sql.js/dist/sql-wasm.js'), '// js')
    writeFileSync(join(cwd, 'node_modules/sql.js/dist/sql-wasm.wasm'), 'wasm')
    expect(copySqlJsAssets(cwd)).toBe('static/anodb')
    expect(existsSync(join(cwd, 'static/anodb/sql-wasm.wasm'))).toBe(true)
  })

  it('runs the relay check and reports each relay', async () => {
    const cwd = tmp()
    const s = scripted([])
    await runInit(
      { yes: true, lang: 'ja', env: 'expo', check: true, relays: ['wss://good.example', 'wss://bad.example'] },
      { cwd, prompter: s.p, checkRelay: async (u) => u.includes('good') },
    )
    const out = s.log.join('\n')
    expect(out).toMatch(/✔ wss:\/\/good\.example/)
    expect(out).toMatch(/✖ wss:\/\/bad\.example/)
    expect(readFileSync(join(cwd, 'src/anodb/db.js'), 'utf8')).toContain('expo-secure-store')
  })

  it('sets up PGlite (Postgres) for a Node server', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'api' }))
    writeFileSync(join(cwd, 'tsconfig.json'), '{}')
    const installs: string[][] = []
    const s = scripted([])
    const res = await runInit(
      { yes: true, lang: 'en', env: 'node', db: 'pglite', install: true },
      { cwd, prompter: s.p, install: async (pm, pkgs) => void installs.push([pm, ...pkgs]) },
    )
    expect(res).toMatchObject({ env: 'node', db: 'pglite' })
    expect(installs).toEqual([['npm', '@anodb/core', '@electric-sql/pglite']])
    const dbTs = readFileSync(join(cwd, 'src/anodb/db.ts'), 'utf8')
    expect(dbTs).toContain("import { PGlite } from '@electric-sql/pglite'")
    expect(dbTs).toContain('export const pg = await PGlite.create(')
    expect(dbTs).toContain('driver: pgliteDriver(pg)')
    expect(dbTs).not.toContain('nodeSqlite')
    const ignore = readFileSync(join(cwd, '.gitignore'), 'utf8')
    expect(ignore).toContain('.env')
    expect(ignore).toContain('anodb-pgdata/')
    expect(s.log.join('\n')).toContain('Driver: PGlite (Postgres, WASM)')

    // the generated keys open a PGlite database
    const dotenv = readFileSync(join(cwd, '.env'), 'utf8')
    const vars = Object.fromEntries(dotenv.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    const db = await createAnoDB({ appId: vars.ANODB_APP_ID!, schema: defineSchema({ t: { a: 'text' } }), driver: pgliteDriver(await PGlite.create()), keyStore: envKeyStore(vars), relays: [] })
    onCleanup(() => db.close())
    await db.insertInto('t').values({ a: 'hello' }).execute()
    expect(await db.selectFrom('t').select('a').execute()).toEqual([{ a: 'hello' }])
  })

  it('offers a PostgreSQL server by default when the project already uses Postgres tooling, reusing its DATABASE_URL', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'api', dependencies: { '@prisma/client': '6' } }))
    writeFileSync(join(cwd, '.env'), 'DATABASE_URL="postgres://app:secret@db.local:5432/app"\n')
    expect(detectDatabase(cwd)).toBe('postgres')
    expect(detectDatabase(cwd, 'electron')).toBe('pglite')
    // lang=en, env=node, db: default (detected), URL: default (from .env), …
    const s = scripted([1, 4, null, '', 'api', 0, 'server', 0, false, false])
    const res = await runInit({}, { cwd, prompter: s.p, env: {} })
    expect(s.questions[2]).toBe('Database?')
    expect(s.questions[3]).toBe('PostgreSQL connection URL?')
    expect(res.db).toBe('postgres')
    const dotenv = readFileSync(join(cwd, '.env'), 'utf8')
    expect(dotenv).toContain('DATABASE_URL="postgres://app:secret@db.local:5432/app"') // left as it was
    expect(dotenv).toContain('ANODB_DATABASE_URL=postgres://app:secret@db.local:5432/app')
    // a project that uses PGlite keeps PGlite
    const lite = tmp()
    writeFileSync(join(lite, 'package.json'), JSON.stringify({ dependencies: { '@electric-sql/pglite': '0.5', pg: '8' } }))
    expect(detectDatabase(lite)).toBe('pglite')
  })

  it('sets up a PostgreSQL server (Docker) for a Node server, and the result opens', async () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'api' }))
    writeFileSync(join(cwd, 'tsconfig.json'), '{}')
    const installs: string[][] = []
    const s = scripted([])
    const url = 'postgres://app:app@127.0.0.1:5432/app'
    const res = await runInit(
      { yes: true, lang: 'en', env: 'node', db: 'postgres', databaseUrl: url, install: true },
      { cwd, prompter: s.p, install: async (pm, pkgs) => void installs.push([pm, ...pkgs]) },
    )
    expect(res).toMatchObject({ env: 'node', db: 'postgres' })
    expect(installs).toEqual([['npm', '@anodb/core', 'pg', '@types/pg']])
    const dbTs = readFileSync(join(cwd, 'src/anodb/db.ts'), 'utf8')
    expect(dbTs).toContain("import pg from 'pg'")
    expect(dbTs).toContain('new pg.Pool({ connectionString: process.env.ANODB_DATABASE_URL ?? process.env.DATABASE_URL })')
    expect(dbTs).toContain('driver: pgDriver(pool)')
    expect(dbTs).not.toMatch(/PGlite|nodeSqlite/)
    expect(s.log.join('\n')).toContain('Driver: PostgreSQL server (pg)')
    const dotenv = readFileSync(join(cwd, '.env'), 'utf8')
    expect(dotenv).toContain(`ANODB_DATABASE_URL=${url}`)
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain('.env')
    // JavaScript projects do not get @types/pg
    const js = tmp()
    const r2 = await runInit({ yes: true, lang: 'en', env: 'node', db: 'postgres', databaseUrl: url }, { cwd: js, prompter: scripted([]).p })
    expect(r2.packages).toEqual(['@anodb/core', 'pg'])
  })

  it.skipIf(!pgUp)('the generated keys open anoDB on the PostgreSQL server', async () => {
    const cwd = tmp()
    const dbUrl = await freshPgDatabase()
    await runInit({ yes: true, lang: 'en', env: 'node', db: 'postgres', databaseUrl: dbUrl }, { cwd, prompter: scripted([]).p })
    const dotenv = readFileSync(join(cwd, '.env'), 'utf8')
    const vars = Object.fromEntries(dotenv.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    const db = await createAnoDB({
      appId: vars.ANODB_APP_ID!,
      schema: defineSchema({ t: { a: 'text' } }),
      driver: pgDriver(await pgPool(vars.ANODB_DATABASE_URL!), { close: false }),
      keyStore: envKeyStore(vars),
      relays: [],
    })
    onCleanup(() => db.close())
    await db.insertInto('t').values({ a: 'hello' }).execute()
    expect(await db.selectFrom('t').select('a').execute()).toEqual([{ a: 'hello' }])
  })

  it('PGlite in the Electron main process; other environments keep SQLite', async () => {
    const cwd = tmp()
    const res = await runInit({ yes: true, lang: 'en', env: 'electron', framework: 'react', db: 'pglite' }, { cwd, prompter: scripted([]).p })
    expect(res.packages).toEqual(['@anodb/core', '@electric-sql/pglite'])
    const dbJs = readFileSync(join(cwd, 'src/anodb/db.js'), 'utf8')
    expect(dbJs).toContain("pgliteDriver(await PGlite.create(join(dir, 'pgdata')))")
    expect(dbJs).toContain('electronKeyStore(safeStorage')

    const expo = tmp()
    const s = scripted([])
    const r2 = await runInit({ yes: true, lang: 'en', env: 'expo', db: 'pglite' }, { cwd: expo, prompter: s.p })
    expect(r2.db).toBe('sqlite')
    expect(s.log.join('\n')).toContain('only available for Node / Electron')
    expect(readFileSync(join(expo, 'src/anodb/db.js'), 'utf8')).toContain('expoSqliteDriver')

    // a PostgreSQL server is for Node servers only
    const desktop = tmp()
    const s3 = scripted([])
    const r3 = await runInit({ yes: true, lang: 'en', env: 'electron', db: 'postgres' }, { cwd: desktop, prompter: s3.p })
    expect(r3.db).toBe('sqlite')
    expect(s3.log.join('\n')).toContain('only available for Node; using SQLite')
    const s4 = scripted([])
    expect((await runInit({ yes: true, lang: 'en', env: 'expo', db: 'postgres' }, { cwd: tmp(), prompter: s4.p })).db).toBe('sqlite')
    expect(s4.log.join('\n')).toContain('only available for Node; using SQLite')
  })
})
