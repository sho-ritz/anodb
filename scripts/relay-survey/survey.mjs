#!/usr/bin/env node
// Relay survey for anoDB's relay pool. See CRITERIA.md for what is checked and why.
//
//   node survey.mjs collect          gather relay URLs (NIP-66 monitors + kind 10002 lists)
//   node survey.mjs nip11            fetch NIP-11 documents
//   node survey.mjs check [--burst]  write/read tests (A1–A6, B3–B6); stores retention probes
//   node survey.mjs daily            read-only: reachability (B2) and retention of probes (A7, B1)
//   node survey.mjs select [--allow-provisional]   score, apply C1–C3, write the pool
//
// Output goes to ./data (relative to this file).
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket from 'ws'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

// Egress proxy (HTTPS_PROXY / HTTP_PROXY). TLS stays end-to-end with the relay (CONNECT tunnel).
// There is deliberately no fallback to a direct connection, and the URL (which may carry
// credentials) is never logged or written to data/.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || ''
const AGENT = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined
const VIA_PROXY = !!AGENT

const CRITERIA_VERSION = 2
const DIR = path.dirname(fileURLToPath(import.meta.url))
const DATA = process.env.SURVEY_DATA ?? path.join(DIR, 'data')
const TARGET = 100
// anoDB's largest envelope: 60 KiB plaintext → NIP-44 padding to 65,536 + 67 bytes → base64 87,472 chars.
const BIG_CONTENT_BYTES = 65_603 // base64 → 87,472 characters, the same as anoDB's largest envelope
const MIN_MESSAGE_BYTES = 90_112 // 88 KiB: room for that content plus the event JSON
const BURST = 20
const PROBE_KEEP_DAYS = 60
const UPTIME_DAYS = 14
const MIN_UPTIME_SAMPLES = 7
const MAX_PER_OPERATOR = 2
const MAX_SOFTWARE_SHARE = 0.7
const MAX_REGION_SHARE = 0.4
const MIN_VALID_REACHABLE_RATIO = 0.8 // a daily run below this is not used for uptime (B2)

// ---------------------------------------------------------------- utilities

const today = () => new Date().toISOString().slice(0, 10)
const nowSec = () => Math.floor(Date.now() / 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (n) => randomBytes(n).toString('hex')
const b64 = (n) => randomBytes(n).toString('base64')
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null)

function file(...p) {
  return path.join(DATA, ...p)
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n')
}
function datedFiles(dir) {
  try {
    return fs.readdirSync(file(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  } catch {
    return []
  }
}

async function runPool(items, concurrency, fn, label) {
  let i = 0
  let done = 0
  const out = []
  async function worker() {
    while (i < items.length) {
      const item = items[i++]
      try {
        out.push(await fn(item))
      } catch (e) {
        out.push({ url: item.url ?? item, error: String(e?.message ?? e) })
      }
      if (++done % 100 === 0) console.error(`  ${label}: ${done}/${items.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return out
}

export function normalizeUrl(u) {
  try {
    const x = new URL(String(u).trim())
    if (x.protocol !== 'wss:') return null
    const host = x.host.toLowerCase()
    if (/^(localhost|127\.|10\.|192\.168\.)|\.onion$|\.local$|^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host)) return null
    const p = x.pathname === '/' ? '' : x.pathname.replace(/\/$/, '')
    return `wss://${host}${p}`
  } catch {
    return null
  }
}

const MULTI_PART_SUFFIX = new Set(['co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.uk', 'org.uk', 'com.br', 'com.au', 'co.kr', 'com.cn', 'co.nz', 'co.za', 'com.tr'])
/** Operator key for C1: registrable domain (conservative: shared hosting counts as one operator). */
export function operatorOf(url) {
  const labels = new URL(url.replace(/^wss:/, 'https:')).hostname.split('.')
  const two = labels.slice(-2).join('.')
  return MULTI_PART_SUFFIX.has(two) ? labels.slice(-3).join('.') : two
}
function softwareOf(info) {
  const s = String(info?.software ?? '').toLowerCase()
  if (!s) return 'unknown'
  return s.replace(/^git\+/, '').replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, '').split('/').slice(0, 3).join('/')
}

// ---------------------------------------------------------------- websocket

/** Connect, retrying once over the same route (a flaky egress should not count as relay downtime). */
async function connect(url, ms = 9000) {
  return (await connectOnce(url, ms)) ?? (await connectOnce(url, ms))
}

function connectOnce(url, ms) {
  return new Promise((resolve) => {
    const msgs = []
    const waiters = new Set()
    let ws
    try {
      ws = new WebSocket(url, { handshakeTimeout: ms, ...(AGENT ? { agent: AGENT } : {}) })
    } catch {
      return resolve(null)
    }
    const started = Date.now()
    const c = {
      connectMs: 0,
      send(m) {
        try {
          ws.send(JSON.stringify(m))
          return true
        } catch {
          return false
        }
      },
      wait(pred, timeout) {
        return new Promise((r) => {
          const w = {
            check() {
              const i = msgs.findIndex(pred)
              if (i >= 0) finish(msgs.splice(i, 1)[0])
            },
            fail: () => finish(null),
          }
          const t = setTimeout(() => finish(null), timeout)
          function finish(m) {
            clearTimeout(t)
            waiters.delete(w)
            r(m)
          }
          waiters.add(w)
          w.check()
        })
      },
      close() {
        try {
          ws.terminate()
        } catch {}
      },
    }
    const t = setTimeout(() => {
      c.close()
      resolve(null)
    }, ms + 1000)
    ws.on('open', () => {
      clearTimeout(t)
      c.connectMs = Date.now() - started
      resolve(c)
    })
    ws.on('error', () => {
      clearTimeout(t)
      resolve(null)
    })
    ws.on('close', () => {
      for (const w of [...waiters]) w.fail()
    })
    ws.on('message', (d) => {
      let m
      try {
        m = JSON.parse(d)
      } catch {
        return
      }
      if (!Array.isArray(m)) return
      msgs.push(m)
      for (const w of [...waiters]) w.check()
    })
  })
}

async function publish(c, ev, timeout = 8000) {
  const t0 = Date.now()
  if (!c.send(['EVENT', ev])) return { ok: null, msg: 'send failed', ms: null }
  const m = await c.wait((m) => m[0] === 'OK' && m[1] === ev.id, timeout)
  if (!m) return { ok: null, msg: 'no OK', ms: null }
  return { ok: m[2] === true, msg: String(m[3] ?? ''), ms: Date.now() - t0 }
}

let subSeq = 0
async function query(c, filter, timeout = 8000) {
  const sub = `q${++subSeq}`
  const events = []
  if (!c.send(['REQ', sub, filter])) return { events, end: 'send failed' }
  const deadline = Date.now() + timeout
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) return { events, end: 'timeout' }
    const m = await c.wait((m) => m[1] === sub && (m[0] === 'EVENT' || m[0] === 'EOSE' || m[0] === 'CLOSED'), left)
    if (!m) return { events, end: 'timeout' }
    if (m[0] === 'EVENT') events.push(m[2])
    else {
      c.send(['CLOSE', sub])
      return { events, end: m[0] === 'EOSE' ? 'eose' : `closed: ${m[2] ?? ''}` }
    }
  }
}

function make(kind, tags, { content = b64(300), createdAt = nowSec(), sk = generateSecretKey() } = {}) {
  return { ev: finalizeEvent({ kind, created_at: createdAt, tags, content }, sk), sk }
}

// ---------------------------------------------------------------- collect

async function collectFrom(src, filter, onEvent, ms = 15000) {
  const c = await connect(src)
  if (!c) return 0
  const r = await query(c, filter, ms)
  c.close()
  for (const e of r.events) onEvent(e)
  return r.events.length
}

async function cmdCollect() {
  const sources = ['wss://relay.nostr.watch', 'wss://monitorlizard.nostr1.com', 'wss://relaypag.es', 'wss://purplepag.es', 'wss://relay.primal.net', 'wss://nos.lol']
  const weight = new Map()
  const geo = readJson(file('geo.json'), {})
  const add = (u, w) => {
    const n = normalizeUrl(u)
    if (n) weight.set(n, (weight.get(n) ?? 0) + w)
    return n
  }
  for (const s of sources) {
    const a = await collectFrom(s, { kinds: [30166], limit: 5000 }, (e) => {
      const n = add(e.tags.find((t) => t[0] === 'd')?.[1] ?? '', 3)
      const g = e.tags.find((t) => t[0] === 'g' && typeof t[1] === 'string' && t[1].length > 0)?.[1]
      if (n && g && !geo[n]) geo[n] = g.toLowerCase()
    })
    const b = await collectFrom(s, { kinds: [10002], limit: 3000 }, (e) => {
      for (const t of e.tags) if (t[0] === 'r' && t[1]) add(t[1], 1)
    })
    console.error(`  ${s}: monitors ${a}, relay lists ${b}, unique ${weight.size}`)
  }
  const urls = [...weight.entries()].sort((x, y) => y[1] - x[1])
  if (urls.length === 0) {
    console.error('collect: no source answered — kept the previous urls.json (check the network / proxy)')
    process.exit(1)
  }
  writeJson(file('urls.json'), urls)
  writeJson(file('geo.json'), geo)
  console.log(`collect: ${urls.length} unique URLs (${urls.filter((u) => u[1] >= 3).length} seen by monitors)`)
}

// ---------------------------------------------------------------- nip11

/** NIP-11 over node:https so the same proxy agent applies (no reliance on fetch's env-proxy support). */
function getNip11(url, ms = 10_000) {
  return new Promise((resolve) => {
    let req
    const done = (v) => {
      clearTimeout(t)
      req?.destroy()
      resolve(v)
    }
    const t = setTimeout(() => done(null), ms)
    try {
      req = https.get(url.replace(/^wss:/, 'https:'), { headers: { Accept: 'application/nostr+json' }, ...(AGENT ? { agent: AGENT } : {}) }, (res) => {
        if (res.statusCode !== 200) return done(null)
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          body += c
          if (body.length > 512 * 1024) done(null)
        })
        res.on('end', () => {
          try {
            const j = JSON.parse(body)
            done(j && typeof j === 'object' ? j : null)
          } catch {
            done(null)
          }
        })
        res.on('error', () => done(null))
      })
      req.on('error', () => done(null))
    } catch {
      done(null)
    }
  })
}

async function cmdNip11() {
  const urls = readJson(file('urls.json'), [])
    .filter((x) => x[1] >= 3)
    .map((x) => x[0])
  const res = await runPool(
    urls,
    25,
    async (url) => ({ url, info: (await getNip11(url)) ?? (await getNip11(url)) }),
    'nip11',
  )
  const ok = res.filter((r) => r.info && typeof r.info === 'object')
  if (ok.length === 0) {
    console.error('nip11: no relay answered — kept the previous nip11.json (check the network / proxy)')
    process.exit(1)
  }
  writeJson(file('nip11.json'), ok)
  console.log(`nip11: ${ok.length} of ${urls.length} answered`)
}

// ---------------------------------------------------------------- check

async function checkRelay(url, info, { burst }) {
  const lim = info?.limitation ?? {}
  const r = { url, at: new Date().toISOString(), software: softwareOf(info), a: {}, b: {}, why: {} }
  r.a.A1 = !lim.auth_required && !lim.payment_required && !lim.restricted_writes
  if (!r.a.A1) {
    r.why.A1 = Object.entries({ auth_required: lim.auth_required, payment_required: lim.payment_required, restricted_writes: lim.restricted_writes })
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(',')
    return { r }
  }
  const c = await connect(url)
  if (!c) {
    r.reachable = false
    return { r }
  }
  r.reachable = true
  const writeMs = []
  const tag = hex(16)
  const cur = make(7303, [['n', tag]])
  const old = make(7303, [['n', tag]], { createdAt: nowSec() - 120 })
  let probe = null
  try {
    // A2: a fresh pubkey may write kind 7303
    const p1 = await publish(c, cur.ev)
    r.a.A2 = p1.ok === true
    if (p1.ms !== null) writeMs.push(p1.ms)
    if (!r.a.A2) {
      r.why.A2 = p1.msg.slice(0, 120)
      return { r }
    }
    const p0 = await publish(c, old.ev)
    if (p0.ms !== null) writeMs.push(p0.ms)
    // A5: a ~90 KB event
    const big = make(7303, [['n', hex(16)]], { content: b64(BIG_CONTENT_BYTES) })
    const pb = await publish(c, big.ev, 15_000)
    if (pb.ms !== null) writeMs.push(pb.ms)
    const declared = typeof lim.max_message_length === 'number' ? lim.max_message_length : null
    r.a.A5 = pb.ok === true && (declared === null || declared >= MIN_MESSAGE_BYTES)
    if (!r.a.A5) r.why.A5 = pb.ok === true ? `max_message_length ${declared}` : pb.msg.slice(0, 120)
    c.close()
    await sleep(1500)

    // A3 / A4 / A5-read / B5 / B6 on a new connection
    const c2 = await connect(url)
    if (!c2) {
      r.a.A3 = false
      r.why.A3 = 'reconnect failed'
      return { r }
    }
    try {
      const q = await query(c2, { kinds: [7303], '#n': [tag], limit: 10 })
      const has = (res, ev) => res.events.some((e) => e.id === ev.id)
      r.a.A3 = has(q, cur.ev)
      if (!r.a.A3) r.why.A3 = `not served (${q.end})`
      else probe = { url, id: cur.ev.id, tag, writtenAt: cur.ev.created_at * 1000 }

      const split = nowSec() - 60
      const qs = await query(c2, { kinds: [7303], '#n': [tag], since: split, limit: 10 })
      const qu = await query(c2, { kinds: [7303], '#n': [tag], until: split, limit: 10 })
      if (p0.ok === true) {
        r.a.A4 = has(qs, cur.ev) && !has(qs, old.ev) && has(qu, old.ev) && !has(qu, cur.ev)
      } else {
        r.a.A4 = has(qs, cur.ev) && !has(qu, cur.ev)
        r.why.A4note = `older event refused: ${p0.msg.slice(0, 80)}`
      }
      if (!r.a.A4) r.why.A4 = 'since/until not honoured'

      if (r.a.A5) {
        const qb = await query(c2, { ids: [big.ev.id] })
        r.a.A5 = has(qb, big.ev)
        if (!r.a.A5) r.why.A5 = 'big event accepted but not served'
      }

      // B5: NIP-77 (initial message for an empty set)
      c2.send(['NEG-OPEN', 'neg', { kinds: [7303], '#n': [tag] }, '6100000200'])
      const n = await c2.wait((m) => ((m[0] === 'NEG-MSG' || m[0] === 'NEG-ERR' || m[0] === 'CLOSED') && m[1] === 'neg') || m[0] === 'NOTICE', 6000)
      r.b.B5 = n?.[0] === 'NEG-MSG'
      c2.send(['NEG-CLOSE', 'neg'])

      // B6: NIP-09 deletion of the older test event (never the retention probe)
      if (p0.ok === true) {
        const del = make(5, [['e', old.ev.id], ['k', '7303']], { content: '', sk: old.sk })
        const pd = await publish(c2, del.ev)
        await sleep(500)
        const qd = await query(c2, { ids: [old.ev.id] })
        r.b.B6 = pd.ok === true && !has(qd, old.ev)
      } else r.b.B6 = null

      // B4: ephemeral kind 27303 relayed to another subscriber
      const sub = await connect(url)
      if (sub) {
        const etag = hex(16)
        sub.send(['REQ', 'eph', { kinds: [27303], '#n': [etag] }])
        await sub.wait((m) => m[1] === 'eph' && (m[0] === 'EOSE' || m[0] === 'CLOSED'), 4000)
        const e = make(27303, [['n', etag]], { content: b64(100) })
        c2.send(['EVENT', e.ev])
        const got = await sub.wait((m) => m[0] === 'EVENT' && m[1] === 'eph' && m[2]?.id === e.ev.id, 5000)
        r.b.B4 = !!got
        sub.close()
      } else r.b.B4 = false
    } finally {
      c2.close()
    }

    // A6: burst of fresh keys from one connection
    if (burst) {
      const c3 = await connect(url)
      if (!c3) {
        r.a.A6 = false
        r.why.A6 = 'connect failed'
      } else {
        const btag = hex(16)
        const evs = Array.from({ length: BURST }, () => make(7303, [['n', btag]]).ev)
        for (const e of evs) c3.send(['EVENT', e])
        const oks = await Promise.all(evs.map((e) => c3.wait((m) => m[0] === 'OK' && m[1] === e.id, 10_000)))
        const accepted = oks.filter((m) => m?.[2] === true).length
        r.a.A6 = accepted === BURST
        r.a.A6count = accepted
        if (!r.a.A6) r.why.A6 = String(oks.find((m) => m && m[2] !== true)?.[3] ?? 'no OK').slice(0, 120)
        c3.close()
      }
    }
  } finally {
    c.close()
    r.b.B3ms = median(writeMs)
  }
  return { r, probe }
}

async function cmdCheck(args) {
  const burst = args.includes('--burst')
  const infos = readJson(file('nip11.json'), [])
  if (!infos.length) throw new Error('run `node survey.mjs nip11` first')
  console.error(`check: ${infos.length} relays${burst ? ' (with burst)' : ''}`)
  const res = await runPool(infos, 20, (x) => checkRelay(x.url, x.info, { burst }), 'check')
  const results = res.map((x) => x.r ?? x)
  writeJson(file('checks', `${today()}.json`), { criteriaVersion: CRITERIA_VERSION, burst, viaProxy: VIA_PROXY, results })
  const probes = readJson(file('probes.json'), [])
  for (const x of res) if (x.probe) probes.push(x.probe)
  writeJson(file('probes.json'), probes)
  const pass = results.filter((r) => r.a?.A1 && r.a.A2 && r.a.A3 && r.a.A4 && r.a.A5 && (!burst || r.a.A6))
  console.log(`check: ${pass.length} of ${results.length} pass A1–A${burst ? 6 : 5}; ${res.filter((x) => x.probe).length} new retention probes`)
}

// ---------------------------------------------------------------- daily

async function cmdDaily() {
  const cutoff = Date.now() - PROBE_KEEP_DAYS * 86_400_000
  const probes = readJson(file('probes.json'), []).filter((p) => p.writtenAt >= cutoff)
  writeJson(file('probes.json'), probes)
  const byUrl = new Map()
  for (const p of probes) byUrl.set(p.url, [...(byUrl.get(p.url) ?? []), p])
  const targets = [...byUrl.keys()]
  console.error(`daily: ${targets.length} relays, ${probes.length} probes`)
  const res = await runPool(
    targets,
    20,
    async (url) => {
      const ps = byUrl.get(url)
      const c = await connect(url)
      if (!c) return { url, reachable: false, probes: ps.map((p) => ({ id: p.id, ageH: Math.round((Date.now() - p.writtenAt) / 3_600_000), kept: null })) }
      try {
        const q = await query(c, { kinds: [7303], '#n': ps.map((p) => p.tag), limit: 500 }, 12_000)
        const found = new Set(q.events.map((e) => e.id))
        const answered = q.end === 'eose'
        return {
          url,
          reachable: answered,
          connectMs: c.connectMs,
          probes: ps.map((p) => ({ id: p.id, ageH: Math.round((Date.now() - p.writtenAt) / 3_600_000), kept: answered ? found.has(p.id) : null })),
        }
      } finally {
        c.close()
      }
    },
    'daily',
  )
  const up = res.filter((r) => r.reachable).length
  const reachableRatio = res.length ? up / res.length : 0
  // A run where most relays look down says more about this machine's network than about the
  // relays: keep it for retention (unreachable relays already count as "unknown") but not for B2.
  const valid = res.length > 0 && reachableRatio >= MIN_VALID_REACHABLE_RATIO
  writeJson(file('daily', `${today()}.json`), { viaProxy: VIA_PROXY, valid, reachableRatio: Math.round(reachableRatio * 1000) / 1000, results: res })
  if (!valid) console.log(`daily: only ${Math.round(reachableRatio * 100)}% reachable — run marked invalid for uptime (B2)`)
  const lost = res.filter((r) => r.probes?.some((p) => p.kept === false)).length
  console.log(`daily: ${up} of ${res.length} reachable; ${lost} relays lost at least one probe`)
}

// ---------------------------------------------------------------- select

function regionOf(geohash) {
  return geohash ? geohash[0] : 'unknown'
}

function cmdSelect(args) {
  const allowProvisional = args.includes('--allow-provisional')
  const latest = new Map()
  const latestBurst = new Map()
  for (const f of datedFiles('checks')) {
    const d = readJson(file('checks', f), { results: [] })
    for (const r of d.results) {
      latest.set(r.url, r)
      if (d.burst && r.a?.A6 !== undefined) latestBurst.set(r.url, r.a.A6)
    }
  }
  const dailyFiles = datedFiles('daily')
  // Daily files: { viaProxy, valid, reachableRatio, results } (older files: a bare array).
  const days = dailyFiles.map((f) => {
    const d = readJson(file('daily', f), [])
    return Array.isArray(d) ? { valid: true, results: d } : { valid: d.valid !== false, results: d.results ?? [] }
  })
  const all = days.map((d) => d.results)
  const recent = days
    .filter((d) => d.valid)
    .slice(-UPTIME_DAYS)
    .map((d) => d.results)
  const geo = readJson(file('geo.json'), {})

  const rows = []
  for (const [url, r] of latest) {
    const reasons = []
    const unknown = []
    for (const k of ['A1', 'A2', 'A3', 'A4', 'A5']) if (r.a?.[k] !== true) reasons.push(k)
    const a6 = latestBurst.get(url)
    if (a6 === false) reasons.push('A6')
    else if (a6 === undefined) unknown.push('A6')

    // A7 / B1: retention seen in any daily run (only when the relay answered)
    let a7 = null
    let b1 = null
    for (const day of all)
      for (const d of day)
        if (d.url === url)
          for (const p of d.probes ?? []) {
            if (p.kept === null) continue
            if (p.ageH >= 7 * 24) a7 = a7 === false ? false : p.kept
            if (p.ageH >= 30 * 24) b1 = b1 === false ? false : p.kept
          }
    if (a7 === false) reasons.push('A7')
    else if (a7 === null) unknown.push('A7')

    // B2: uptime over the last UPTIME_DAYS daily runs that included this relay
    const samples = recent.map((day) => day.find((d) => d.url === url)).filter(Boolean)
    const uptime = samples.length ? samples.filter((d) => d.reachable).length / samples.length : null
    if (samples.length >= MIN_UPTIME_SAMPLES && uptime < 0.95) reasons.push('B2')
    else if (samples.length < MIN_UPTIME_SAMPLES) unknown.push('B2')

    const ms = r.b?.B3ms
    const score =
      (b1 === true ? 3 : 0) +
      (uptime ?? 0) * 4 +
      (ms == null ? 0 : ms < 500 ? 2 : ms < 1000 ? 1 : ms < 2000 ? 0.5 : 0) +
      (r.b?.B4 ? 1 : 0) +
      (r.b?.B5 ? 1 : 0) +
      (r.b?.B6 ? 0.5 : 0)
    const status = reasons.length ? 'fail' : unknown.length ? 'provisional' : 'pass'
    rows.push({
      url,
      status,
      reasons,
      unknown,
      score: Math.round(score * 100) / 100,
      operator: operatorOf(url),
      software: r.software ?? 'unknown',
      region: regionOf(geo[url]),
      uptime: uptime === null ? null : Math.round(uptime * 1000) / 1000,
      uptimeSamples: samples.length,
      retention7d: a7,
      retention30d: b1,
      writeMs: ms ?? null,
      ephemeral: r.b?.B4 ?? null,
      nip77: r.b?.B5 ?? null,
      deletion: r.b?.B6 ?? null,
    })
  }

  const eligible = rows.filter((x) => x.status === 'pass' || (allowProvisional && x.status === 'provisional')).sort((a, b) => b.score - a.score || (a.writeMs ?? 1e9) - (b.writeMs ?? 1e9))
  const selected = []
  const skipped = []
  const count = (key, v) => selected.filter((s) => s[key] === v).length
  for (const x of eligible) {
    if (selected.length >= TARGET) break
    if (count('operator', x.operator) >= MAX_PER_OPERATOR) skipped.push({ url: x.url, rule: 'C1' })
    else if (x.software !== 'unknown' && count('software', x.software) + 1 > MAX_SOFTWARE_SHARE * TARGET) skipped.push({ url: x.url, rule: 'C2' })
    else if (x.region !== 'unknown' && count('region', x.region) + 1 > MAX_REGION_SHARE * TARGET) skipped.push({ url: x.url, rule: 'C3' })
    else selected.push(x)
  }
  const chosen = new Set(selected.map((s) => s.url))
  const reserves = eligible.filter((x) => !chosen.has(x.url) && !skipped.some((s) => s.url === x.url)).slice(0, 30)

  const tally = (xs, k) => xs.reduce((m, x) => ((m[x[k]] = (m[x[k]] ?? 0) + 1), m), {})
  const failBy = {}
  for (const x of rows.filter((x) => x.status === 'fail')) for (const k of x.reasons) failBy[k] = (failBy[k] ?? 0) + 1
  const summary = {
    generatedAt: new Date().toISOString(),
    criteriaVersion: CRITERIA_VERSION,
    target: TARGET,
    includesProvisional: allowProvisional,
    relaysEvaluated: rows.length,
    status: tally(rows, 'status'),
    failedBy: failBy,
    selected: selected.length,
    skippedByRule: tally(skipped, 'rule'),
    dailyRuns: dailyFiles.length,
    dailyRunsInvalid: days.filter((d) => !d.valid).length,
    viaProxy: VIA_PROXY,
  }
  writeJson(file('pool', `${today()}.json`), { ...summary, relays: selected, reserves })
  fs.writeFileSync(file('pool', `${today()}.txt`), selected.map((s) => s.url).join('\n') + '\n')
  writeJson(file('evaluation.json'), rows)
  console.log(JSON.stringify(summary, null, 2))
  if (selected.length < TARGET) console.log(`select: only ${selected.length} of ${TARGET} — see status/failedBy above`)
}

// ---------------------------------------------------------------- main

const [cmd, ...args] = process.argv.slice(2)
const cmds = { collect: cmdCollect, nip11: cmdNip11, check: cmdCheck, daily: cmdDaily, select: cmdSelect }
if (!cmds[cmd]) {
  console.error('usage: node survey.mjs <collect|nip11|check [--burst]|daily|select [--allow-provisional]>')
  process.exit(2)
}
await cmds[cmd](args)
