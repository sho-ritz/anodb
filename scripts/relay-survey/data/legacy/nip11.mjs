import fs from 'fs'
const urls = JSON.parse(fs.readFileSync('urls.json')).filter(x=>x[1]>=3).map(x=>x[0])
const out = []
let i = 0, done = 0
async function one(u){
  const http = u.replace(/^wss:/,'https:')
  const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), 10000)
  try { const r = await fetch(http,{headers:{Accept:'application/nostr+json'},signal:ac.signal}); const j = await r.json(); out.push({url:u, info:j}) } catch {} finally { clearTimeout(t); done++ }
}
async function worker(){ while(i<urls.length){ const u=urls[i++]; await one(u) } }
await Promise.all(Array.from({length:25},worker))
fs.writeFileSync('nip11.json', JSON.stringify(out))
const lim = out.map(o=>o.info?.limitation??{})
console.log('nip11 ok', out.length, 'of', urls.length)
console.log('auth_required', lim.filter(l=>l.auth_required).length, 'payment_required', lim.filter(l=>l.payment_required).length, 'restricted_writes', lim.filter(l=>l.restricted_writes).length)
