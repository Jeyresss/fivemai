'use strict';
const crypto=require('node:crypto');
const {createServices}=require('./services');
const {MissionEngine}=require('./missions');
const {CitySimulation}=require('./simulation');
const {DEFAULT_MISSIONS}=require('./content');
const {distance,modelHash,errorMessage}=require('./core');
const {PersistentPopulation}=require('./population');
const {PerceptionEngine}=require('./perception');
const {finitePosition}=require('./security');

function createCityRuntime(options){
 const {db,config,profiles,memory,jobs,actions,active,serviceSessions,npcLocks,identity,lookup,position,npcBucket,nearby,inspectVehicle,inspectAction,applyVehicle,pendingJobs,limiter,emit,onNet,on,exports,getPlayers,bindProfile,game:g}=options;
 const tripWaiters=new Map(),policeTasks=new Map(),restraintTasks=new Map(),routineTasks=new Map(),missionActors=new Map(),vehicles=new Map(),itemEffects=new Map(),inventoryTasks=new Map(),speechRequests=new Map(),policeDispatches=new Map(),serverContexts=new WeakSet();
 let stopped=false,ticking=false,lastMaintenance=0,lastSimulation=0;
 const now=()=>Date.now();
 const entityPosition=entity=>{if(!entity||!g.DoesEntityExist(entity))return null;const [x,y,z]=g.GetEntityCoords(entity);return finitePosition({x,y,z})?{x,y,z}:null;};
 function vehicleSnapshot(netId){
  const entity=g.NetworkGetEntityFromNetworkId(netId);if(!entity||!g.DoesEntityExist(entity)||g.GetEntityType(entity)!==2)return null;
  return {exists:true,entity,netId,model:g.GetEntityModel(entity),plate:g.GetVehicleNumberPlateText(entity).trim(),position:entityPosition(entity),bucket:g.GetEntityRoutingBucket(entity),engineHealth:g.GetVehicleEngineHealth?g.GetVehicleEngineHealth(entity):null,speed:g.GetEntitySpeed?g.GetEntitySpeed(entity):null};
 }
 function snapshot(src){
  const entity=g.GetPlayerPed(String(src)),pos=entityPosition(entity);if(!pos)return null;
  const vehicle=g.GetVehiclePedIsIn?g.GetVehiclePedIsIn(entity,false):0,v=vehicle?vehicleSnapshot(g.NetworkGetNetworkIdFromEntity(vehicle)):null;
  return {position:pos,pedNetId:g.NetworkGetNetworkIdFromEntity(entity),health:g.GetEntityHealth(entity),bucket:g.GetPlayerRoutingBucket(String(src)),alive:g.GetEntityHealth(entity)>0,vehicle:v?{...v,driver:g.GetPedInVehicleSeat?g.GetPedInVehicleSeat(vehicle,-1)===entity:false}:null};
 }
 function npcSnapshot(id){
  const npc=lookup(id),pos=npc&&position(npc),entity=npc?.netId?g.NetworkGetEntityFromNetworkId(npc.netId):0;
  const vehicle=entity&&g.GetVehiclePedIsIn?g.GetVehiclePedIsIn(entity,false):0;
  return npc&&pos?{exists:true,entity,model:entity?g.GetEntityModel(entity):null,health:entity?g.GetEntityHealth(entity):200,position:pos,bucket:npcBucket(npc),alive:!entity||g.GetEntityHealth(entity)>0,busy:busy(id),netId:npc.netId,vehicleNetId:vehicle?g.NetworkGetNetworkIdFromEntity(vehicle):null}:null;
 }
 function inspectService(ctx){
  if(stopped||(!serverContexts.has(ctx.session)&&active.get(ctx.src)!==ctx.session&&serviceSessions.get(ctx.src)!==ctx.session)||!nearby(ctx.src,ctx.session.npc,15))throw new Error('Service indisponible: session ou proximité invalide');
  if(!['calm','surrendered'].includes(ctx.session.behavior||'calm'))throw new Error('Le personnage fuit ou se bat');
  if(!serverContexts.has(ctx.session)&&(memory.relation?.(ctx.session.player,ctx.session.npc.id)?.hostility||0)>60)throw new Error('Ce personnage refuse de vous aider après les incidents précédents');
 }
 function cleanupGameplay(s){
  if([...active.values()].includes(s))return;
  if(actions.running.has(s)||[...actions.pending.values()].some(p=>p.ctx.session===s)||[...pendingJobs.values()].some(p=>p.ctx.session===s))return;
  for(const [src,value]of serviceSessions)if(value===s)serviceSessions.delete(src);
  if(npcLocks.get(s.npc.id)===s.src)npcLocks.delete(s.npc.id);
 }
 function remember(ctx,text){
  const id=crypto.randomUUID();memory.add(ctx.session.player,ctx.session.npc.id,'service',text,{source:'verified_service',eventId:id});
  memory.updateRelation?.(ctx.session.player,ctx.session.npc.id,{trust:2,respect:1,affection:1},{validated:true,source:'verified_service',eventId:id});
 }
 const services=createServices({db,config,relation:ctx=>{const r=memory.relation?.(ctx.session.player,ctx.session.npc.id);return r?(r.trust-r.hostility):0;},remember,inspectService,inspectVehicle,position:ctx=>position(ctx.session.npc),
  inspectDriver:(ctx,selection)=>{
   inspectService(ctx);const vehicle=inspectVehicle(ctx,selection),npc=ctx.session.npc;
   if(vehicle.needsPlate)return vehicle;
   if(g.GetEntitySpeed&&g.GetEntitySpeed(vehicle.entity)>1)throw new Error('Le véhicule doit être à l’arrêt');
   if(g.GetPedInVehicleSeat){const driver=g.GetPedInVehicleSeat(vehicle.entity,-1);if(driver&&driver!==g.NetworkGetEntityFromNetworkId(npc.netId))throw new Error('Le siège conducteur est occupé');}
   return vehicle;
  },
  applyVehicle:async(ctx,quote)=>{
   const result=await applyVehicle(ctx,quote);
   if(result.ok&&quote.service==='repair'){
    const vehicle=vehicleSnapshot(quote.vehicle.netId);
    // Rewards require replicated vehicle health or an explicitly registered trusted verifier.
    if(vehicle?.engineHealth>=900)missions.trustedEvent({type:'mechanic_repair',player:ctx.session.player,npcId:ctx.session.npc.id,vehicleNetId:quote.vehicle.netId,operationId:quote.id});
   }
   cleanupGameplay(ctx.session);return result;
  },
  drive:async(ctx,quote)=>{
   inspectService(ctx);const selected=inspectVehicle(ctx,{selected:quote.vehicle});
   let resolve;const completion=new Promise(r=>resolve=r);const timer=setTimeout(()=>{const waiter=tripWaiters.get(ctx.session);if(!waiter)return;tripWaiters.delete(ctx.session);actions.stop(ctx.session,'expired');waiter.resolve({ok:false,error:'Trajet expiré côté serveur'});cleanupGameplay(ctx.session);},((config.actions?.maxTripSeconds||180)+30)*1000);tripWaiters.set(ctx.session,{resolve,timer,vehicle:selected,destination:quote.destination,src:ctx.src});
   try{
    const started=await actions.startTrusted(ctx,'drive',{vehicleNetId:selected.netId,plate:selected.plate,destination:quote.destination});
    if(!started.ok){tripWaiters.delete(ctx.session);return started;}
    return await completion;
   }finally{clearTimeout(timer);const waiter=tripWaiters.get(ctx.session);if(waiter)clearTimeout(waiter.timer);tripWaiters.delete(ctx.session);cleanupGameplay(ctx.session);}
  },
  incident:(ctx,id)=>{const record=db.get('incidents',id);return record?.witnesses?.includes(ctx.session.npc.id)?record:null;},
  enforce:(ctx,sanction)=>enforce(ctx,sanction)
 });
 for(const job of Object.values(services.jobs))jobs.register(job);
 jobs.jobs.set('shopkeeper',services.jobs.seller);
 // Start recovery synchronously before accepting tools: these methods transact before their first await.
 void services.economy.recover();
 function routineCancel(npcId){for(const [token,task]of routineTasks)if(task.npcId===npcId){routineTasks.delete(token);emit('fivemai:routine',task.src,{token,npcNetId:task.netId,action:'cancel'});}}
 function ownsGameplayLock(id){return [...missionActors.values()].some(a=>a.npc.id===id)||[...policeTasks.values()].some(t=>t.npcId===id)||[...policeDispatches.values()].some(s=>s.npc.id===id);}
 function busy(id){return npcLocks.has(id)||ownsGameplayLock(id);}
 async function startObjective(ctx,run,step){
  const npc=lookup(step.npcId);if(!npc?.netId||!nearby(ctx.src,npc,30))return false;
  const prior=missionActors.get(run.id);if(prior&&prior.npc.id===npc.id){if(prior.src===ctx.src&&(actions.running.has(prior.session)||[...actions.pending.values()].some(p=>p.ctx.session===prior.session)))return true;actions.stop(prior.session);missionActors.delete(run.id);}
  if(npcLocks.has(npc.id)&&npcLocks.get(npc.id)!==ctx.src)return false;
  const session={npc,player:run.player,src:ctx.src,behavior:'calm',missionId:run.id};
  const context={src:ctx.src,session};let observed={},action='follow';
  if(step.type==='transport'){
   const p=snapshot(ctx.src);if(!p?.vehicle||!p.vehicle.driver||p.vehicle.bucket!==npcBucket(npc)||distance(p.vehicle.position,position(npc))>12)return false;
   action='enter_vehicle';observed={vehicleNetId:p.vehicle.netId,plate:p.vehicle.plate};
  }
  routineCancel(npc.id);missionActors.set(run.id,{...context,npc});npcLocks.set(npc.id,ctx.src);
  const result=await actions.startTrusted(context,action,observed);
  if(!result.ok){missionActors.delete(run.id);if(npcLocks.get(npc.id)===ctx.src&&active.get(ctx.src)?.npc.id!==npc.id&&serviceSessions.get(ctx.src)?.npc.id!==npc.id)npcLocks.delete(npc.id);}
  return result.ok;
 }
 function stopObjective(run){const actor=missionActors.get(run.id);if(!actor)return;actions.stop(actor.session);missionActors.delete(run.id);if(npcLocks.get(actor.npc.id)===actor.src&&active.get(actor.src)?.npc.id!==actor.npc.id&&serviceSessions.get(actor.src)?.npc.id!==actor.npc.id)npcLocks.delete(actor.npc.id);}
 const missions=new MissionEngine({db,economy:services.economy,definitions:config.missions||DEFAULT_MISSIONS,snapshot,npcSnapshot,vehicleSnapshot,startObjective,stopObjective,onCompleted:run=>{memory.add(run.player,run.npcId,'service',`Mission terminée: ${run.definitionId}. Récompense accordée par le serveur.`,{source:'mission_engine',eventId:run.id});memory.updateRelation?.(run.player,run.npcId,{trust:run.social.trust||0,respect:run.social.reputation||0},{validated:true,source:'mission_engine',eventId:run.id});}});
 missions.recover();
 const simulation=new CitySimulation({db,characters:config.npcs,config:config.simulation,now,npcSnapshot,onRumor:()=>{},dispatch:(src,command)=>{
  if(!command?.npcNetId)return false;
  if(command.task==='cancel'||command.action==='cancel'){routineTasks.delete(command.token);emit('fivemai:routine',Number(src),command);return true;}
  const npc=(config.npcs||[]).find(n=>n.id===command.npcId)||lookup(command.npcId);if(!npc||!nearby(src,npc,config.simulation?.nearRadius||100)||busy(npc.id))return false;
  routineTasks.set(command.token,{token:command.token,src:Number(src),npcId:npc.id,netId:command.npcNetId,at:now(),destination:command.destination});emit('fivemai:routine',Number(src),command);return true;
 },memory,profileStore:profiles});
 const population=new PersistentPopulation({db,profiles,config:config.population||{enabled:false},players:()=>getPlayers().map(id=>snapshot(Number(id))).filter(Boolean),now,
  spawn:(profile,coords)=>{if(!g.CreatePed)return null;const hash=typeof profile.model==='number'?profile.model>>>0:modelHash(profile.model);const entity=g.CreatePed(4,hash,coords.x,coords.y,coords.z,coords.heading||0,true,true);if(!entity)return null;if(g.SetEntityRoutingBucket)g.SetEntityRoutingBucket(entity,profile.bucket||0);if(g.SetEntityOrphanMode)g.SetEntityOrphanMode(entity,2);const netId=g.NetworkGetNetworkIdFromEntity(entity);if(!netId){if(g.DeleteEntity)g.DeleteEntity(entity);return null;}return {netId,entity,bucket:profile.bucket||0,owned:true};},
  bind:(netId,id)=>typeof bindProfile==='function'?bindProfile(netId,id):false,
  exists:b=>g.DoesEntityExist(b.entity)&&g.NetworkGetEntityFromNetworkId(b.netId)===b.entity&&g.Entity(b.entity).state.fivemai_profile_id===b.id,
  remove:b=>{if(g.DoesEntityExist(b.entity)&&g.DeleteEntity)g.DeleteEntity(b.entity);},
  snapshot:id=>{const n=npcSnapshot(id);return n?{...n,profileId:id}:null;}
 });
 function registerAmbient(profile,coords,binding){const record=population.register(profile,coords,binding);simulation.register({...profile,coords:record.home,routine:record.routine});return record;}
 for(const {value:record}of db.list('population')){const profile=profiles.get(record.id);if(profile)simulation.register({...profile,coords:record.home,routine:record.routine});}
 function gameplayFor(src,token){
  for(const session of [active.get(src),serviceSessions.get(src),...[...missionActors.values()].filter(a=>a.src===src).map(a=>a.session)]){
   if(!session)continue;if(actions.running.get(session)?.token===token||actions.pending.get(token)?.ctx.session===session)return session;
  }return null;
 }
 function actionFinished(src,token,reason){
  const s=gameplayFor(src,token);if(!s)return false;const waiter=tripWaiters.get(s),running=actions.running.get(s);
  if(waiter){
   const vehicle=vehicleSnapshot(waiter.vehicle.netId),p=snapshot(src),npc=npcSnapshot(s.npc.id);
   const arrived=reason==='arrived'&&vehicle&&finitePosition(vehicle.position)&&p?.alive===true&&npc?.alive===true&&npc.bucket===vehicle.bucket&&vehicle.model===waiter.vehicle.model&&vehicle.plate===waiter.vehicle.plate&&p?.vehicle?.netId===waiter.vehicle.netId&&npc?.vehicleNetId===waiter.vehicle.netId&&p.bucket===vehicle.bucket&&distance(vehicle.position,waiter.destination)<=12&&Number.isFinite(vehicle.speed)&&vehicle.speed<=1.5;
   clearTimeout(waiter.timer);waiter.resolve(arrived?{ok:true,completed:true,arrived:true}:{ok:false,error:reason==='arrived'?'Arrivée non vérifiée par le serveur':`Trajet interrompu: ${reason}`});tripWaiters.delete(s);
  }
  if(running)actions.ended(src,token,reason);cleanupGameplay(s);return true;
 }
 function recordIncident(src,event){
  const player=identity(src),p=snapshot(src);
  if(!player||!p||!event||typeof event.type!=='string'||!services.jobs.police.rules[event.type]||typeof event.description!=='string'||!event.description.trim()||event.description.length>1200||!Array.isArray(event.witnesses))return false;
  const witnesses=[...new Set(event.witnesses)].filter(id=>{const n=npcSnapshot(id);return n?.exists&&n.bucket===p.bucket&&distance(n.position,p.position)<=(Math.max(1,Math.min(60,Number.isFinite(event.radius)?event.radius:60)));});if(!witnesses.length)return false;
  const id=event.id||crypto.randomUUID();if(typeof id!=='string'||!id||id.length>180)return false;
  const old=db.get('incidents',id);if(old)return old.player===player?id:false;
  const record={id,player,type:event.type,evidence:event.description,validated:true,source:'trusted_server_gameplay',at:now(),bucket:p.bucket,witnesses};db.set('incidents',id,record);
  for(const witness of witnesses){memory.add(player,witness,'game_event',event.description,{source:'trusted_server_gameplay',eventId:id});memory.updateRelation?.(player,witness,{fear:10,trust:-10,hostility:8},{validated:true,source:'trusted_server_gameplay',eventId:id});}
  return id;
 }
 exports('RecordIncident',(playerSource,event)=>recordIncident(Number(playerSource),event));
 function policeTask(src,npc,action,evidenceId,extra={}){
  const token=crypto.randomUUID();return new Promise(resolve=>{
   const task={token,src,npcId:npc.id,npcNetId:npc.netId,target:src,action,evidenceId,resolve,timer:null};policeTasks.set(token,task);routineCancel(npc.id);
   task.timer=setTimeout(()=>finishPolice(token,{ok:false,error:'Action policière expirée'}),Math.min(90000,(extra.durationSeconds||20)*1000+3000));
   emit('fivemai:policeTask',src,{token,npcNetId:npc.netId,targetServerId:src,action,evidenceId,durationSeconds:extra.durationSeconds||20,...extra});
  });
 }
 function finishPolice(token,result){const task=policeTasks.get(token);if(!task)return;policeTasks.delete(token);clearTimeout(task.timer);emit('fivemai:policeCancel',task.src,{token});task.resolve(result);}
 onNet('fivemai:policeResult',(token,ok,state)=>{
  const src=Number(global.source),task=policeTasks.get(token);if(!task||task.src!==src||!limiter.take(src,'policeResult',{count:10,windowMs:1000}))return;
  const n=npcSnapshot(task.npcId),p=snapshot(task.target);if(!p||!n?.exists||p.bucket!==n.bucket||n.alive===false)return finishPolice(token,{ok:false,error:'Intervention interrompue'});
  if(task.action==='pursuit'&&ok===true&&state==='pursuing')return;
  const max=task.action==='pursuit'?5:4;const valid=ok===true&&distance(p.position,n.position)<=max&&state===({challenge:'challenged',pursuit:'caught_up',cuff:'restraint_ready',arrest:'restraint_ready',search:'searched',release:'released'}[task.action]);
  finishPolice(token,valid?{ok:true,completed:true,state}:{ok:false,error:'Position ou tâche policière non confirmée'});
 });
 onNet('fivemai:policeProgress',(token,state)=>{const src=Number(global.source),task=policeTasks.get(token);if(!task||task.src!==src||task.action!=='pursuit'||state!=='caught_up')return;const n=npcSnapshot(task.npcId),p=snapshot(src);if(n?.alive&&p?.alive&&n.bucket===p.bucket&&distance(n.position,p.position)<=5)finishPolice(token,{ok:true,completed:true});});
 function restrain(src,seconds){
  const token=crypto.randomUUID();return new Promise(resolve=>{
   const timer=setTimeout(()=>{restraintTasks.delete(token);emit('fivemai:policeRestraint',src,{token,enabled:false});resolve({ok:false,error:'Menottage non confirmé'});},5000);
   restraintTasks.set(token,{src,resolve,timer});emit('fivemai:policeRestraint',src,{token,enabled:true,durationSeconds:seconds});
  });
 }
 onNet('fivemai:policeRestraintResult',(token,ok,state)=>{const t=restraintTasks.get(token);if(!t||t.src!==Number(global.source))return;restraintTasks.delete(token);clearTimeout(t.timer);t.resolve(ok===true&&state==='cuffed'?{ok:true,state,token}:{ok:false,error:'Le menottage a échoué'});});
 async function enforce(ctx,sanction){
  const npc=ctx.session.npc,p=snapshot(ctx.src),n=npcSnapshot(npc.id);if(!p||!n?.exists||n.bucket!==p.bucket||distance(p.position,n.position)>8)return {ok:false,error:'Le suspect doit être rejoint par l’agent'};
  const adapter=config.adapters?.police;if(adapter&&services.adapters.has(adapter,'enforce'))return services.adapters.call(adapter,'enforce',ctx,sanction);
  if(sanction.custodySeconds>0){const cuff=await policeTask(ctx.src,npc,'cuff',sanction.incidentId);if(!cuff.ok)return cuff;const restrained=await restrain(ctx.src,sanction.custodySeconds);if(!restrained.ok)return restrained;
   const suspect=g.GetPlayerPed(String(ctx.src));g.Entity(suspect).state.set('fivemai_custody_until',sanction.custodyUntil,true);db.set('custody',ctx.session.player,{until:sanction.custodyUntil,incidentId:sanction.incidentId,reason:sanction.reason,token:restrained.token});
  }else{const ordered=await policeTask(ctx.src,npc,'challenge',sanction.incidentId);if(!ordered.ok)return ordered;}
  return {ok:true,completed:true};
 }
 onNet('fivemai:routineResult',(token,ok,state)=>{const task=routineTasks.get(token);if(!task||task.src!==Number(global.source))return;if(ok!==true||['arrived','completed','expired'].includes(state))routineTasks.delete(token);const npc=lookup(task.npcId),pos=npc&&position(npc);const valid=ok===true&&pos&&(!task.destination||distance(pos,task.destination)<=5);simulation.result?.(task.src,token,!!valid,state);});
 exports('RegisterAdapter',(name,adapter)=>services.adapters.register(name,adapter));
 exports('GetWallet',playerSource=>{const player=identity(Number(playerSource));return player?services.economy.getWallet(player):null;});
 exports('GetInventory',playerSource=>{const player=identity(Number(playerSource));return player?services.economy.inventory(player):null;});
 exports('RestockShop',(vendor,itemId,quantity,operationId)=>services.economy.restock(vendor,itemId,quantity,operationId));
 exports('GrantReward',(playerSource,operationId,reward)=>{const player=identity(Number(playerSource));return player?services.economy.reward(player,operationId,reward,{source:'trusted_server_export'}):false;});
 exports('GetMissionStatus',playerSource=>{const player=identity(Number(playerSource));return player?missions.status(player):null;});
 exports('UseInventoryItem',(playerSource,itemId,operationId)=>useItem(Number(playerSource),itemId,operationId));
 exports('RegisterItemEffect',(id,effect)=>{if(typeof id!=='string'||typeof effect!=='function')return false;itemEffects.set(id,effect);return true;});
 async function useItem(src,itemId,operationId=crypto.randomUUID()){
  const player=identity(src),p=snapshot(src);if(!player||!p?.alive)throw new Error('Joueur indisponible');
  return services.economy.useItem(player,itemId,operationId,async data=>{
   if(itemEffects.has(itemId))return itemEffects.get(itemId)(src,data);
   if(data.effect==='hydration'||data.effect==='food'){db.set('needs',player,{...(db.get('needs',player)||{}),[data.effect]:100,updatedAt:now()});return {ok:true};}
   if(data.effect==='heal'||data.effect==='repair')return applyInventory(src,player,data);
   return {ok:false,error:'Effet physique à enregistrer côté serveur via RegisterItemEffect'};
  });
 }
 function finishInventory(token,result){const task=inventoryTasks.get(token);if(!task)return;inventoryTasks.delete(token);clearTimeout(task.timer);emit('fivemai:inventoryCancel',task.src,{token});task.resolve(result);}
 function applyInventory(src,player,data){
  const p=snapshot(src),token=crypto.randomUUID();if(!p?.alive)return {ok:false,error:'Joueur indisponible'};
  const targetHealth=Math.min(200,p.health+40),vehicle=p.vehicle;
  if(data.effect==='heal'&&p.health>=200)return {ok:false,error:'Votre santé est déjà pleine'};
  if(data.effect==='repair'&&(!vehicle||!Number.isFinite(vehicle.engineHealth)||vehicle.engineHealth>=900||vehicle.speed>1))return {ok:false,error:'Prenez place dans un véhicule endommagé et arrêté, avec santé moteur répliquée'};
  return new Promise(resolve=>{const task={src,player,resolve,token,effect:data.effect,healthBefore:p.health,targetHealth,vehicle,bucket:p.bucket};task.timer=setTimeout(()=>finishInventory(token,{ok:false,error:'Effet de l’objet non confirmé'}),10000);inventoryTasks.set(token,task);emit('fivemai:inventoryEffect',src,{token,effect:data.effect,targetHealth,vehicleNetId:vehicle?.netId,minimumEngineHealth:900});});
 }
 onNet('fivemai:inventoryResult',(token,ok)=>{
  const src=Number(global.source),task=inventoryTasks.get(token);if(!task||task.src!==src||task.verifying)return;task.verifying=true;
  if(ok!==true)return finishInventory(token,{ok:false,error:'Effet natif refusé'});
  setTimeout(()=>{if(!inventoryTasks.has(token))return;const p=snapshot(src),v=task.vehicle&&vehicleSnapshot(task.vehicle.netId);const verified=identity(src)===task.player&&p?.alive&&p.bucket===task.bucket&&(task.effect==='heal'?p.health>=task.targetHealth&&p.health>task.healthBefore:!!v&&v.bucket===task.bucket&&v.model===task.vehicle.model&&v.plate===task.vehicle.plate&&p.vehicle?.netId===v.netId&&Number.isFinite(v.engineHealth)&&v.engineHealth>=900);finishInventory(token,verified?{ok:true}:{ok:false,error:'Effet non confirmé par les natives serveur'});},500);
 });
 function consumeSpeechRequest(src,npcId,token){const request=speechRequests.get(src);if(!request||request.npcId!==npcId||request.token!==token||request.until<now())return null;speechRequests.delete(src);return request;}
 function speakPolice(src,npc,incident){
  const description=`Intervention validée: ${incident.evidence}. Donne un ordre bref et explique ce motif sans inventer d’autre infraction.`;
  const session=active.get(src);
  if(session?.npc.id===npc.id&&session.ws?.readyState===1){if(!session.playerSpeaking&&!session.responseActive){session.ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'system',content:[{type:'input_text',text:description}]}}));session.ws.send(JSON.stringify({type:'response.create',response:{tool_choice:'none'}}));}return;}
  if(session||!nearby(src,npc,config.interactionDistance||4))return;
  const token=crypto.randomUUID();speechRequests.set(src,{npcId:npc.id,token,until:now()+15000,description});emit('fivemai:policeSpeech',src,{npcId:npc.id,npcNetId:npc.netId,requestToken:token});
 }
 async function dispatchPolice(players){
  if(config.police?.enabled===false)return;
  for(const {value:incident}of db.list('incidents')){
   if(now()-incident.at>(config.police?.incidentMaxAgeSeconds||300)*1000||db.get('sanctions',`police:${incident.id}`)?.status==='completed'||policeDispatches.has(incident.id))continue;
   const attempt=db.get('police_attempts',incident.id);if(attempt&&now()-attempt.at<(config.police?.retrySeconds||30)*1000)continue;
   const p=players.find(p=>p.player===incident.player);if(!p?.alive)continue;
   const officers=incident.witnesses.map(lookup).filter(n=>n?.jobId==='police'&&n.netId&&npcBucket(n)===p.bucket&&!busy(n.id));if(!officers.length)continue;
   const officer=officers[0],session={src:p.src,player:p.player,npc:officer,behavior:'calm',serverOwnedPolice:true};serverContexts.add(session);policeDispatches.set(incident.id,session);npcLocks.set(officer.id,p.src);db.set('police_attempts',incident.id,{at:now()});
   const task=async()=>{
    try{
     const units=officers.slice(1,Math.max(1,config.police?.maxUnits||2));for(const unit of units)void policeTask(p.src,unit,'pursuit',incident.id,{durationSeconds:config.police?.pursuitSeconds||60}).catch(()=>{});
     speakPolice(p.src,officer,incident);
     if(!nearby(p.src,officer,4)){const caught=await policeTask(p.src,officer,'pursuit',incident.id,{durationSeconds:config.police?.pursuitSeconds||60});if(!caught.ok)return;}
     speakPolice(p.src,officer,incident);
     await services.jobs.police.execute('police_sanction',{src:p.src,session},{incidentId:incident.id});
    }catch(e){console.warn('[fivemai] Intervention policière: '+errorMessage(e));}
    finally{policeDispatches.delete(incident.id);if(npcLocks.get(officer.id)===p.src&&active.get(p.src)?.npc.id!==officer.id&&serviceSessions.get(p.src)?.npc.id!==officer.id)npcLocks.delete(officer.id);}
   };void task();
  }
 }
 const perception=new PerceptionEngine({db,memory,identity,snapshot,npcSnapshot,npcForNetId:id=>config.npcs.find(n=>lookup(n.id)?.netId===id)||null,config:config.perception,onEvent:event=>{if(event.sanctionEligible){db.set('incidents',event.id,{id:event.id,player:event.player,type:event.type,evidence:event.description,validated:true,source:event.source,at:event.at,bucket:event.bucket,witnesses:event.witnesses});}},onPublic:event=>simulation.recordPublicEvent(event)});
 on('weaponDamageEvent',(src,data)=>perception.weaponDamage(Number(src),data));
 onNet('fivemai:perception',data=>{const src=Number(global.source);if(!limiter.take(src,'perception',{count:6,windowMs:1000})||!data||typeof data!=='object')return;const npc=config.npcs.map(n=>lookup(n.id)).find(n=>n?.netId===data.victimNetId);if(!npc)return;const observation=perception.observe(src,npc.id,{netId:data.victimNetId,hit:data.kind==='injury',collision:data.kind==='collision'});const s=active.get(src);if(observation&&s?.npc.id===npc.id)s.observedPerception=observation;});
 exports('RecordPerceivedEvent',(event,scope)=>perception.publish(event,scope));
 function publicMemory(id){return (simulation.state(id)?.rumors||[]).slice(-8).map(r=>{const event=db.get('city_public_events',r.eventId);return event?{kind:r.kind,provenance:r.kind==='rumor'?'rumor':'server_validated',source:r.heardFrom||event.source,text:event.description,visibility:'public'}:null;}).filter(Boolean);}
 if(g.RegisterCommand){
  const notice=(src,message)=>emit('fivemai:notice',Number(src),String(message));
  const wrap=handler=>(src,args)=>{if(Number(src)<=0)return;Promise.resolve(handler(Number(src),args||[])).catch(e=>notice(src,errorMessage(e)));};
  g.RegisterCommand('pnjsolde',wrap(async src=>{const w=await services.economy.getWallet(identity(src));notice(src,`Solde: ${w.balance} $, réservé: ${w.reserved} $.`);}),false);
  g.RegisterCommand('pnjinventaire',wrap(async src=>{const inv=await services.economy.inventory(identity(src));notice(src,Object.entries(inv).map(([id,n])=>`${id}: ${n}`).join(', ')||'Inventaire vide.');}),false);
  g.RegisterCommand('pnjutiliser',wrap(async(src,args)=>{const result=await useItem(src,args[0]);notice(src,result.ok?'Objet utilisé.':result.error);}),false);
  g.RegisterCommand('pnjmission',wrap(src=>notice(src,JSON.stringify(missions.status(identity(src))))),false);
  g.RegisterCommand('pnjbackup',(src)=>{if(Number(src)!==0)return;try{console.log('[fivemai] Sauvegarde SQLite: '+db.backup(require('node:path').join(require('node:path').dirname(db.file),'backups',`fivemai-${now()}.sqlite`)));}catch(e){console.warn(errorMessage(e));}},true);
  g.RegisterCommand('pnjstats',src=>{if(Number(src)===0)console.log('[fivemai] '+JSON.stringify({storage:db.stats(),voiceSessions:active.size,gameplaySessions:serviceSessions.size,missions:db.count('mission_active'),population:simulation.characters.size}));},true);
 }
 exports('BackupDatabase',()=>db.backup(require('node:path').join(require('node:path').dirname(db.file),'backups',`fivemai-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`)));
 function spawnVehicles(){
  if(!g.CreateVehicle)return;
  for(const npc of config.npcs){if(!npc.serviceVehicle)continue;const previous=vehicles.get(npc.id);if(previous&&g.DoesEntityExist(previous))continue;const c=npc.serviceVehicle.coords;if(!finitePosition(c))continue;
   const entity=g.CreateVehicle(modelHash(npc.serviceVehicle.model),c.x,c.y,c.z,c.heading||0,true,true);if(entity){vehicles.set(npc.id,entity);if(g.SetEntityOrphanMode)g.SetEntityOrphanMode(entity,2);}
  }
 }
 function disconnect(src){
  perception.forget(src);speechRequests.delete(src);for(const [token,t]of inventoryTasks)if(t.src===src)finishInventory(token,{ok:false,error:'Joueur déconnecté'});
  for(const [token,t]of policeTasks)if(t.src===src)finishPolice(token,{ok:false,error:'Joueur déconnecté'});
  for(const [token,t]of restraintTasks)if(t.src===src){clearTimeout(t.timer);restraintTasks.delete(token);t.resolve({ok:false,error:'Joueur déconnecté'});}
  for(const actor of missionActors.values())if(actor.src===src)stopObjective({id:actor.session.missionId});
  for(const [session,w]of tripWaiters)if(w.src===src){clearTimeout(w.timer);w.resolve({ok:false,error:'Joueur déconnecté'});tripWaiters.delete(session);}
 }
 async function tick(){
  if(stopped||ticking)return;ticking=true;
  try{
   const players=getPlayers().map(id=>{const src=Number(id),player=identity(src),p=snapshot(src);return p&&player?{src,player,...p}:null;}).filter(Boolean);
   for(const p of players){const custody=db.get('custody',p.player);if(custody?.until>now()&&!restraintTasks.size){const entity=g.GetPlayerPed(String(p.src));if(!g.Entity(entity).state.fivemai_custody_until){g.Entity(entity).state.set('fivemai_custody_until',custody.until,true);emit('fivemai:policeRestraint',p.src,{token:custody.token||`custody-${custody.incidentId}`,enabled:true,durationSeconds:Math.ceil((custody.until-now())/1000)});}}else if(custody?.until<=now()){db.delete('custody',p.player);g.Entity(g.GetPlayerPed(String(p.src))).state.set('fivemai_custody_until',0,true);emit('fivemai:policeRestraint',p.src,{token:custody.token||`custody-${custody.incidentId}`,enabled:false});}}
   perception.tick();perception.sample([...simulation.characters.keys()]);await dispatchPolice(players);await missions.tick(players);
   for(const [session,w]of tripWaiters)if(!actions.running.has(session)&&![...actions.pending.values()].some(task=>task.ctx.session===session)){clearTimeout(w.timer);w.resolve({ok:false,error:'Conduite interrompue'});tripWaiters.delete(session);cleanupGameplay(session);}
   if(now()-lastSimulation>=(config.simulation?.tickMs||5000)){lastSimulation=now();population.tick(players);simulation.tick(players);spawnVehicles();}
   for(const [src,s]of serviceSessions){if(!snapshot(src)||!position(s.npc)||g.GetPlayerRoutingBucket(String(src))!==npcBucket(s.npc)){actions.stop(s);for(const [token,p]of pendingJobs)if(p.ctx.session===s)options.finishJob(token,{ok:false,error:'Entité ou bucket devenu invalide'});const waiter=tripWaiters.get(s);if(waiter)waiter.resolve({ok:false,error:'Trajet interrompu'});services.forget(s);serviceSessions.delete(src);if(npcLocks.get(s.npc.id)===src)npcLocks.delete(s.npc.id);}else cleanupGameplay(s);}
   for(const [token,task]of routineTasks)if(now()-task.at>120000)routineTasks.delete(token);
   if(now()-lastMaintenance>60000){lastMaintenance=now();await services.economy.recover({expiredOnly:true});for(const {key,value}of db.list('mission_offers'))if(value.expiresAt<now())db.delete('mission_offers',key);for(const {key,value}of db.list('incidents'))if(now()-value.at>86400000)db.delete('incidents',key);for(const {key}of db.list('voice_budget'))if(key<new Date(now()-32*86400000).toISOString().slice(0,10))db.delete('voice_budget',key);}
  }catch(e){console.warn(`[fivemai] Simulation: ${errorMessage(e)}`);}finally{ticking=false;}
 }
 function stop(){stopped=true;population.shutdown();perception.stop();simulation.shutdown();for(const token of [...inventoryTasks.keys()])finishInventory(token,{ok:false,error:'Ressource arrêtée'});for(const token of [...policeTasks.keys()])finishPolice(token,{ok:false,error:'Ressource arrêtée'});for(const {resolve,timer}of restraintTasks.values()){clearTimeout(timer);resolve({ok:false,error:'Ressource arrêtée'});}restraintTasks.clear();for(const [session,w]of tripWaiters){clearTimeout(w.timer);w.resolve({ok:false,error:'Ressource arrêtée'});actions.stop(session);}tripWaiters.clear();for(const actor of missionActors.values())actions.stop(actor.session);missionActors.clear();for(const task of routineTasks.values())emit('fivemai:routine',task.src,{token:task.token,npcNetId:task.netId,action:'cancel'});routineTasks.clear();for(const entity of vehicles.values())if(g.DoesEntityExist(entity)&&g.DeleteEntity)g.DeleteEntity(entity);vehicles.clear();}
 return {services,population,registerAmbient,ownsGameplayLock,perception,publicMemory,consumeSpeechRequest,economy:services.economy,missions,simulation,snapshot,npcSnapshot,vehicleSnapshot,recordIncident,gameplayFor,actionFinished,busy,routineCancel,cleanupGameplay,forget:s=>services.forget(s),disconnect,tick,stop};
}
module.exports={createCityRuntime};
