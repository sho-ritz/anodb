import { defineConfig } from 'vitest/config'

/** `npm run test:pglite`: the whole suite with PGlite (Postgres) as the default driver of `open()`. */
export default defineConfig({
  test: {
    env: { ANODB_TEST_DRIVER: 'pglite' },
    // Every database is a fresh Postgres instance (about a second to start under load).
    testTimeout: 30_000,
  },
})
