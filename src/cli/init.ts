import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { bytesToHex, generateSecretKey, getPublicKey, nsecEncode, parseSecretKey, signWith } from '../crypto.js'
import { DEFAULT_RELAYS } from '../defaults.js'
import { createDelegation } from '../identity.js'
import { bytesToBase64 } from '../keystore/env.js'
import { TAG, WRAP_KIND } from '../protocol.js'
import { RelayPool, normalizeRelayUrl } from '../relay-pool.js'
import { localSigner } from '../signer.js'
import { type Lang, type Messages, detectLang, messages } from './i18n.js'

export type Env = 'browser' | 'tauri' | 'electron' | 'expo' | 'node'
export type Framework = 'react' | 'vue' | 'svelte' | 'none'
export type KeyMode = 'stored' | 'recovery' | 'signer'
export type WebStack = 'next' | 'vite' | 'sveltekit' | 'nuxt' | 'other'

export interface Choice<T> {
  label: string
  value: T
}

export interface Prompter {
  select<T>(question: string, choices: Choice<T>[], defaultIndex: number): Promise<T>
  input(question: string, defaultValue: string): Promise<string>
  confirm(question: string, defaultValue: boolean): Promise<boolean>
  log(line: string): void
}

export interface InitFlags {
  lang?: Lang
  env?: Env
  framework?: Framework
  appId?: string
  keys?: KeyMode
  identity?: string
  deviceName?: string
  relays?: string[]
  check?: boolean
  install?: boolean
  /** Wrap the app in <DBProvider> automatically (React). */
  wire?: boolean
  yes?: boolean
  force?: boolean
}

export interface InitDeps {
  cwd: string
  prompter?: Prompter
  /** Install packages; default spawns the detected package manager. */
  install?: (pm: string, pkgs: string[], cwd: string) => Promise<void>
  /** Copy sql.js assets; default copies from the project's node_modules. */
  copyAssets?: (cwd: string) => string | null
  /** Relay check; default publishes and reads back a throwaway envelope. */
  checkRelay?: (url: string) => Promise<boolean>
  env?: Record<string, string | undefined>
}

export interface InitResult {
  env: Env
  framework: Framework
  appId: string
  files: string[]
  recoveryKey: string | null
  packages: string[]
  /** File the provider was wired into, if any. */
  wired: string | null
}

const PACKAGES: Record<Env, string[]> = {
  browser: ['anodb', 'sql.js'],
  tauri: ['anodb', 'sql.js'],
  electron: ['anodb'],
  expo: ['anodb', 'expo-sqlite', 'expo-secure-store'],
  node: ['anodb'],
}

const DRIVERS: Record<Env, string> = {
  browser: 'sql.js (WASM) + IndexedDB',
  tauri: 'sql.js (WASM) + IndexedDB',
  electron: 'node:sqlite (main process)',
  expo: 'expo-sqlite',
  node: 'node:sqlite',
}

interface PackageJson {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPackageJson(cwd: string): PackageJson {
  try {
    return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function detectEnv(cwd: string): { env: Env; framework: Framework } {
  const pkg = readPackageJson(cwd)
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const has = (n: string) => n in deps
  const env: Env = has('@tauri-apps/api')
    ? 'tauri'
    : has('electron')
      ? 'electron'
      : has('expo') || has('react-native')
        ? 'expo'
        : has('vite') || has('next') || has('react-dom') || has('vue') || has('svelte') || has('@sveltejs/kit')
          ? 'browser'
          : 'node'
  const framework: Framework = has('react') ? 'react' : has('vue') ? 'vue' : has('svelte') ? 'svelte' : 'none'
  return { env, framework }
}

export function detectWebStack(cwd: string): WebStack {
  const pkg = readPackageJson(cwd)
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if ('next' in deps) return 'next'
  if ('@sveltejs/kit' in deps) return 'sveltekit'
  if ('nuxt' in deps) return 'nuxt'
  if ('vite' in deps) return 'vite'
  return 'other'
}

/** Folder whose files are served at the site root. */
export function publicDir(cwd: string): string {
  return detectWebStack(cwd) === 'sveltekit' ? 'static' : 'public'
}

const ASSET_FILES = ['sql-wasm.js', 'sql-wasm.wasm']

/**
 * Copy the sql.js WASM build into `<public>/anodb/` so the browser driver can load it without any
 * bundler configuration. Returns the folder, or null if sql.js is not installed.
 */
export function copySqlJsAssets(cwd: string): string | null {
  let dist: string
  try {
    dist = dirname(createRequire(join(cwd, 'package.json')).resolve('sql.js/dist/sql-wasm.wasm'))
  } catch {
    return null
  }
  const out = join(publicDir(cwd), 'anodb')
  mkdirSync(join(cwd, out), { recursive: true })
  for (const f of ASSET_FILES) copyFileSync(join(dist, f), join(cwd, out, f))
  return out
}

/** Keep the assets in sync with the installed sql.js: `"postinstall": "anodb assets"`. */
function addPostinstall(cwd: string): boolean {
  const path = join(cwd, 'package.json')
  if (!existsSync(path)) return false
  const raw = readFileSync(path, 'utf8')
  const pkg = JSON.parse(raw) as PackageJson
  const cur = pkg.scripts?.postinstall
  if (cur?.includes('anodb assets')) return false
  pkg.scripts = { ...pkg.scripts, postinstall: cur ? `${cur} && anodb assets` : 'anodb assets' }
  const indent = /^(\s+)"/m.exec(raw)?.[1] ?? '  '
  writeFileSync(path, `${JSON.stringify(pkg, null, indent)}\n`)
  return true
}

function ensureIgnored(path: string, entry: string): boolean {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (content.split('\n').some((l) => l.trim() === entry || l.trim() === `/${entry}`)) return false
  writeFileSync(path, `${content}${content && !content.endsWith('\n') ? '\n' : ''}${entry}\n`)
  return true
}

const posix = (p: string) => p.split(sep).join('/')

function importPath(fromFile: string, toFile: string): string {
  const rel = posix(relative(dirname(fromFile), toFile)).replace(/\.(tsx?|jsx?)$/, '')
  return rel.startsWith('.') ? rel : `./${rel}`
}

function findFirst(cwd: string, candidates: string[]): string | null {
  return candidates.find((c) => existsSync(join(cwd, c))) ?? null
}

/**
 * Wrap the app in <DBProvider>: Next.js `app/layout` ({children} inside <body>) or a Vite
 * `src/main` (<App />). Only edits when the pattern occurs exactly once.
 */
export function wireProvider(cwd: string, providerFile: string): string | null {
  const exts = ['tsx', 'jsx', 'js', 'ts']
  const layout = findFirst(cwd, ['src/app', 'app'].flatMap((d) => exts.map((e) => `${d}/layout.${e}`)))
  const main = findFirst(cwd, ['src/main', 'src/index'].flatMap((b) => exts.map((e) => `${b}.${e}`)))
  for (const [file, pattern, replacement] of [
    [layout, /(<body[^>]*>\s*)\{\s*children\s*\}/g, '$1<DBProvider>{children}</DBProvider>'],
    [main, /<App\s*\/>/g, '<DBProvider><App /></DBProvider>'],
  ] as const) {
    if (!file) continue
    const path = join(cwd, file)
    const src = readFileSync(path, 'utf8')
    if (src.includes('DBProvider')) return null
    if ((src.match(pattern) ?? []).length !== 1) continue
    const imp = `import { DBProvider } from '${importPath(file, providerFile)}'\n`
    const lines = src.split('\n')
    let lastImport = -1
    lines.forEach((l, i) => {
      if (/^import\s/.test(l) || (lastImport >= 0 && i === lastImport + 1 && /^\s+.*from\s+['"]/.test(l))) lastImport = i
    })
    // multi-line imports: advance to the line that closes the statement
    while (lastImport >= 0 && lastImport < lines.length - 1 && !/['"];?\s*$/.test(lines[lastImport]!)) lastImport++
    lines.splice(lastImport + 1, 0, imp.trimEnd())
    writeFileSync(path, lines.join('\n').replace(pattern, replacement))
    return file
  }
  return null
}

export function detectPackageManager(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun'
  return 'npm'
}

export async function runInit(flags: InitFlags, deps: InitDeps): Promise<InitResult> {
  const p = deps.prompter ?? terminalPrompter()
  const auto = flags.yes === true
  const ask = async <T>(flagValue: T | undefined, question: () => Promise<T>, fallback: T): Promise<T> =>
    flagValue !== undefined ? flagValue : auto ? fallback : question()

  // ① language
  const detectedLang = detectLang(deps.env ?? process.env)
  const lang = await ask(
    flags.lang,
    () => p.select(messages.en.language, [{ label: '日本語', value: 'ja' as Lang }, { label: 'English', value: 'en' as Lang }], detectedLang === 'ja' ? 0 : 1),
    detectedLang,
  )
  const m: Messages = messages[lang]

  // ② environment & framework
  const detected = detectEnv(deps.cwd)
  const envChoices: Choice<Env>[] = (
    [
      ['browser', m.envBrowser],
      ['tauri', m.envTauri],
      ['electron', m.envElectron],
      ['expo', m.envExpo],
      ['node', m.envNode],
    ] as const
  ).map(([value, label]) => ({ value, label: value === detected.env ? `${label}${m.detected}` : label }))
  const env = await ask(flags.env, () => p.select(m.env, envChoices, envChoices.findIndex((c) => c.value === detected.env)), detected.env)

  let framework: Framework = 'none'
  if (env !== 'node') {
    const fw: Choice<Framework>[] = [
      { label: 'React', value: 'react' },
      { label: 'Vue', value: 'vue' },
      { label: 'Svelte', value: 'svelte' },
      { label: m.none, value: 'none' },
    ]
    framework = await ask(flags.framework, () => p.select(m.framework, fw, fw.findIndex((c) => c.value === detected.framework)), detected.framework)
  }
  p.log(`${m.driver}: ${DRIVERS[env]}`)

  // ③ appId
  const pkgName = readPackageJson(deps.cwd).name ?? 'my-app'
  const appId = (await ask(flags.appId, () => p.input(m.appId, pkgName), pkgName)).trim() || pkgName

  // ④ keys
  let keyMode: KeyMode = 'stored'
  let recoveryKey: string | null = null
  let envVars: Record<string, string> | null = null
  if (env !== 'node') {
    keyMode = await ask(
      flags.keys,
      () =>
        p.select(
          m.keysUser,
          [
            { label: m.keyStored, value: 'stored' as KeyMode },
            { label: m.keyRecovery, value: 'recovery' as KeyMode },
            { label: m.keySigner, value: 'signer' as KeyMode },
          ],
          0,
        ),
      'stored',
    )
  } else {
    let identity: Uint8Array
    const importKey =
      flags.identity !== undefined
        ? true
        : auto
          ? false
          : await p.select(m.keysNode, [{ label: m.idNew, value: false }, { label: m.idImport, value: true }], 0)
    if (importKey) {
      identity = parseSecretKey(flags.identity ?? (await p.input(m.idPrompt, '')))
    } else {
      identity = generateSecretKey()
      recoveryKey = nsecEncode(identity)
    }
    const deviceName = await ask(flags.deviceName, () => p.input(m.deviceName, 'server'), 'server')
    const deviceSk = generateSecretKey()
    const delegation = await createDelegation(localSigner(identity), getPublicKey(deviceSk), deviceName, Date.now())
    envVars = {
      ANODB_APP_ID: appId,
      ANODB_DEVICE_KEY: nsecEncode(deviceSk),
      ANODB_DELEGATION: bytesToBase64(new TextEncoder().encode(JSON.stringify(delegation))),
    }
    identity.fill(0)
  }

  // ⑤ relays
  let relays: string[] | null = null
  if (flags.relays) relays = flags.relays.map(normalizeRelayUrl)
  else if (!auto) {
    const custom = await p.select(m.relays, [{ label: m.relaysDefault, value: false }, { label: m.relaysCustom, value: true }], 0)
    if (custom) relays = (await p.input(m.relaysPrompt, DEFAULT_RELAYS.join(','))).split(',').map((s) => normalizeRelayUrl(s.trim())).filter(Boolean)
  }
  const doCheck = await ask(flags.check, () => p.confirm(m.check, true), false)
  if (doCheck) {
    p.log(m.checking)
    const check = deps.checkRelay ?? checkRelay
    for (const url of relays ?? DEFAULT_RELAYS) p.log((await check(url)) ? `  ✔ ${url}  ${m.checkOk}` : `  ✖ ${url}  ${m.checkNg}`)
  }

  // ⑥ files
  const ts = existsSync(join(deps.cwd, 'tsconfig.json'))
  const ext = ts ? 'ts' : 'js'
  const web = env === 'browser' || env === 'tauri'
  // Next.js without src/: keep files next to app/
  const base = !existsSync(join(deps.cwd, 'src')) && existsSync(join(deps.cwd, 'app')) ? 'anodb' : 'src/anodb'
  const files: string[] = []
  const write = (rel: string, content: string) => {
    const path = join(deps.cwd, rel)
    if (existsSync(path) && !flags.force) {
      p.log(`${m.skipped} ${rel}`)
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    files.push(rel)
    p.log(`${m.wrote} ${rel}`)
  }
  write(`${base}/schema.${ext}`, schemaTemplate())
  write(`${base}/db.${ext}`, dbTemplate(env, appId, keyMode, relays, ts))
  const providerFile = `${base}/provider.${ts ? 'tsx' : 'jsx'}`
  if (framework === 'react' && env !== 'node') write(providerFile, reactTemplate(ts, keyMode))
  if (envVars) {
    writeEnv(join(deps.cwd, '.env'), envVars)
    files.push('.env')
    p.log(`${m.wrote} .env`)
    if (ensureGitignore(join(deps.cwd, '.gitignore'))) p.log(m.gitignore)
  }

  // ⑦ install
  const packages = PACKAGES[env]
  const doInstall = await ask(flags.install, () => p.confirm(`${m.install} (${packages.join(' ')})`, true), false)
  if (doInstall) {
    const pm = detectPackageManager(deps.cwd)
    p.log(`${m.installing} ${pm} ${packages.join(' ')}`)
    await (deps.install ?? installPackages)(pm, packages, deps.cwd)
  }

  // ⑧ browser assets: sql.js served from <public>/anodb, refreshed on every install
  if (web) {
    const out = (deps.copyAssets ?? copySqlJsAssets)(deps.cwd)
    if (out) p.log(`${m.wrote} ${out}/ (${ASSET_FILES.join(', ')})`)
    else p.log(m.assetsLater)
    if (addPostinstall(deps.cwd)) p.log(m.postinstall)
    if (ensureIgnored(join(deps.cwd, '.gitignore'), `${publicDir(deps.cwd)}/anodb/`)) p.log(m.assetsIgnored)
  }

  // ⑨ wire <DBProvider> into the app
  let wired: string | null = null
  if (framework === 'react' && web && files.includes(providerFile)) {
    const doWire = await ask(flags.wire, () => p.confirm(m.wire, true), true)
    if (doWire) {
      wired = wireProvider(deps.cwd, providerFile)
      p.log(wired ? `${m.wired} ${wired}` : m.wireManual)
    }
  }

  if (recoveryKey) {
    p.log('')
    p.log(m.recoveryTitle)
    p.log(`  ${recoveryKey}`)
    p.log(m.recoveryHint)
  }
  p.log('')
  p.log(m.done)
  if (env === 'node') p.log(m.nextNode)
  else if (framework === 'react' && web) {
    if (!wired) p.log(m.nextWrap)
    p.log(m.nextReact)
  } else p.log(m.nextBrowser)
  return { env, framework, appId, files, recoveryKey, packages, wired }
}

function writeEnv(path: string, vars: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => !Object.keys(vars).some((k) => l.startsWith(`${k}=`))) : []
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (const [k, v] of Object.entries(vars)) lines.push(`${k}=${v}`)
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
}

function ensureGitignore(path: string): boolean {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (content.split('\n').some((l) => l.trim() === '.env' || l.trim() === '.env*' || l.trim() === '*.env')) return false
  writeFileSync(path, `${content}${content && !content.endsWith('\n') ? '\n' : ''}.env\n`)
  return true
}

export function reactTemplate(ts: boolean, keyMode: KeyMode = 'stored'): string {
  const recovery = keyMode === 'recovery'
  return `'use client'
import { useEffect, useState${ts ? ', type ReactNode' : ''} } from 'react'
import { AnoDBProvider } from 'anodb/react'
import { openDB } from './db${ts ? '' : '.js'}'

// Wrap your app: <DBProvider><App /></DBProvider>. Then in any component:
//   const todos = useQuery((db) => db.selectFrom('todo').selectAll(), [])
//   await db.insertInto('todo').values({ title: 'Milk', done: false }).execute()   // const db = useAnoDB()
export function DBProvider({ children, fallback = null }${ts ? ': { children: ReactNode; fallback?: ReactNode }' : ''}) {
  const [db, setDb] = useState${ts ? '<Awaited<ReturnType<typeof openDB>> | null>' : ''}(null)
  const [error, setError] = useState${ts ? '<Error | null>' : ''}(null)
  useEffect(() => {
    openDB(${recovery ? "{ onRecoveryKey: (key) => alert(`Save this recovery key somewhere safe. It will not be shown again:\\n\\n${key}`) }" : ''}).then(setDb, setError)
  }, [])
  if (error) {
    const code = (error${ts ? ' as { code?: string }' : ''}).code
    return <p>{code === 'tab-locked' ? 'This app is already open in another tab.' : \`Could not open the database: \${error.message}\`}</p>
  }
  if (!db) return fallback
  return <AnoDBProvider db={db}>{children}</AnoDBProvider>
}
`
}

export function schemaTemplate(): string {
  return `import { defineSchema } from 'anodb'

// Each table automatically gets: id, space, createdAt, updatedAt.
// Column types: 'text' | 'integer' | 'real' | 'boolean' | 'json'
export const schema = defineSchema({
  todo: { title: 'text', done: 'boolean' },
})
`
}

export function dbTemplate(env: Env, appId: string, keyMode: KeyMode, relays: string[] | null, ts: boolean): string {
  const relayLine = relays ? `\n    relays: ${JSON.stringify(relays)},` : ''
  const schemaImport = `import { schema } from './schema${ts ? '' : '.js'}'`
  const id = JSON.stringify(appId)
  const optsType = ts ? ': { onRecoveryKey?: (key: string) => void }' : ''
  const takesOpts = keyMode === 'recovery'
  if (env === 'node') {
    return `import { createAnoDB } from 'anodb'
import { nodeSqlite } from 'anodb/node'
${schemaImport}

// Keys come from .env (ANODB_DEVICE_KEY / ANODB_DELEGATION), written by \`npx anodb init\`.
export const db = await createAnoDB({
  appId: process.env.ANODB_APP_ID ?? ${id},
  schema,
  driver: nodeSqlite(process.env.ANODB_FILE ?? 'anodb.sqlite'),${relayLine}
})
`
  }
  if (env === 'electron') {
    return `// Run in the Electron main process.
import { app, safeStorage } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAnoDB, electronKeyStore } from 'anodb'
import { nodeSqlite } from 'anodb/node'
${schemaImport}

const dir = join(app.getPath('userData'), 'anodb')

export async function openDB(${takesOpts ? `opts${optsType} = {}` : ''}) {
  await mkdir(dir, { recursive: true })
  return createAnoDB({
    appId: ${id},
    schema,
    driver: nodeSqlite(join(dir, 'db.sqlite')),
    keyStore: electronKeyStore(safeStorage, {
      read: (n) => readFile(join(dir, n)).then((b) => new Uint8Array(b)).catch(() => null),
      write: (n, d) => writeFile(join(dir, n), d, { mode: 0o600 }),
      remove: (n) => rm(join(dir, n), { force: true }),
    }),${keyOptions(keyMode, ts)}${relayLine}
  })
}
`
  }
  if (env === 'expo') {
    return `import { openDatabaseSync } from 'expo-sqlite'
import * as SecureStore from 'expo-secure-store'
import { createAnoDB, expoSqliteDriver, secureStorageKeyStore } from 'anodb'
${schemaImport}

export async function openDB(${takesOpts ? `opts${optsType} = {}` : ''}) {
  return createAnoDB({
    appId: ${id},
    schema,
    driver: expoSqliteDriver(openDatabaseSync('anodb.db')),
    keyStore: secureStorageKeyStore({
      getItem: (k) => SecureStore.getItemAsync(k),
      setItem: (k, v) => SecureStore.setItemAsync(k, v),
      deleteItem: (k) => SecureStore.deleteItemAsync(k),
    }),${keyOptions(keyMode, ts)}${relayLine}
  })
}
`
  }
  return `import { browserDriver, createAnoDB${keyMode === 'signer' ? ', nip07Signer' : ''} } from 'anodb'
${schemaImport}

let opening${ts ? ': ReturnType<typeof open> | null' : ''} = null

/**
 * Opens the database once per page. Keys are generated on each user's device on first launch and
 * kept encrypted in IndexedDB; sql.js is loaded from /anodb (copied there by \`anodb assets\`).
 */
export function openDB(${takesOpts ? `opts${optsType} = {}` : ''}) {
  opening ??= open(${takesOpts ? 'opts' : ''}).catch((e) => {
    opening = null
    throw e
  })
  return opening
}

async function open(${takesOpts ? `opts${optsType}` : ''}) {
  return createAnoDB({
    appId: ${id},
    schema,
    driver: await browserDriver({ name: ${id} }),${keyOptions(keyMode, ts)}${relayLine}
  })
}
`
}

function keyOptions(mode: KeyMode, ts: boolean): string {
  if (mode === 'recovery') {
    return `
    // The identity key is NOT stored on the device: show it to the user once (first launch only).
    identity: 'recovery',
    onRecoveryKey: opts.onRecoveryKey ?? (() => { throw new Error('pass onRecoveryKey to openDB()') }),`
  }
  if (mode === 'signer') {
    return `
    // Use a NIP-07 extension when present (identity operations only; writes never need it).
    signer: ${ts ? '(globalThis as { nostr?: unknown })' : 'globalThis'}.nostr ? nip07Signer() : undefined,`
  }
  return ''
}

/** Publish a throwaway envelope and read it back. */
export async function checkRelay(url: string): Promise<boolean> {
  const pool = new RelayPool([url], { publishTimeoutMs: 6000, connectTimeoutMs: 6000 })
  try {
    pool.connect()
    const ev = signWith(generateSecretKey(), {
      kind: WRAP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[TAG, bytesToHex(generateSecretKey()).slice(0, 32)]],
      content: 'anodb relay check',
    })
    // Wait for the connection (a no-op query), then publish.
    await pool.query([{ ids: ['0'.repeat(64)] }], { relays: [url], timeoutMs: 6000 })
    const res = (await pool.publish(ev)).get(normalizeRelayUrl(url))
    if (res?.outcome !== 'ok') return false
    const got = await pool.query([{ ids: [ev.id] }], { relays: [url], timeoutMs: 6000 })
    return got.some((e) => e.id === ev.id)
  } catch {
    return false
  } finally {
    pool.close()
  }
}

function installPackages(pm: string, pkgs: string[], cwd: string): Promise<void> {
  const args = pm === 'npm' ? ['install', ...pkgs] : ['add', ...pkgs]
  return new Promise((resolve, reject) => {
    const child = spawn(pm, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${pm} exited with ${code}`))))
    child.on('error', reject)
  })
}

export function terminalPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const close = () => rl.close()
  process.once('exit', close)
  return {
    async select(question, choices, defaultIndex) {
      console.log(`\n? ${question}`)
      choices.forEach((c, i) => console.log(`  ${i === defaultIndex ? '❯' : ' '} ${i + 1}. ${c.label}`))
      for (;;) {
        const a = (await rl.question(`  [${defaultIndex + 1}] `)).trim()
        if (a === '') return choices[defaultIndex]!.value
        const n = Number(a)
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value
      }
    },
    async input(question, defaultValue) {
      const a = (await rl.question(`\n? ${question}${defaultValue ? ` (${defaultValue})` : ''}: `)).trim()
      return a || defaultValue
    },
    async confirm(question, defaultValue) {
      const a = (await rl.question(`\n? ${question} ${defaultValue ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
      return a === '' ? defaultValue : a.startsWith('y')
    },
    log: (line) => console.log(line),
  }
}
