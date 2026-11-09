import type { SqliteDriver } from '../types.js'
import { type SqlJsDatabase, sqlJsDriver } from './sqljs.js'

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase & { export(): Uint8Array }
}

function idb<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/**
 * Browser driver: sql.js (WASM SQLite) persisted to IndexedDB. The database image is saved
 * shortly after each write and when the page is hidden.
 *
 *   const SQL = await initSqlJs({ locateFile: (f) => `/sql-wasm/${f}` })
 *   const driver = await sqlJsIndexedDB(SQL, 'my-app')
 */
export async function sqlJsIndexedDB(SQL: SqlJsStatic, name: string, debounceMs = 250): Promise<SqliteDriver> {
  const open = indexedDB.open(`${name}-sqlite`, 1)
  open.onupgradeneeded = () => open.result.createObjectStore('db')
  const store = await idb(open)
  const image = (await idb(store.transaction('db', 'readonly').objectStore('db').get('image'))) as Uint8Array | undefined
  const sdb = new SQL.Database(image)
  const base = sqlJsDriver(sdb)
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = async () => {
    timer = null
    await idb(store.transaction('db', 'readwrite').objectStore('db').put(sdb.export(), 'image'))
  }
  const schedule = () => {
    if (!timer) timer = setTimeout(() => void save(), debounceMs)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void save()
    })
  }
  return {
    exec: (sql) => {
      base.exec(sql)
      if (/^\s*(COMMIT|END)\b/i.test(sql) || !/^\s*(BEGIN|ROLLBACK)/i.test(sql)) schedule()
    },
    run: (sql, params) => {
      base.run(sql, params)
      schedule()
    },
    all: (sql, params) => base.all(sql, params),
    close: () => {
      void save().finally(() => base.close())
    },
  }
}
