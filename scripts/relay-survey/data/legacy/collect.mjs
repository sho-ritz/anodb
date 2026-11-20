// Collect relay URLs: NIP-66 (kind 30166 d-tag) + kind 10002 relay lists.
import WebSocket from 'ws'
const sources = ['wss://relay.nostr.watch','wss://monitorlizard.nostr1.com','wss://relaypag.es','wss://purplepag.es','wss://relay.primal.net','wss://nos.lol','wss://relay.damus.io']
const urls = new Map() // url -> count
const add = (u, w=1) => { try { const x = new URL(u.trim()); if (x.protocol!=='wss:') return; let s = 'wss://' + x.host.toLowerCase() + (x.pathname==='/'?'':x.pathname.replace(/\/$/,'')); if (/localhost|127\.|\.onion|\.local$|^wss:\/\/\d+\.\d+\.\d+\.\d+/.test(s)) return; urls.set(s,(urls.get(s)??0)+w) } catch {} }
function q(src, filter, ms=15000){ return new Promise(res=>{ let n=0; const ws=new WebSocket(src,{handshakeTimeout:8000}); const t=setTimeout(()=>{try{ws.close()}catch{};res(n)},ms)
  ws.on('open',()=>ws.send(JSON.stringify(['REQ','x',filter])))
  ws.on('message',d=>{ try{ const m=JSON.parse(d); if(m[0]==='EVENT'){ n++; const e=m[2]; if(e.kind===30166){ const dt=e.tags.find(t=>t[0]==='d')?.[1]; if(dt) add(dt,3)} else for(const t of e.tags) if(t[0]==='r'&&t[1]) add(t[1]) } else if(m[0]==='EOSE'){clearTimeout(t);ws.close();res(n)} }catch{} })
  ws.on('error',()=>{clearTimeout(t);res(n)}) }) }
for (const s of sources) {
  const a = await q(s,{kinds:[30166],limit:5000})
  const b = await q(s,{kinds:[10002],limit:3000})
  console.error(s,'30166:',a,'10002:',b,'total urls',urls.size)
}
const out=[...urls.entries()].sort((a,b)=>b[1]-a[1])
import fs from 'fs'; fs.writeFileSync(process.argv[2], JSON.stringify(out))
console.error('unique', out.length)
