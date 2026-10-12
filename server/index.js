const fs=require('node:fs');
const path=require('node:path');
const root=GetResourcePath(GetCurrentResourceName());
// FiveM evaluates scripts with a synthetic module at the resource root.
const resourceRequire=require('node:module').createRequire(path.join(root,'package.json'));
const WebSocket=resourceRequire('ws');
const {MemoryStore,sessionConfig,distance,openAIError,modelHash,errorMessage}=resourceRequire('./server/core.js');
const {JobRegistry,MechanicJob,ToolTurnCoordinator,selectVehicle}=resourceRequire('./server/jobs.js');
const {ProfileStore}=resourceRequire('./server/profiles.js');
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
const memory=new MemoryStore(path.join(root,'data','memory.json'));
const profiles=new ProfileStore(path.join(root,'data','profiles.json'),{jobs:config.jobs,maxProfiles:config.maxProfiles});
const bindings=new Map(), npcLocks=new Map(), active=new Map(), cooldown=new Map(), resolveCooldown=new Map();
const key=()=>GetConvar('fivemai_openai_key','');
function identity(src) { return getPlayerIdentifiers(String(src)).find(x=>x.startsWith('license:')); }
const jobs=new JobRegistry(),pendingJobs=new Map();
function inspectVehicle(ctx,selection={}){
  if(active.get(ctx.src)!==ctx.session||!nearby(ctx.src,ctx.session.npc,15))throw new Error('Restez près du mécanicien');
  const npcPos=position(ctx.session.npc),playerPed=GetPlayerPed(String(ctx.src));
  const [px,py,pz]=GetEntityCoords(playerPed),bucket=GetPlayerRoutingBucket(String(ctx.src));
  const candidates=[];
  for(const vehicle of GetAllVehicles()){
    if(!DoesEntityExist(vehicle)||GetEntityRoutingBucket(vehicle)!==bucket)continue;
    const [x,y,z]=GetEntityCoords(vehicle),coords={x,y,z};
    const d=distance(coords,npcPos);
    if(d>10||distance(coords,{x:px,y:py,z:pz})>12)continue;
    const netId=NetworkGetNetworkIdFromEntity(vehicle);if(!netId)continue;
    candidates.push({entity:vehicle,model:GetEntityModel(vehicle),netId,plate:GetVehicleNumberPlateText(vehicle).trim(),distance:d});
  }
  return selectVehicle(candidates,selection);
}
function finishJob(token,result){
  const pending=pendingJobs.get(token);if(!pending)return;
  pendingJobs.delete(token);clearTimeout(pending.timer);
  if(!result.ok)console.warn(`[fivemai] Intervention mécanicien interrompue: ${result.error}`);
  emitNet('fivemai:jobEnd',pending.ctx.src,{token});pending.resolve(result);
}
const mechanic=new MechanicJob({inspect:inspectVehicle,
 apply:(ctx,quote)=>new Promise(resolve=>{
  const token=require('node:crypto').randomUUID();
  const pending={ctx,quote,resolve,timer:null,stage:'walking'};pendingJobs.set(token,pending);
  pending.timer=setTimeout(()=>finishJob(token,{ok:false,error:'Le mécanicien n’a pas atteint le capot'}),20000);
  emitNet('fivemai:jobStart',ctx.src,{token,netId:quote.vehicle.netId,npcId:ctx.session.npc.id,npcNetId:ctx.session.npc.netId,service:quote.service,plate:quote.vehicle.plate});
 }),remember:(ctx,text)=>memory.add(ctx.session.player,ctx.session.npc.id,'service',text)});
jobs.register(mechanic);
exports('RegisterJob',job=>{jobs.register(job);return true;});
onNet('fivemai:jobArrived',(token,success,reason)=>{
 const src=Number(global.source),pending=pendingJobs.get(token);
 if(!pending||pending.ctx.src!==src||pending.stage!=='walking')return;
 if(success!==true){
  const reasons={script:'Erreur de préparation sur le client; consulter F8',control:'Impossible de prendre le contrôle du PNJ ou du véhicule',hood:'Le capot ne peut pas être ouvert sur ce véhicule',moved:'Le véhicule a bougé',path:'Le mécanicien ne peut pas rejoindre le capot'};
  return finishJob(token,{ok:false,error:reasons[reason]||'Le mécanicien ne peut pas rejoindre le capot ou le véhicule a bougé'});
 }
 try{
  if(inspectVehicle(pending.ctx,{selected:pending.quote.vehicle}).netId!==pending.quote.vehicle.netId)throw new Error('Véhicule changé');
  clearTimeout(pending.timer);pending.stage='working';
  console.log('[fivemai] Mécanicien arrivé : début des quatre secondes de travail.');
  pending.timer=setTimeout(()=>{
   try{
    if(inspectVehicle(pending.ctx,{selected:pending.quote.vehicle}).netId!==pending.quote.vehicle.netId)throw new Error('Véhicule changé pendant l’intervention');
    pending.stage='applying';
    pending.timer=setTimeout(()=>finishJob(token,{ok:false,error:'Application du service non confirmée'}),8000);
    const {ctx,quote}=pending;
    emitNet('fivemai:jobApply',src,{token,npcId:ctx.session.npc.id,netId:quote.vehicle.netId,service:quote.service,colour:quote.colour});
   }catch(e){finishJob(token,{ok:false,error:errorMessage(e)});}
  },4000);
 }catch(e){finishJob(token,{ok:false,error:errorMessage(e)});}
});
onNet('fivemai:jobResult',(token,success)=>{
 const src=Number(global.source),pending=pendingJobs.get(token);
 if(!pending||pending.ctx.src!==src||pending.stage!=='applying')return;
 try{
  if(inspectVehicle(pending.ctx,{selected:pending.quote.vehicle}).netId!==pending.quote.vehicle.netId)throw new Error('Véhicule changé');
  finishJob(token,{ok:success===true,error:success===true?undefined:'Le client n’a pas pu appliquer le service'});
 }catch(e){finishJob(token,{ok:false,error:e.message});}
});
function networkPed(netId){
  if(!Number.isInteger(netId)||netId<=0)return 0;
  const entity=NetworkGetEntityFromNetworkId(netId);
  if(!entity||!DoesEntityExist(entity)||GetEntityType(entity)!==1)return 0;
  if(getPlayers().some(id=>GetPlayerPed(String(id))===entity))return 0;
  return entity;
}
function position(npc){
  if(!npc.netId)return npc.coords;
  const entity=networkPed(npc.netId);if(!entity)return null;
  const binding=bindings.get(npc.netId);
  if(!binding || binding.entity!==entity || binding.id!==npc.id || Entity(entity).state.fivemai_profile_id!==npc.id)return null;
  const [x,y,z]=GetEntityCoords(entity);return {x,y,z};
}
function npcBucket(npc){const entity=npc.netId?networkPed(npc.netId):0;return npc.netId?(entity?GetEntityRoutingBucket(entity):-1):0;}
function nearby(src,npc,limit=config.interactionDistance+1) {
  const ped=GetPlayerPed(String(src)),coords=position(npc);
  if(!ped||!coords||GetPlayerRoutingBucket(String(src))!==npcBucket(npc))return false;
  const [x,y,z]=GetEntityCoords(ped);
  return distance({x,y,z},coords)<=limit;
}
function boundProfile(netId){
  const entity=networkPed(netId),binding=bindings.get(netId);
  if(!entity||!binding||binding.entity!==entity||Entity(entity).state.fivemai_profile_id!==binding.id)return null;
  const profile=profiles.get(binding.id);return profile?{...profile,netId}:null;
}
on('entityRemoved',entity=>{for(const [netId,binding]of bindings)if(binding.entity===entity)bindings.delete(netId);});
function lookup(id){
  const fixed=config.npcs.find(n=>n.id===id);if(fixed)return fixed;
  for(const netId of bindings.keys()){const npc=boundProfile(netId);if(npc?.id===id)return npc;}
  return null;
}
onNet('fivemai:resolve',target=>{
  const src=Number(global.source),requestId=target?.requestId;
  const reply=result=>emitNet('fivemai:resolved',src,{requestId,...result});
  if(Date.now()-(resolveCooldown.get(src)||0)<500)return reply({ok:false,retryable:true,error:'Résolution trop rapprochée'});
  resolveCooldown.set(src,Date.now());
  let stage='validation de la cible';
  try{
    let npc;
    if(target && typeof target.id==='string')npc=config.npcs.find(n=>n.id===target.id);
    else if(config.ambientNPCs && target){
      if(!Number.isInteger(target.netId)||target.netId<=0)throw new Error('Identifiant réseau PNJ invalide');
      // A client-side net ID can exist before OneSync exposes the ped on the server.
      if(!NetworkGetEntityFromNetworkId(target.netId))return reply({ok:false,retryable:true,error:'PNJ pas encore synchronisé avec le serveur'});
      stage='validation du PNJ réseau';
      const entity=networkPed(target.netId);
      if(!entity||GetEntityHealth(entity)<=0||GetPlayerRoutingBucket(String(src))!==GetEntityRoutingBucket(entity))throw new Error('PNJ inaccessible');
      const [x,y,z]=GetEntityCoords(entity),[px,py,pz]=GetEntityCoords(GetPlayerPed(String(src)));
      if(distance({x,y,z},{x:px,y:py,z:pz})>config.interactionDistance+1)throw new Error('PNJ trop éloigné');
      stage='lecture du profil';npc=boundProfile(target.netId);
      if(!npc){
        stage='création du profil';const model=GetEntityModel(entity);
        const job=config.jobs?.find(j=>j.models?.some(name=>modelHash(name)===(model>>>0)));
        const profile=profiles.create(model,job?.id);
        stage='association du profil au PNJ';
        bindings.set(target.netId,{id:profile.id,entity});Entity(entity).state.set('fivemai_profile_id',profile.id,true);
        npc={...profile,netId:target.netId};
      }
    }
    stage='validation de proximité';
    if(!npc||!nearby(src,npc))throw new Error('PNJ inaccessible');
    reply({ok:true,profile:{...npc,coords:position(npc)}});
  }catch(e){
    const message=`${stage}: ${errorMessage(e)}`;
    console.warn(`[fivemai] Résolution du profil pour joueur ${src}: ${message}`);
    reply({ok:false,retryable:false,error:message});
  }
});
// Trusted spawn scripts can reattach a saved character after recreating its ped.
exports('BindNPCProfile',(netId,profileId)=>{
  const entity=networkPed(netId);if(!entity||!profiles.get(profileId))return false;
  for(const [other,binding]of bindings)if(other!==netId&&binding.id===profileId)bindings.delete(other);
  bindings.set(netId,{id:profileId,entity});Entity(entity).state.set('fivemai_profile_id',profileId,true);return true;
});
exports('GetNPCProfile',profileId=>{const npc=profiles.get(profileId)||config.npcs.find(n=>n.id===profileId);return npc?JSON.parse(JSON.stringify(npc)):null;});
exports('AssignNPCJob',(profileId,jobId)=>{
  const job=config.jobs?.find(j=>j.id===jobId)||jobs.jobs.get(jobId);
  if(!job||npcLocks.has(profileId)||!profiles.get(profileId))return false;
  profiles.assignJob(profileId,jobId,job.label);return true;
});
async function stop(src) {
  const s=active.get(src); if (!s) return;
  for(const [token,pending]of pendingJobs)if(pending.ctx.src===src)finishJob(token,{ok:false,error:'Conversation terminée'});
  mechanic.forget(s);active.delete(src); if(npcLocks.get(s.npc.id)===src)npcLocks.delete(s.npc.id);clearTimeout(s.timer); s.ws?.close();
  emitNet('fivemai:closed',src);
  if (s.callId) {
    try { await fetch(`https://api.openai.com/v1/realtime/calls/${s.callId}/hangup`,{method:'POST',headers:{Authorization:`Bearer ${key()}`},signal:AbortSignal.timeout(10000)}); }
    catch { console.warn('[fivemai] Impossible de confirmer la fermeture OpenAI.'); }
  }
}
onNet('fivemai:offer',async (npcId,sdp)=>{
  const src=Number(global.source);
  const npc=lookup(npcId);
  if (!npc || typeof sdp!=='string' || sdp.length>40000 || !sdp.startsWith('v=0') || !nearby(src,npc)) return emitNet('fivemai:error',src,'PNJ inaccessible ou requête invalide.');
  if(npcLocks.has(npc.id))return emitNet('fivemai:error',src,'Ce PNJ est déjà en conversation.');
  if (active.size>=8 || active.has(src) || Date.now()-(cooldown.get(src)||0)<10000) return emitNet('fivemai:error',src,'Attendez avant de relancer une conversation.');
  const player=identity(src);
  if (!player || !key()) return emitNet('fivemai:error',src,'Identifiant joueur ou clé OpenAI serveur manquante.');
  cooldown.set(src,Date.now());
  const s={npc,player,callId:null,ws:null,timer:null,remembered:new Set()}; active.set(src,s);npcLocks.set(npc.id,src);
  s.timer=setTimeout(()=>void stop(src),config.maxSessionSeconds*1000);
  try {
    const body=new FormData();
    // The API expects form fields, not uploaded files with filenames.
    body.set('sdp',sdp);
    body.set('session',JSON.stringify(sessionConfig(config,npc,[...memory.get('world',npc.id).slice(-10),...memory.get(player,npc.id).slice(-20)],jobs.tools(npc.jobId))));
    const result=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:`Bearer ${key()}`},body,signal:AbortSignal.timeout(20000)});
    if (!result.ok) throw await openAIError(result,key());
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
    const toolTurn=new ToolTurnCoordinator(()=>{if(active.get(src)===s&&s.ws.readyState===WebSocket.OPEN)s.ws.send(JSON.stringify({type:'response.create'}));});
    s.ws.on('message',async raw=>{
      let event;
      try{
        event=JSON.parse(raw);
        if(event.type==='response.created'){toolTurn.created();return;}
        if(event.type==='response.done'){toolTurn.done();return;}
        if(event.type!=='response.function_call_arguments.done'||s.remembered.has(event.call_id))return;
        s.remembered.add(event.call_id);toolTurn.begin();
        let output;
        try{
          if(s.remembered.size>20)throw new Error('Limite d’outils atteinte pour cette session');
          const args=JSON.parse(event.arguments);
          if(event.name==='remember_memory'){
            memory.add(player,npc.id,'conversation',args.memory);output={saved:true};
          }else{
            output=await jobs.execute(npc.jobId,event.name,{src,session:s},args);
          }
        }catch(e){output={ok:false,error:e.message};}
        if(active.get(src)!==s||s.ws.readyState!==WebSocket.OPEN)return;
        s.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'function_call_output',call_id:event.call_id,output:JSON.stringify(output)}}));
        toolTurn.complete();
      }catch{console.warn('[fivemai] Événement outil illisible.');}
    });
    emitNet('fivemai:answer',src,answer);
  } catch(e) {
    console.warn(`[fivemai] ${e.message}`);
    emitNet('fivemai:error',src,'Connexion OpenAI impossible. Consultez la console serveur.');
    await stop(src);
  }
});
onNet('fivemai:stop',()=>void stop(Number(global.source)));
on('playerDropped',()=>{const src=Number(global.source);void stop(src);cooldown.delete(src);resolveCooldown.delete(src);});
// Hearing range controls client volume, not the lifetime of the current reply.
setInterval(()=>{for(const [src,s] of active){
  const coords=position(s.npc);
  if(!GetPlayerPed(String(src)) || !coords || GetPlayerRoutingBucket(String(src))!==npcBucket(s.npc))void stop(src);
  else if(s.npc.netId)emitNet('fivemai:position',src,coords);
}},1000);
// Server-only export. Trusted gameplay scripts choose actual witnesses.
exports('RecordEvent',(playerSource,event)=>{
  const src=Number(playerSource), player=identity(src);
  if(!player || !event || typeof event.description!=='string' || !Array.isArray(event.witnesses)) return false;
  for(const npcId of new Set(event.witnesses)) {
    const npc=lookup(npcId)||profiles.get(npcId); if(!npc) continue;
    memory.add(player,npcId,'game_event',event.description);
    const s=active.get(src);
    if(s?.npc.id===npcId && s.ws?.readyState===WebSocket.OPEN) s.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'system',content:[{type:'input_text',text:`Observation fournie par le serveur: ${event.description}`} ]}}));
  }
  return true;
});
on('onResourceStop',name=>{if(name===GetCurrentResourceName()) for(const src of active.keys()) void stop(src);});

exports('RecordNPCEvent',(npcId,description)=>{
 if(!lookup(npcId)&&!profiles.get(npcId))return false;
 memory.add('world',npcId,'observation',description);
 for(const s of active.values())if(s.npc.id===npcId&&s.ws?.readyState===WebSocket.OPEN)s.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'system',content:[{type:'input_text',text:`Observation publique fournie par le serveur: ${description}`}]}}));
 return true;
});

console.log('[fivemai] Serveur prêt — résolution des profils v2.');
console.log(`[fivemai] Version npc-capture-2 chargée depuis ${root}`);
