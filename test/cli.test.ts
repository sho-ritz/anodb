import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Prompter, copySqlJsAssets, detectEnv, runInit, wireProvider } from '../src/cli/init.js'
import { createAnoDB, defineSchema } from '../src/index.js'
import { envKeyStore } from '../src/keystore/env.js'
import { nodeSqlite } from '../src/node.js'
import { onCleanup } from './helpers/setup.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'anodb-init-'))

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
    select: async (q, choices) => {
      const a = next(q)
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
    // lang=ja, env=node(4), appId, new identity(0), device name, default relays(0), no check, no install
    const s = scripted([0, 4, 'my-bot', 0, 'bot-1', 0, false, false])
    const res = await runInit({}, { cwd, prompter: s.p, env: { LANG: 'en_US.UTF-8' } })
    expect(s.questions[0]).toBe('Language / 言語')
    expect(s.questions[1]).toBe('実行環境は？')
    expect(res).toMatchObject({ env: 'node', appId: 'my-bot' })
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
    expect(readFileSync(join(cwd, 'src/anodb/db.js'), 'utf8')).toContain("from 'anodb/node'")
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
    expect(readFileSync(join(cwd, 'src/anodb/provider.tsx'), 'utf8')).toContain("from 'anodb/react'")
    const dbTs = readFileSync(join(cwd, 'src/anodb/db.ts'), 'utf8')
    expect(dbTs).toContain("identity: 'recovery'")
    expect(dbTs).toContain('wss://relay.example')
    expect(dbTs).toContain('browserDriver({ name: "web" })')
    expect(installs).toEqual([['npm', 'anodb', 'sql.js']])
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
})
