// Opens envelopes produced by the Rust core with the TypeScript implementation (stdin: JSON from
// `cargo run -q --example interop`). Exits non-zero if anything does not verify.
import { conversationKey, decrypt, hexToBytes, inboxTag, keyId, spaceTag, verifySignedEvent } from '../dist/crypto.js'
import { verifyDelegation } from '../dist/identity.js'
import { parseInboxPayload, parseStreamPayload } from '../dist/protocol.js'

const input = JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => r(s)) }))
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1) }

const sp = input.space
const key = hexToBytes(sp.epochKey)
if (!verifySignedEvent(sp.outer)) fail('space envelope signature')
if (sp.outer.tags[0][1] !== spaceTag(key)) fail('space tag')
const inner = JSON.parse(decrypt(sp.outer.content, key))
if (!verifySignedEvent(inner) || inner.kind !== 7305) fail('inner event')
const p = parseStreamPayload(inner.content)
if (!p || p.sp !== sp.space || p.ep !== keyId(key)) fail('payload')
if (verifyDelegation(p.dlg, inner.pubkey) !== sp.identity || inner.pubkey !== sp.device) fail('delegation')
if (p.c[0][3] !== '日本語 "quoted"\n') fail('value round trip')

const ib = input.inbox
const rk = hexToBytes(ib.receiverSecret)
const { getPublicKey } = await import('../dist/crypto.js')
if (!verifySignedEvent(ib.outer) || ib.outer.tags[0][1] !== inboxTag(getPublicKey(rk))) fail('inbox envelope')
const ii = JSON.parse(decrypt(ib.outer.content, conversationKey(rk, ib.outer.pubkey)))
if (!verifySignedEvent(ii) || !parseInboxPayload(ii.content)) fail('inbox inner')
console.log('✓ TypeScript opened the Rust envelopes (space stream + inbox)')
