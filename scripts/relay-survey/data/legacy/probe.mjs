import fs from 'fs'
import WebSocket from 'ws'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { randomBytes } from 'crypto'
const info = JSON.parse(fs.readFileSync('nip11.json'))
const list = info.filter(o => { const l = o.info?.limitation ?? {}; return !l.auth_required && !l.payment_required && !l.restricted_writes }).map(o => ({ url: o.url, info: o.info }))
console.error('probing', list.length)
function open(url){ return new Promise((res,rej)=>{ const ws=new WebSocket(url,{handshakeTimeout:8000}); const t=setTimeout(()=>{ws.terminate();rej(new Error('connect timeout'))},9000); ws.on('open',()=>{clearTimeout(t);res(ws)}); ws.on('error',e=>{clearTimeout(t);rej(e)}) }) }
function waitMsg(ws, pred, ms){ return new Promise(res=>{ const t=setTimeout(()=>{ws.off('message',h);res(null)},ms); const h=d=>{ try{const m=JSON.parse(d); if(pred(m)){clearTimeout(t);ws.off('message',h);res(m)}}catch{} }; ws.on('message',h) }) }
async function probe(url){
  const r = { url }
  const tag = randomBytes(16).toString('hex')
  const ev = finalizeEvent({ kind: 7303, created_at: Math.floor(Date.now()/1000), tags: [['n', tag]], content: randomBytes(300).toString('base64') }, generateSecretKey())
  let ws
  try { ws = await open(url) } catch (e) { r.err = 'connect'; return r }
  try {
    const t0 = Date.now()
    ws.send(JSON.stringify(['EVENT', ev]))
    const ok = await waitMsg(ws, m => m[0]==='OK' && m[1]===ev.id, 8000)
    r.okMs = Date.now()-t0
    if (!ok) { r.err = 'no OK'; return r }
    if (!ok[2]) { r.err = 'rejected: ' + String(ok[3]).slice(0,80); return r }
  } finally { ws.terminate() }
  await new Promise(s=>setTimeout(s,1500))
  try { ws = await open(url) } catch { r.err = 'reconnect'; return r }
  try {
    ws.send(JSON.stringify(['REQ','q',{ kinds:[7303], '#n':[tag], limit: 5 }]))
    const got = await waitMsg(ws, m => (m[0]==='EVENT' && m[2]?.id===ev.id) || m[0]==='EOSE' || m[0]==='CLOSED', 8000)
    if (got?.[0]==='EVENT') { r.ok = true; r.id = ev.id; r.tag = tag } else r.err = 'not served: ' + (got?.[0] ?? 'timeout')
  } finally { ws.terminate() }
  return r
}
const out=[]; let i=0
async function worker(){ while(i<list.length){ const x=list[i++]; out.push({ ...(await probe(x.url).catch(e=>({url:x.url,err:String(e)}))), software: x.info?.software, nips: x.info?.supported_nips }) ; if(out.length%100===0) console.error(out.length) } }
await Promise.all(Array.from({length:20},worker))
fs.writeFileSync('probe.json', JSON.stringify(out))
const good = out.filter(o=>o.ok)
console.log('stored+served by tag:', good.length, 'of', out.length)
const reasons = {}; for (const o of out.filter(o=>!o.ok)) { const k=(o.err||'').replace(/:.*$/,''); reasons[k]=(reasons[k]??0)+1 }
console.log(reasons)
