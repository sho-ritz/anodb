import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Runner, WRANGLER, kindsVar, relayUrlFrom, runRelay } from '../src/cli/relay.js'

/** Fake wrangler: records calls, answers like the real CLI. */
function fakeWrangler(loggedIn: boolean) {
  const calls: string[] = []
  const run: Runner = async (_cmd, args) => {
    expect(args.slice(0, 2)).toEqual(['--yes', WRANGLER])
    const sub = args.slice(2)
    calls.push(sub[0]!)
    if (sub[0] === 'whoami') return { code: 0, stdout: loggedIn ? 'You are logged in with an OAuth Token' : 'You are not authenticated. Please run `wrangler login`.' }
    if (sub[0] === 'login') return { code: 0, stdout: '' }
    if (sub[0] === 'deploy') return { code: 0, stdout: 'Uploaded anodb-relay (3.1 sec)\nDeployed anodb-relay triggers (0.5 sec)\n  https://my-relay.alice.workers.dev\nCurrent Version ID: abc' }
    return { code: 1, stdout: '' }
  }
  return { run, calls }
}

describe('anodb relay deploy', () => {
  it('logs in when needed, deploys, prints the wss:// URL and reuses the Worker next time', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'anodb-relay-cli-'))
    const out: string[] = []
    const w = fakeWrangler(false)
    const state = await runRelay('deploy', { lang: 'en', name: 'my-relay' }, { cwd, run: w.run, log: (s) => out.push(s) })
    expect(w.calls).toEqual(['whoami', 'login', 'deploy'])
    expect(state).toMatchObject({ name: 'my-relay', url: 'wss://my-relay.alice.workers.dev' })
    expect(out.join('\n')).toContain("relays: ['wss://my-relay.alice.workers.dev']")

    const dir = join(cwd, '.anodb/relay')
    const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8')
    expect(toml).toContain('name = "my-relay"')
    expect(toml).toContain('new_sqlite_classes = ["Relay"]')
    expect(toml).toMatch(/main = ".*relay\/worker\.js"/)
    expect(toml).toContain('RELAY_KINDS = "5,7303,7304,10304,25050,27303,27305"')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.wrangler/')

    // Second run: no login, same name from relay.json (same Worker, same storage).
    const w2 = fakeWrangler(true)
    const again = await runRelay('deploy', { lang: 'en', kinds: '*' }, { cwd, run: w2.run, log: () => {} })
    expect(w2.calls).toEqual(['whoami', 'deploy'])
    expect(again?.name).toBe('my-relay')
    expect(readFileSync(join(dir, 'wrangler.toml'), 'utf8')).toContain('RELAY_KINDS = "*"')
  })

  it('dry run builds without login; options are validated', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'anodb-relay-cli-'))
    const w = fakeWrangler(false)
    await runRelay('deploy', { lang: 'en', dryRun: true }, { cwd, run: w.run, log: () => {} })
    expect(w.calls).toEqual(['deploy'])
    expect(existsSync(join(cwd, '.anodb/relay/relay.json'))).toBe(false)
    await expect(runRelay('deploy', { name: 'Bad_Name' }, { cwd, run: w.run, log: () => {} })).rejects.toThrow(/invalid Worker name/)
    await expect(runRelay('nope', {}, { cwd, run: w.run, log: () => {} })).rejects.toThrow(/usage/)
    expect(() => kindsVar('1,x')).toThrow(/--kinds/)
    expect(kindsVar('1, 2')).toBe('1,2')
    expect(relayUrlFrom('no url here')).toBeNull()
  })
})
