import { AnoDBError } from '../db.js'
import type { SqliteDriver } from '../types.js'
import { sqlJsIndexedDB } from './sqljs-idb.js'

export interface BrowserDriverOptions {
  /** Database name (usually your appId). */
  name: string
  /**
   * Where `sql-wasm.js` and `sql-wasm.wasm` are served from. `npx anodb init` copies them to
   * `public/anodb/` (and `npx anodb assets` refreshes them). Default `/anodb`.
   */
  assetsUrl?: string
  /**
   * Only one tab per origin may own the database file (two tabs would overwrite each other's
   * saves). Default true: a second tab gets `AnoDBError` with code `'tab-locked'`.
   */
  singleTab?: boolean
}

type InitSqlJs = (cfg: { locateFile: (file: string) => string }) => Promise<Parameters<typeof sqlJsIndexedDB>[0]>

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`anoDB: failed to load ${src} — run \`npx anodb assets\` to copy the sql.js files into your public folder`))
    document.head.appendChild(s)
  })
}

const sqlJsCache = new Map<string, ReturnType<InitSqlJs>>()

/** Load sql.js from `assetsUrl` without any bundler configuration. */
export function loadSqlJs(assetsUrl = '/anodb'): ReturnType<InitSqlJs> {
  const base = assetsUrl.replace(/\/+$/, '')
  let p = sqlJsCache.get(base)
  if (!p) {
    p = (async () => {
      const g = globalThis as { initSqlJs?: InitSqlJs }
      if (!g.initSqlJs) await loadScript(`${base}/sql-wasm.js`)
      if (!g.initSqlJs) throw new Error('anoDB: sql-wasm.js did not define initSqlJs')
      return g.initSqlJs({ locateFile: (file) => `${base}/${file}` })
    })()
    p.catch(() => sqlJsCache.delete(base))
    sqlJsCache.set(base, p)
  }
  return p
}

/** Hold a Web Lock for the page's lifetime; resolves to a release function, or null if another tab holds it. */
function acquireTabLock(name: string): Promise<(() => void) | null> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  if (!locks) return Promise.resolve(() => {})
  return new Promise((resolve) => {
    void locks.request(`anodb:${name}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null)
        return undefined
      }
      return new Promise<void>((release) => resolve(release))
    })
  })
}

/**
 * Zero-config browser driver: loads sql.js from `assetsUrl`, persists to IndexedDB and makes sure
 * only one tab owns the database.
 *
 *   const db = await createAnoDB({ appId, schema, driver: await browserDriver({ name: appId }) })
 */
export async function browserDriver(opts: BrowserDriverOptions): Promise<SqliteDriver> {
  let release: (() => void) | null = () => {}
  if (opts.singleTab !== false) {
    release = await acquireTabLock(opts.name)
    if (!release) throw new AnoDBError('tab-locked', 'This app is already open in another tab.')
  }
  try {
    const SQL = await loadSqlJs(opts.assetsUrl)
    const driver = await sqlJsIndexedDB(SQL, opts.name)
    return {
      ...driver,
      close: () => {
        driver.close()
        release?.()
      },
    }
  } catch (e) {
    release?.()
    throw e
  }
}
