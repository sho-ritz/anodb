import type { Compilable } from 'kysely'
import { type ReactNode, createContext, createElement, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { SchemaDefinition, SyncStatus } from './types.js'

/** The parts of AnoDB the hooks need (keeps this entry point free of the full class). */
export interface ReactiveDB {
  subscribe<R>(query: Compilable<R> | { sql: string; parameters?: readonly unknown[] } | string, cb: (rows: R[]) => void, onError?: (e: unknown) => void): () => void
  onStatus(fn: (s: SyncStatus) => void): () => void
  readonly status: SyncStatus
  readonly schema: SchemaDefinition
}

type Query<R> = Compilable<R> | { sql: string; parameters?: readonly unknown[] } | string

/**
 * Framework-independent store for one live query: `subscribe` / `getSnapshot` match React's
 * useSyncExternalStore and can also be used from Vue / Svelte.
 */
export function createQueryStore<R>(db: ReactiveDB, query: Query<R>) {
  let rows: R[] | undefined
  let error: unknown
  const listeners = new Set<() => void>()
  let stop: (() => void) | null = null
  const emit = () => {
    for (const l of listeners) l()
  }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (!stop) {
        stop = db.subscribe(
          query,
          (r) => {
            rows = r
            error = undefined
            emit()
          },
          (e) => {
            error = e
            emit()
          },
        )
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stop?.()
          stop = null
        }
      }
    },
    getSnapshot: () => rows,
    getError: () => error,
  }
}

const Ctx = createContext<ReactiveDB | null>(null)

export function AnoDBProvider(props: { db: ReactiveDB; children?: ReactNode }) {
  return createElement(Ctx.Provider, { value: props.db }, props.children)
}

export function useAnoDB<D extends ReactiveDB = ReactiveDB>(): D {
  const db = useContext(Ctx)
  if (!db) throw new Error('anoDB: wrap your app in <AnoDBProvider db={db}>')
  return db as D
}

/**
 * Live query. `build` receives the database and returns a Kysely query (or SQL). Re-runs when the
 * tables it reads change, locally or through sync. Returns `undefined` until the first result.
 *
 *   const todos = useQuery((db) => db.selectFrom('todo').selectAll().where('done', '=', 0), [])
 */
export function useQuery<D extends ReactiveDB, R>(build: (db: D) => Query<R>, deps: readonly unknown[]): R[] | undefined {
  const db = useAnoDB<D>()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => createQueryStore(db, build(db)), [db, ...deps])
  const rows = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const err = store.getError()
  if (err) throw err
  return rows
}

export function useSyncStatus(): SyncStatus {
  const db = useAnoDB()
  const ref = useRef(db.status)
  const subscribe = useMemo(
    () => (cb: () => void) =>
      db.onStatus((s) => {
        ref.current = s
        cb()
      }),
    [db],
  )
  useEffect(() => void (ref.current = db.status), [db])
  return useSyncExternalStore(subscribe, () => ref.current, () => ref.current)
}
