# @anodb/cli

```sh
npx @anodb/cli init
```

Interactive setup for [anoDB](https://github.com/sho-ritz/anodb): installs `@anodb/core`, generates the schema, database and React provider, copies the SQLite WASM files for web apps and wires the provider into your app.

For Node servers and Electron it also asks for the database: SQLite (`node:sqlite`), PGlite (Postgres in WASM, shareable with Prisma / Drizzle) or — on Node servers — a PostgreSQL server such as Postgres in Docker (it asks for the connection URL, defaulting to your `DATABASE_URL`). Non-interactive: `npx @anodb/cli init --env node --db pglite --yes`, or `--db postgres --database-url postgres://…`.

```sh
npx @anodb/cli relay deploy
```

Hosts your own Nostr relay on your Cloudflare account (Workers + Durable Objects) and prints its
`wss://` URL. Running it again updates the same relay.
