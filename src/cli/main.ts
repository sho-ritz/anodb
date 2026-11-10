#!/usr/bin/env node
import { type InitFlags, copySqlJsAssets, runInit } from './init.js'

const HELP = `anodb — Absolutely No DB

Usage:
  npx @anodb/cli init [options]     set up anoDB in this project (interactive)
  npx anodb assets             copy the sql.js files into <public>/anodb (browser apps)

Options:
  --lang ja|en                 language of the prompts
  --env browser|tauri|electron|expo|node
  --framework react|vue|svelte|none
  --app-id <id>
  --keys stored|recovery|signer   end-user key handling (non-Node)
  --identity <nsec|hex>        import an identity key (Node)
  --device-name <name>
  --relays <url,url>
  --check / --no-check         relay connectivity check
  --install / --no-install     install packages
  --wire / --no-wire           wrap the app in <DBProvider> (React)
  --yes                        accept defaults, no prompts
  --force                      overwrite generated files
`

function parse(argv: string[]): { cmd: string | undefined; flags: InitFlags } {
  const flags: InitFlags = {}
  const [cmd, ...rest] = argv
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    const oneOf = <T extends string>(...allowed: T[]): T => {
      const v = val()
      if (!(allowed as string[]).includes(v)) throw new Error(`${a} must be one of ${allowed.join(', ')}`)
      return v as T
    }
    const val = () => {
      const v = rest[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    switch (a) {
      case '--lang': flags.lang = oneOf('ja', 'en'); break
      case '--env': flags.env = oneOf('browser', 'tauri', 'electron', 'expo', 'node'); break
      case '--framework': flags.framework = oneOf('react', 'vue', 'svelte', 'none'); break
      case '--app-id': flags.appId = val(); break
      case '--keys': flags.keys = oneOf('stored', 'recovery', 'signer'); break
      case '--identity': flags.identity = val(); break
      case '--device-name': flags.deviceName = val(); break
      case '--relays': flags.relays = val().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--check': flags.check = true; break
      case '--no-check': flags.check = false; break
      case '--install': flags.install = true; break
      case '--no-install': flags.install = false; break
      case '--wire': flags.wire = true; break
      case '--no-wire': flags.wire = false; break
      case '--yes': case '-y': flags.yes = true; break
      case '--force': flags.force = true; break
      default: throw new Error(`unknown option ${a}`)
    }
  }
  return { cmd, flags }
}

try {
  const { cmd, flags } = parse(process.argv.slice(2))
  if (cmd === 'assets') {
    const out = copySqlJsAssets(process.cwd())
    if (!out) throw new Error('sql.js is not installed (npm install sql.js)')
    console.log(`anodb: copied sql.js to ${out}/`)
    process.exit(0)
  }
  if (cmd !== 'init') {
    console.log(HELP)
    process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 1)
  }
  await runInit(flags, { cwd: process.cwd() })
  process.exit(0)
} catch (e) {
  console.error(`anodb: ${(e as Error).message}`)
  process.exit(1)
}
