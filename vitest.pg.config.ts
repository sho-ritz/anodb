import { defineConfig } from 'vitest/config'

/**
 * `npm run test:pg`: the whole suite with a Postgres server as the default driver of `open()`
 * (a fresh database per test). Start one with `docker compose -f docker-compose.test.yml up -d --wait`
 * or point ANODB_TEST_PG_URL at an admin connection of your own.
 */
export default defineConfig({
  test: {
    env: { ANODB_TEST_DRIVER: 'pg' },
    testTimeout: 30_000,
  },
})
