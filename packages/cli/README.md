# @anodb/cli

```sh
npx @anodb/cli init
```

Interactive setup for [anoDB](https://github.com/sho-ritz/anodb): installs `@anodb/core`, generates the schema, database and React provider, copies the SQLite WASM files for web apps and wires the provider into your app.

For Node servers and Electron it also asks for the database: SQLite (`node:sqlite`) or PGlite (Postgres in WASM, shareable with Prisma / Drizzle). Non-interactive: `npx @anodb/cli init --env node --db pglite --yes`.
