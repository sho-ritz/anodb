import fs from 'fs'
import WebSocket from 'ws'
const good = JSON.parse(fs.readFileSync('probe.json')).filter(o=>o.ok)
function check(o){ return new Promise(res=>{ const ws=new WebSocket(o.url,{handshakeTimeout:8000}); const t=setTimeout(()=>{ws.terminate();res(false)},12000)
  ws.on('open',()=>ws.send(JSON.stringify(['REQ','q',{kinds:[7303],'#n':[o.tag],limit:5}])))
  ws.on('message',d=>{try{const m=JSON.parse(d); if(m[0]==='EVENT'&&m[2]?.id===o.id){clearTimeout(t);ws.terminate();res(true)} else if(m[0]==='EOSE'||m[0]==='CLOSED'){clearTimeout(t);ws.terminate();res(false)}}catch{}})
  ws.on('error',()=>{clearTimeout(t);res(false)}) }) }
const out=[]; let i=0
async function w(){ while(i<good.length){ const o=good[i++]; out.push({url:o.url, kept: await check(o)}) } }
await Promise.all(Array.from({length:20},w))
const name = process.argv[2]; fs.writeFileSync(name, JSON.stringify(out))
console.log(new Date().toISOString(), 'still served:', out.filter(o=>o.kept).length, 'of', good.length)
