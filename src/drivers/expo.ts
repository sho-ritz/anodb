import type { SqlValue, SqliteDriver } from '../types.js'

/** Subset of expo-sqlite's `SQLiteDatabase` (from `openDatabaseSync`). */
export interface ExpoSQLiteDatabase {
  execSync(sql: string): void
  runSync(sql: string, params: SqlValue[]): unknown
  getAllSync<T>(sql: string, params: SqlValue[]): T[]
  closeSync(): void
}

/** React Native / Expo: `expoSqliteDriver(openDatabaseSync('app.db'))`. */
export function expoSqliteDriver(db: ExpoSQLiteDatabase): SqliteDriver {
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, params = []) => void db.runSync(sql, [...params]),
    all: <T>(sql: string, params: readonly SqlValue[] = []) => db.getAllSync<T>(sql, [...params]),
    close: () => db.closeSync(),
  }
}
