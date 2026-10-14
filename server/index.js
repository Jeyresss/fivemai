const fs=require('node:fs');
const path=require('node:path');
const root=GetResourcePath(GetCurrentResourceName());
// FiveM evaluates scripts with a synthetic module at the resource root.
const resourceRequire=require('node:module').createRequire(path.join(root,'package.json'));
const WebSocket=resourceRequire('ws');
const {backupData,MemoryStore,sessionConfig,distance,openAIError,modelHash,errorMessage,behaviorInstructions,validBehavior,validBehaviorCause}=resourceRequire('./server/core.js');
const {JobRegistry,MechanicJob,ToolTurnCoordinator,selectVehicle}=resourceRequire('./server/jobs.js');
const {enrichFixed}=resourceRequire('./server/archetypes.js');
const {validReaction,reactionResponse}=resourceRequire('./server/reactions.js');
const {NPCActionManager}=resourceRequire('./server/actions.js');
const {ProfileStore}=resourceRequire('./server/profiles.js');
const {PersistentDatabase}=resourceRequire('./server/database.js');
const {SharedVoiceRelay}=resourceRequire('./server/voice.js');
const {OpenAIRealtimeProvider,ProviderRegistry}=resourceRequire('./server/provider.js');
const {RequestLimiter,VoiceBudget,safeArguments,finitePosition}=resourceRequire('./server/security.js');
const {createCityRuntime}=resourceRequire('./server/runtime.js');
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
// Overrides are server-only and never exposed in the NUI resource files.
const overrideFile=path.join(root,'config.local.json');
if(fs.existsSync(overrideFile))Object.assign(config,JSON.parse(fs.readFileSync(overrideFile,'utf8')));
config.interactionDistance=Number(config.interactionDistance)||4;
config.maxSessionSeconds=Math.max(10,Math.min(600,Number(config.maxSessionSeconds)||180));
const db=new PersistentDatabase(path.join(root,'data','fivemai.sqlite'),{legacyProfiles:path.join(root,'data','profiles.json'),legacyMemory:path.join(root,'data','memory.json'),...(config.storage||{})});
const limiter=new RequestLimiter(),budget=new VoiceBudget({db,config:config.voiceBudget});
const serviceSessions=new Map();
function gameplaySession(src){return active.get(src)||serviceSessions.get(src);}

for(const file of ['profiles.json','memory.json'])backupData(path.join(root,'data',file));
const memory=new MemoryStore(path.join(root,'data','memory.json'),{db});
const profiles=new ProfileStore(path.join(root,'data','profiles.json'),{db,jobs:config.jobs,maxProfiles:config.maxProfiles,archetypes:config.archetypes,voices:config.voices,sexOverrides:config.sexOverrides});
const autoCooldown=new Map(),demoPeds=new Map();
const bindings=new Map(), npcLocks=new Map(), active=new Map(), cooldown=new Map(), resolveCooldown=new Map();
const key=()=>GetConvar('fivemai_openai_key','');
const providers=new ProviderRegistry(new OpenAIRealtimeProvider({key,WebSocket,fetchImpl:(...args)=>fetch(...args),model:config.model}));
exports('RegisterVoiceProvider',provider=>{providers.register(provider);return true;});
const sharedVoice=new SharedVoiceRelay({getPlayers,position,nearby,emit:(event,src,data)=>emitNet(event,src,data),fullDistance:config.voiceFullDistance||3,maxDistance:config.voiceMaxDistance||18,maxListeners:config.voiceRelay?.maxListeners||64,ownerValid:(src,npc,token)=>active.get(Number(src))?.voiceToken===token});
onNet('fivemai:voiceFrame',data=>sharedVoice.acceptFrame(Number(global.source),data));
function identity(src) { return getPlayerIdentifiers(String(src)).find(x=>x.startsWith('license:')); }
const jobs=new JobRegistry(),pendingJobs=new Map();
function inspectVehicle(ctx,selection={}){
  if(ctx.session.actionState)throw new Error('Terminez l’action du PNJ avant une intervention');
  if(ctx.session.behavior&&ctx.session.behavior!=='calm')throw new Error('Ce PNJ fuit ou se bat et ne peut pas effectuer un service');
  if(gameplaySession(ctx.src)!==ctx.session||!nearby(ctx.src,ctx.session.npc,15))throw new Error('Restez près du mécanicien');
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
function inspectAction(ctx,action,args){
 if(gameplaySession(ctx.src)!==ctx.session||!nearby(ctx.src,ctx.session.npc,10))throw new Error('Restez près de ce PNJ');
 if([...pendingJobs.values()].some(p=>p.ctx.session===ctx.session))throw new Error('Une intervention métier est en cours');
 const o=ctx.session.observation||{};
 if(action==='hands_up')return {aimed:o.aimed===true,armed:o.armed===true,at:o.at||0};
 if(action==='go_to'){if(!Object.hasOwn(config.destinations||{},args.destination))throw new Error('Destination configurée requise');return {destination:config.destinations[args.destination]};}
 if(!['approach_vehicle','enter_vehicle','drive'].includes(action))return {};
 if(action==='drive'&&!Object.hasOwn(config.destinations||{},args.destination))throw new Error('Destinations disponibles: '+Object.keys(config.destinations||{}).join(', '));
 const npcPos=position(ctx.session.npc),bucket=GetPlayerRoutingBucket(String(ctx.src));
 const candidates=[];
 for(const entity of GetAllVehicles()){
  if(!DoesEntityExist(entity)||GetEntityRoutingBucket(entity)!==bucket)continue;
  const [x,y,z]=GetEntityCoords(entity),d=distance(npcPos,{x,y,z});if(d>10)continue;
  const netId=NetworkGetNetworkIdFromEntity(entity);if(!netId)continue;
  candidates.push({netId,plate:GetVehicleNumberPlateText(entity).trim(),distance:d});
 }
 const vehicle=selectVehicle(candidates,{plate:args.plate});
 return vehicle.needsPlate?vehicle:{vehicleNetId:vehicle.netId,plate:vehicle.plate,...(action==='drive'?{destination:config.destinations[args.destination]}:{})};
}
const actions=new NPCActionManager({config:config.actions,now:()=>Date.now(),inspect:inspectAction,send:(src,event,data)=>emitNet(event,src,data),changed:s=>pushBehavior(s),remember:(ctx,text)=>memory.add(ctx.session.player,ctx.session.npc.id,'action',text)});
function sessionTools(npc){return [...actions.tools(npc.jobId).filter(tool=>tool.name!=='driver_trip'),...jobs.tools(npc.jobId),...(city?.missions.tools(npc.id)||[])];}
onNet('fivemai:actionResult',(token,ok,reason)=>{
 const src=Number(global.source),s=gameplaySession(src)||city?.gameplayFor?.(src,token);if(!s)return;
 if(ok===true&&!nearby(src,s.npc,35))return actions.result(src,token,false,'distance');
 actions.result(src,token,ok===true,reason);
});
onNet('fivemai:actionEnded',(token,reason)=>{
 const actor=Number(global.source);if(city?.actionFinished?.(actor,token,reason))return;
 const src=Number(global.source),s=gameplaySession(src),running=s&&actions.running.get(s);
 if(!running||running.token!==token)return;
 let text='L’action du PNJ est terminée ou interrompue.';
 if(running.action==='drive'&&reason==='arrived'){
  const coords=position(s.npc),destination=running.observed.destination;
  if(coords&&distance(coords,destination)<=15){text=`Le chauffeur est arrivé à ${destination.label}.`;memory.add(s.player,s.npc.id,'service',text);}
 }
 if(!actions.ended(src,token,reason))return;
 if(s.ws?.readyState===WebSocket.OPEN)s.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'system',content:[{type:'input_text',text}]}}));
});
onNet('fivemai:observation',(npcId,o)=>{
 const src=Number(global.source),s=active.get(src);if(!limiter.take(src,'observation',{count:8,windowMs:1000}))return;
 if(!s||s.npc.id!==npcId||!o||!nearby(src,s.npc,35))return;
 s.observation={aimed:o.aimed===true,armed:o.armed===true,hit:o.hit===true,at:Date.now()};
});
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
// The complete job registry is initialized below, after server helpers exist.

exports('RegisterJob',job=>{jobs.register(job);return true;});
onNet('fivemai:jobArrived',(token,success,reason)=>{
 const src=Number(global.source),pending=pendingJobs.get(token);
 if(!pending||pending.ctx.src!==src||pending.stage!=='walking')return;
 if(success!==true){
  const reasons={danger:'Le mécanicien a peur ou se bat; intervention annulée',script:'Erreur de préparation sur le client; consulter F8',control:'Impossible de prendre le contrôle du PNJ ou du véhicule',hood:'Le capot ne peut pas être ouvert sur ce véhicule',moved:'Le véhicule a bougé',path:'Le mécanicien ne peut pas rejoindre le capot'};
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
    emitNet('fivemai:jobApply',src,{token,npcId:ctx.session.npc.id,netId:quote.vehicle.netId,service:quote.service,colour:quote.colour,upgrade:quote.upgrade});
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
  if(!ped||GetEntityHealth(ped)<=0||!coords||(npc.netId&&GetEntityHealth(networkPed(npc.netId))<=0)||GetPlayerRoutingBucket(String(src))!==npcBucket(npc))return false;
  const [x,y,z]=GetEntityCoords(ped);
  return distance({x,y,z},coords)<=limit;
}
function boundProfile(netId){
  const entity=networkPed(netId),binding=bindings.get(netId);
  if(!entity||!binding||binding.entity!==entity||Entity(entity).state.fivemai_profile_id!==binding.id)return null;
  const profile=profiles.get(binding.id)||config.npcs.find(n=>n.id===binding.id);return profile?{...profile,netId}:null;
}
on('entityRemoved',entity=>{city?.population?.entityRemoved(entity);for(const [netId,binding]of bindings)if(binding.entity===entity)bindings.delete(netId);});
function lookup(id){
  const fixed=config.npcs.find(n=>n.id===id);if(fixed){const demo=demoPeds.get(id);return {...(profiles.get(id)||enrichFixed(fixed,config)),...(demo&&DoesEntityExist(demo.entity)?{netId:demo.netId}:{})};}
  for(const netId of bindings.keys()){const npc=boundProfile(netId);if(npc?.id===id)return npc;}
  return null;
}
let city;
function spawnDemos(){
 if(!config.demoNetwork||typeof CreatePed!=='function')return;
 for(const npc of config.npcs){
  const old=demoPeds.get(npc.id);if(old&&DoesEntityExist(old.entity))continue;
  const c=npc.coords,entity=CreatePed(4,modelHash(npc.model),c.x,c.y,c.z,c.heading,true,true);
  if(!entity)continue;
  if(typeof SetEntityOrphanMode==='function')SetEntityOrphanMode(entity,2);
  const netId=NetworkGetNetworkIdFromEntity(entity);if(!netId){if(typeof DeleteEntity==='function')DeleteEntity(entity);continue;}
  demoPeds.set(npc.id,{entity,netId});bindings.set(netId,{id:npc.id,entity});Entity(entity).state.set('fivemai_profile_id',npc.id,true);
 }
}
onNet('fivemai:demoRequest',()=>{
 if(!limiter.take(Number(global.source),'demoRequest',{count:2,windowMs:10000}))return;
 spawnDemos();emitNet('fivemai:demos',Number(global.source),Object.fromEntries([...demoPeds].map(([id,ped])=>[id,ped.netId])));
});
for(const npc of config.npcs){if(profiles.upsertFixed)profiles.upsertFixed(npc);}
city=createCityRuntime({db,config,profiles,memory,jobs,actions,active,serviceSessions,npcLocks,identity,lookup,position,npcBucket,nearby,inspectVehicle,inspectAction,applyVehicle:mechanic.apply,finishJob,pendingJobs,limiter,emit:(event,src,data)=>emitNet(event,src,data),onNet,on,exports,getPlayers,bindProfile,game:{CreatePed:typeof CreatePed==='function'?CreatePed:null,SetEntityRoutingBucket:typeof SetEntityRoutingBucket==='function'?SetEntityRoutingBucket:null,GetPlayerPed,GetEntityCoords,GetPlayerRoutingBucket,GetEntityRoutingBucket,DoesEntityExist,GetEntityHealth,NetworkGetEntityFromNetworkId,GetEntityModel,GetAllVehicles,NetworkGetNetworkIdFromEntity,GetVehicleNumberPlateText,GetEntityType,Entity,CreateVehicle:typeof CreateVehicle==='function'?CreateVehicle:null,SetEntityOrphanMode:typeof SetEntityOrphanMode==='function'?SetEntityOrphanMode:null,DeleteEntity:typeof DeleteEntity==='function'?DeleteEntity:null,GetPedInVehicleSeat:typeof GetPedInVehicleSeat==='function'?GetPedInVehicleSeat:null,GetVehicleEngineHealth:typeof GetVehicleEngineHealth==='function'?GetVehicleEngineHealth:null,GetVehicleBodyHealth:typeof GetVehicleBodyHealth==='function'?GetVehicleBodyHealth:null,GetEntitySpeed:typeof GetEntitySpeed==='function'?GetEntitySpeed:null,GetVehiclePedIsIn:typeof GetVehiclePedIsIn==='function'?GetVehiclePedIsIn:null,SetEntityCoords:typeof SetEntityCoords==='function'?SetEntityCoords:null,RegisterCommand:typeof RegisterCommand==='function'?RegisterCommand:null,SetEntityHealth:typeof SetEntityHealth==='function'?SetEntityHealth:null,GetPlayerName:typeof GetPlayerName==='function'?GetPlayerName:null}});
spawnDemos();
onNet('fivemai:resolve',target=>{
  const src=Number(global.source),requestId=target?.requestId;
  const reply=result=>emitNet('fivemai:resolved',src,{requestId,...result});
  if(Date.now()-(resolveCooldown.get(src)||0)<500)return reply({ok:false,retryable:true,error:'Résolution trop rapprochée'});
  resolveCooldown.set(src,Date.now());
  let stage='validation de la cible';
  try{
    let npc;
    if(target && typeof target.id==='string')npc=lookup(target.id);
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
        const profile=profiles.create(model,job?.id,target.sex);
        stage='association du profil au PNJ';
        bindings.set(target.netId,{id:profile.id,entity});Entity(entity).state.set('fivemai_profile_id',profile.id,true);
        npc={...profile,netId:target.netId};city?.registerAmbient?.(profile,{x,y,z},{netId:target.netId,entity,bucket:GetEntityRoutingBucket(entity),owned:false});
      }
    }
    if(npc?.netId&&profiles.get(npc.id)&&profiles.ensureAppearance)npc={...profiles.ensureAppearance(npc.id,target.sex),netId:npc.netId};
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
function bindProfile(netId,profileId){
  const entity=networkPed(netId);if(!entity||!profiles.get(profileId))return false;
  for(const [other,binding]of bindings)if(other!==netId&&binding.id===profileId)bindings.delete(other);
  bindings.set(netId,{id:profileId,entity});Entity(entity).state.set('fivemai_profile_id',profileId,true);return true;
}
exports('BindNPCProfile',bindProfile);
exports('GetNPCProfile',profileId=>{const npc=profiles.get(profileId)||lookup(profileId);return npc?JSON.parse(JSON.stringify(npc)):null;});
exports('AssignNPCJob',(profileId,jobId)=>{
  const job=config.jobs?.find(j=>j.id===jobId)||jobs.jobs.get(jobId);
  if(!job||npcLocks.has(profileId)||!profiles.get(profileId))return false;
  profiles.assignJob(profileId,jobId,job.label);return true;
});
async function stop(src,reason='voice_closed',expectedSession) {
  const s=active.get(src)||serviceSessions.get(src); if (!s||(expectedSession!==undefined&&s.uiSession!==expectedSession)) return;
  const force=['disconnect','bucket','gone','resource'].includes(reason);
  const busy=actions.running.has(s)||[...actions.pending.values()].some(p=>p.ctx.session===s)||[...pendingJobs.values()].some(p=>p.ctx.session===s);
  if(busy&&!force)serviceSessions.set(src,s);else serviceSessions.delete(src);
  for(const [token,pending]of pendingJobs)if(force&&pending.ctx.src===src)finishJob(token,{ok:false,error:'Conversation terminée'});
  if(force||!busy){actions.stop(s);city?.forget(s);}active.delete(src);if((force||!busy)&&!city?.ownsGameplayLock?.(s.npc.id)&&npcLocks.get(s.npc.id)===src)npcLocks.delete(s.npc.id);clearTimeout(s.timer);sharedVoice.remove(s.voiceToken);budget.finish(s.budgetReservation);s.ws?.close();
  emitNet('fivemai:closed',src,{sessionId:s.uiSession,reason,gameplayContinues:busy&&!force});
  if (s.callId) {
    try { await (s.provider||providers.get()).close(s.callId); }
    catch { console.warn('[fivemai] Impossible de confirmer la fermeture OpenAI.'); }
  }
}
function sessionInstructions(s){const relation=memory.relation?.(s.player,s.npc.id)||{};return `${s.policeSpeech||''} Relation validée: ${JSON.stringify(relation)}. Mission active: ${JSON.stringify(city?.missions.status?.(s.player)||{})}. `+ `Action réelle en cours: ${s.actionState||'aucune'}. Destinations chauffeur autorisées: ${JSON.stringify(config.destinations||{})}. `+sessionConfig(config,s.npc,[...memory.get('world',s.npc.id).slice(-10),...(city?.publicMemory?.(s.npc.id)||[]),...memory.get(s.player,s.npc.id).slice(-20)],sessionTools(s.npc),s.behavior,s.behaviorCause).instructions;}
function maybeEmotionalReply(src,s){
 if(active.get(src)!==s||(!s.emotionReplyPending&&!s.pendingReaction)||s.voiceReady===false||s.awaitingBehaviorUpdate||s.responseActive||s.outputPlaying||s.playerSpeaking||s.toolTurn?.pending||s.toolTurn?.outputs||s.ws?.readyState!==WebSocket.OPEN)return;
 const reaction=s.pendingReaction;s.pendingReaction=null;s.emotionReplyPending=false;s.responseActive=true;
 s.ws.send(JSON.stringify(reaction?reactionResponse(sessionInstructions(s),reaction):{type:'response.create'}));
}
function pushBehavior(s){
 if(s.ws?.readyState!==WebSocket.OPEN)return;
 s.awaitingBehaviorUpdate=true;
 s.ws.send(JSON.stringify({type:'session.update',session:{type:'realtime',instructions:sessionInstructions(s)}}));
}
onNet('fivemai:speaking',speaking=>{
 if(!limiter.take(Number(global.source),'speaking',{count:12,windowMs:1000}))return;
 const s=active.get(Number(global.source));if(!s)return;
 s.playerSpeaking=speaking===true;s.lastActivity=Date.now();if(s.playerSpeaking)s.automatic=false;if(s.playerSpeaking){s.emotionReplyPending=false;s.pendingReaction=null;}
});
onNet('fivemai:behavior',(npcId,state,speaking,cause='none')=>{
 const src=Number(global.source),s=active.get(src);
 if(!limiter.take(src,'behavior',{count:6,windowMs:1000}))return;
 if(!s||s.npc.id!==npcId||!validBehavior(state)||!validBehaviorCause(cause)||!nearby(src,s.npc,50)||(s.behavior===state&&(s.behaviorCause||'none')===cause))return;
 s.behavior=state;s.behaviorCause=cause;s.playerSpeaking=speaking===true;
 if(s.playerSpeaking)s.pendingReaction=null;
 if(state!=='calm')for(const [token,pending]of pendingJobs)if(pending.ctx.src===src)finishJob(token,{ok:false,error:'Le PNJ a peur ou se bat; intervention annulée'});
 if(state==='calm')s.emotionReplyPending=false;
 if(s.ws?.readyState!==WebSocket.OPEN)return;
 pushBehavior(s);
 if(state!=='calm'&&!s.playerSpeaking&&(s.responseActive||s.outputPlaying)){
  s.emotionReplyPending=true;
  if(s.responseActive)s.ws.send(JSON.stringify({type:'response.cancel'}));
  if(s.outputPlaying)s.ws.send(JSON.stringify({type:'output_audio_buffer.clear'}));
 }
});
onNet('fivemai:voiceReady',(npcId,uiSession)=>{
 const src=Number(global.source),s=active.get(src);if(!s||s.npc.id!==npcId||(uiSession!==undefined&&s.uiSession!==uiSession))return;
 s.voiceReady=true;maybeEmotionalReply(src,s);
});
onNet('fivemai:react',(npcId,kind)=>{
 const src=Number(global.source),s=active.get(src);
 if(config.reactions?.enabled===false||!s||s.npc.id!==npcId||!validReaction(kind)||kind==='police'||!nearby(src,s.npc,config.voiceMaxDistance||18)||s.playerSpeaking)return;
 if(Date.now()-(s.lastReactionAt||0)<(config.reactions?.cooldownSeconds||8)*1000)return;
 const allowed=kind==='aim'?s.observation?.aimed===true&&Date.now()-s.observation.at<2000:kind==='hit'?(s.behaviorCause==='hit'||s.observation?.hit===true&&Date.now()-s.observation.at<2000):kind==='flee'?['afraid','afraid_player'].includes(s.behavior):['angry','combat'].includes(s.behavior);
 if(!allowed)return;
 s.lastReactionAt=Date.now();s.lastActivity=Date.now();s.pendingReaction=kind;
 maybeEmotionalReply(src,s);
});
onNet('fivemai:offer',async (npcId,sdp,behavior='calm',speaking=false,cause='none',observation={})=>{
  const src=Number(global.source);
  const replyError=message=>emitNet('fivemai:error',src,{message,sessionId:observation?.sessionId});
  if(!limiter.take(src,'offer',{count:2,windowMs:10000}))return emitNet('fivemai:error',src,{message:'Attendez avant de relancer une conversation.',sessionId:observation?.sessionId});
  let npc=lookup(npcId);
  if(npc?.netId&&observation?.netId&&npc.netId!==observation.netId)return replyError('Identité réseau du PNJ incorrecte.');
  const fixed=config.npcs.find(n=>n.id===npcId);
  if(npc&&fixed)npc={...(profiles.get(npcId)||enrichFixed(fixed,config,observation?.sex)),...(npc.netId?{netId:npc.netId}:{})};
  if(npc&&!npc.netId&&observation?.netId){
   const entity=networkPed(observation.netId);
   if(!entity||GetEntityModel(entity)>>>0!==modelHash(npc.model)||GetEntityRoutingBucket(entity)!==GetPlayerRoutingBucket(String(src)))return replyError('PNJ de démonstration pas encore synchronisé. Réessayez.');
   const [x,y,z]=GetEntityCoords(entity);
   if(bindings.get(observation.netId)?.id!==npc.id&&distance({x,y,z},npc.coords)>config.interactionDistance+1)return replyError('PNJ de démonstration invalide.');
   bindings.set(observation.netId,{id:npc.id,entity});Entity(entity).state.set('fivemai_profile_id',npc.id,true);npc={...npc,netId:observation.netId};
  }
  const automatic=observation?.automatic===true;
  const policeSpeech=automatic&&observation.reaction==='police'?city?.consumeSpeechRequest?.(src,npcId,observation.speechToken):null;
  if(observation?.reaction==='police'&&!policeSpeech)return emitNet('fivemai:error',src,{message:'Demande vocale policière non autorisée.',sessionId:observation?.sessionId});
  if(automatic&&(config.reactions?.enabled===false||!validReaction(observation.reaction)))return replyError('Réaction automatique invalide.');
  if (!npc || typeof sdp!=='string' || sdp.length>40000 || !sdp.startsWith('v=0') || !nearby(src,npc)) return replyError('PNJ inaccessible ou requête invalide.');
  if(npcLocks.has(npc.id)&&!(policeSpeech&&npcLocks.get(npc.id)===src))return replyError('Ce PNJ est déjà en conversation.');
  if (active.size>=(config.maxConcurrentSessions||8) || active.has(src) || serviceSessions.has(src) || (automatic?Date.now()-(autoCooldown.get(src)||0)<(config.reactions?.autoCooldownSeconds||15)*1000:Date.now()-(cooldown.get(src)||0)<10000)) return replyError('Attendez avant de relancer une conversation.');
  const player=identity(src);
  if (!player || !providers.get(config.voiceProvider||'openai').available()) return replyError('Identifiant joueur ou clé OpenAI serveur manquante.');
  (automatic?autoCooldown:cooldown).set(src,Date.now());
  const initialBehavior=validBehavior(behavior)?behavior:'calm';
  let reservation;try{reservation=budget.reserve(config.maxSessionSeconds);}catch(e){return emitNet('fivemai:error',src,{message:errorMessage(e),sessionId:observation?.sessionId});}
  const s={src,uiSession:observation?.sessionId,budgetReservation:reservation,provider:providers.get(config.voiceProvider||'openai'),npc,player,behavior:initialBehavior,behaviorCause:validBehaviorCause(cause)?cause:'none',playerSpeaking:speaking===true,responseActive:false,outputPlaying:false,emotionReplyPending:false,awaitingBehaviorUpdate:false,callId:null,ws:null,timer:null,remembered:new Set(),automatic,voiceReady:false,lastActivity:Date.now(),pendingReaction:automatic?observation.reaction:null,lastReactionAt:automatic?Date.now():0,observation:{aimed:observation?.aimed===true,armed:observation?.armed===true,hit:observation?.hit===true,at:Date.now()}}; active.set(src,s);npcLocks.set(npc.id,src);city?.routineCancel?.(npc.id);
  if(policeSpeech)s.policeSpeech=policeSpeech.description;
  s.timer=setTimeout(()=>void stop(src),config.maxSessionSeconds*1000);
  try {
    const realtimeConfig=sessionConfig(config,npc,[...memory.get('world',npc.id).slice(-10),...memory.get(player,npc.id).slice(-20)],sessionTools(npc),s.behavior,s.behaviorCause);
    realtimeConfig.instructions=sessionInstructions(s);realtimeConfig.max_output_tokens=config.maxOutputTokens||1024;
    const {answer,callId}=await s.provider.open(sdp,realtimeConfig);s.callId=callId;
    if(active.get(src)!==s){await s.provider.close(s.callId);return;}
    s.ws=s.provider.socket(s.callId);
    await new Promise((resolve,reject)=>{s.ws.once('open',resolve);s.ws.once('error',reject);});
    s.ws.on('error',()=>{if(active.get(src)!==s)return;emitNet('fivemai:error',src,{message:'Connexion mémoire interrompue.',sessionId:s.uiSession});void stop(src,'voice_closed',s.uiSession);});
    s.ws.on('close',()=>{if(active.get(src)===s) void stop(src);});
    if (active.get(src)!==s) { s.ws.close(); return; }
    const toolTurn=new ToolTurnCoordinator(()=>{if(active.get(src)===s&&s.ws.readyState===WebSocket.OPEN){s.emotionReplyPending=false;s.responseActive=true;s.ws.send(JSON.stringify({type:'response.create'}));}});
    s.toolTurn=toolTurn;
    s.ws.on('message',async raw=>{
      let event;
      try{
        event=JSON.parse(raw);
        if(event.type==='response.created'){s.responseActive=true;toolTurn.created();return;}
        if(event.type==='session.updated'){s.awaitingBehaviorUpdate=false;maybeEmotionalReply(src,s);return;}
        if(event.type==='output_audio_buffer.started'){s.outputPlaying=true;return;}
        if(event.type==='output_audio_buffer.stopped'||event.type==='output_audio_buffer.cleared'){if(event.type==='output_audio_buffer.cleared')sharedVoice.clear(s.voiceToken);s.outputPlaying=false;maybeEmotionalReply(src,s);return;}
        if(event.type==='response.done'){s.responseActive=false;toolTurn.done();maybeEmotionalReply(src,s);return;}
        if(event.type!=='response.function_call_arguments.done'||s.remembered.has(event.call_id))return;
        s.remembered.add(event.call_id);toolTurn.begin();
        let output;
        try{
          if(s.remembered.size>(config.maxToolsPerSession||60))throw new Error('Limite d’outils atteinte pour cette session');
          if(s.automatic&&event.name!=='remember_memory')throw new Error('Une réaction spontanée ne peut déclencher un service');
          const args=safeArguments(event.arguments);
          if(event.name==='remember_memory'){
            memory.add(player,npc.id,'conversation',args.memory,{provenance:args.provenance||'player_declaration',source:'conversation'});output={saved:true};
          }else if(event.name.startsWith('mission_')){
            output=await city.missions.execute(event.name,{src,player,session:s},args);
          }else if(event.name==='npc_action'){
            output=await actions.execute(event.name,{src,session:s},args);
          }else{
            output=await jobs.execute(npc.jobId,event.name,{src,session:s},args);
          }
        }catch(e){output={ok:false,error:e.message};}
        if(active.get(src)!==s||s.ws.readyState!==WebSocket.OPEN)return;
        s.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'function_call_output',call_id:event.call_id,output:JSON.stringify(output)}}));
        toolTurn.complete();
      }catch{console.warn('[fivemai] Événement outil illisible.');}
    });
    if(s.behavior!==initialBehavior||s.behaviorCause!==cause)pushBehavior(s);
    s.voiceToken=sharedVoice.add(src,npc);emitNet('fivemai:voiceOwner',src,{token:s.voiceToken,npcId:npc.id,sessionId:s.uiSession});
    emitNet('fivemai:answer',src,{sdp:answer,sessionId:s.uiSession});
  } catch(e) {
    console.warn(`[fivemai] ${e.message}`);
    if(active.get(src)===s){emitNet('fivemai:error',src,{message:'Connexion OpenAI impossible. Consultez la console serveur.',sessionId:s.uiSession});await stop(src,'voice_closed',s.uiSession);}
  }
});
onNet('fivemai:stop',uiSession=>void stop(Number(global.source),'voice_closed',uiSession));
on('playerDropped',()=>{const src=Number(global.source);void stop(src,'disconnect');city?.disconnect(src);limiter.forget(src);cooldown.delete(src);autoCooldown.delete(src);resolveCooldown.delete(src);});
// Hearing range controls client volume, not the lifetime of the current reply.
setInterval(()=>{for(const [src,s] of active){
  const coords=position(s.npc);
  if(s.automatic&&!s.playerSpeaking&&!s.responseActive&&!s.outputPlaying&&!s.actionState&&Date.now()-s.lastActivity>(config.reactions?.idleSeconds||30)*1000){void stop(src);continue;}
  if(!GetPlayerPed(String(src)) || !coords || GetPlayerRoutingBucket(String(src))!==npcBucket(s.npc))void stop(src,!coords?'gone':'bucket');
  else if(s.npc.netId)emitNet('fivemai:position',src,coords);
}sharedVoice.tick();city?.tick();},1000);
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
on('onResourceStop',name=>{if(name!==GetCurrentResourceName())return;for(const src of new Set([...active.keys(),...serviceSessions.keys()]))void stop(src,'resource');city?.stop();setTimeout(()=>{try{db.close();}catch(e){console.warn(errorMessage(e));}},0);for(const {entity}of demoPeds.values())if(DoesEntityExist(entity)&&typeof DeleteEntity==='function')DeleteEntity(entity);});

exports('RecordNPCEvent',(npcId,description)=>{
 if(!lookup(npcId)&&!profiles.get(npcId))return false;
 memory.add('world',npcId,'observation',description);city?.simulation.recordPublicEvent?.({id:require('node:crypto').randomUUID(),visibility:'public',source:'server_public',description:description.slice(0,600),witnesses:[npcId]});
 for(const s of active.values())if(s.npc.id===npcId&&s.ws?.readyState===WebSocket.OPEN)s.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'system',content:[{type:'input_text',text:`Observation publique fournie par le serveur: ${description}`}]}}));
 return true;
});

console.log('[fivemai] Serveur prêt — résolution des profils v2.');
console.log(`[fivemai] Version living-city-1 chargée depuis ${root}`);
