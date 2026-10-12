const fs=require('node:fs');
const path=require('node:path');
const WebSocket=require('ws');
const {MemoryStore,sessionConfig,distance}=require('./core');
const root=GetResourcePath(GetCurrentResourceName());
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
const memory=new MemoryStore(path.join(root,'data','memory.json'));
const active=new Map(), cooldown=new Map();
const key=()=>GetConvar('fivemai_openai_key','');
function identity(src) { return getPlayerIdentifiers(String(src)).find(x=>x.startsWith('license:')); }
function nearby(src,npc) {
  const ped=GetPlayerPed(String(src));
  if (!ped || GetPlayerRoutingBucket(String(src))!==0) return false;
  const [x,y,z]=GetEntityCoords(ped);
  return distance({x,y,z},npc.coords)<=config.interactionDistance+1;
}
async function stop(src) {
  const s=active.get(src); if (!s) return;
  active.delete(src); clearTimeout(s.timer); s.ws?.close();
  emitNet('fivemai:closed',src);
  if (s.callId) {
    try { await fetch(`https://api.openai.com/v1/realtime/calls/${s.callId}/hangup`,{method:'POST',headers:{Authorization:`Bearer ${key()}`},signal:AbortSignal.timeout(10000)}); }
    catch { console.warn('[fivemai] Impossible de confirmer la fermeture OpenAI.'); }
  }
}
onNet('fivemai:offer',async (npcId,sdp)=>{
  const src=Number(global.source);
  const npc=config.npcs.find(n=>n.id===npcId);
  if (!npc || typeof sdp!=='string' || sdp.length>40000 || !sdp.startsWith('v=0') || !nearby(src,npc)) return emitNet('fivemai:error',src,'PNJ inaccessible ou requête invalide.');
  if (active.size>=8 || active.has(src) || Date.now()-(cooldown.get(src)||0)<10000) return emitNet('fivemai:error',src,'Attendez avant de relancer une conversation.');
  const player=identity(src);
  if (!player || !key()) return emitNet('fivemai:error',src,'Identifiant joueur ou clé OpenAI serveur manquante.');
  cooldown.set(src,Date.now());
  const s={npc,player,callId:null,ws:null,timer:null,remembered:new Set()}; active.set(src,s);
  s.timer=setTimeout(()=>void stop(src),config.maxSessionSeconds*1000);
  try {
    const body=new FormData();
    body.set('sdp',new Blob([sdp],{type:'application/sdp'}),'offer.sdp');
    body.set('session',new Blob([JSON.stringify(sessionConfig(config,npc,memory.get(player,npc.id)))],{type:'application/json'}),'session.json');
    const result=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:`Bearer ${key()}`},body,signal:AbortSignal.timeout(20000)});
    if (!result.ok) throw new Error(`OpenAI HTTP ${result.status}`);
    const answer=await result.text();
    const location=result.headers.get('location')||'';
    s.callId=location.split('/').pop();
    if (!/^rtc_[A-Za-z0-9_-]+$/.test(s.callId)) throw new Error('Identifiant appel OpenAI absent');
    if (active.get(src)!==s) {
      await fetch(`https://api.openai.com/v1/realtime/calls/${s.callId}/hangup`,{method:'POST',headers:{Authorization:`Bearer ${key()}`},signal:AbortSignal.timeout(10000)});
      return;
    }
    // Sideband: memory tool calls are processed on the authenticated server connection.
    s.ws=new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(s.callId)}`,{headers:{Authorization:`Bearer ${key()}`},handshakeTimeout:10000});
    await new Promise((resolve,reject)=>{s.ws.once('open',resolve);s.ws.once('error',reject);});
    s.ws.on('error',()=>{emitNet('fivemai:error',src,'Connexion mémoire interrompue.');void stop(src);});
    s.ws.on('close',()=>{if(active.get(src)===s) void stop(src);});
    if (active.get(src)!==s) { s.ws.close(); return; }
    s.ws.on('message',raw=>{
      try {
        const e=JSON.parse(raw);
        if(e.type!=='response.function_call_arguments.done' || e.name!=='remember_memory') return;
        if(s.remembered.has(e.call_id)) return;
        s.remembered.add(e.call_id);
        if(s.remembered.size>20) throw new Error('Memory limit');
        const args=JSON.parse(e.arguments);
        memory.add(player,npc.id,'conversation',args.memory);
        s.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'function_call_output',call_id:e.call_id,output:JSON.stringify({saved:true})}}));
        s.ws.send(JSON.stringify({type:'response.create'}));
      } catch { console.warn('[fivemai] Échec de sauvegarde ou événement mémoire invalide.'); }
    });
    emitNet('fivemai:answer',src,answer);
  } catch(e) {
    console.warn(`[fivemai] ${e.message}`);
    emitNet('fivemai:error',src,'Connexion OpenAI impossible. Consultez la console serveur.');
    await stop(src);
  }
});
onNet('fivemai:stop',()=>void stop(Number(global.source)));
on('playerDropped',()=>{const src=Number(global.source);void stop(src);cooldown.delete(src);});
setInterval(()=>{for(const [src,s] of active) if(!nearby(src,s.npc)) void stop(src);},1000);
// Server-only export. Trusted gameplay scripts choose actual witnesses.
exports('RecordEvent',(playerSource,event)=>{
  const src=Number(playerSource), player=identity(src);
  if(!player || !event || typeof event.description!=='string' || !Array.isArray(event.witnesses)) return false;
  for(const npcId of new Set(event.witnesses)) {
    const npc=config.npcs.find(n=>n.id===npcId); if(!npc) continue;
    memory.add(player,npcId,'game_event',event.description);
    const s=active.get(src);
    if(s?.npc.id===npcId && s.ws?.readyState===WebSocket.OPEN) s.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'system',content:[{type:'input_text',text:`Observation fournie par le serveur: ${event.description}`} ]}}));
  }
  return true;
});
on('onResourceStop',name=>{if(name===GetCurrentResourceName()) for(const src of active.keys()) void stop(src);});
