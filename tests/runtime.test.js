const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PersistentDatabase}=require('../server/database');
const {MemoryStore,distance}=require('../server/core');
const {JobRegistry}=require('../server/jobs');
const {NPCActionManager}=require('../server/actions');
const {RequestLimiter}=require('../server/security');
const {createCityRuntime}=require('../server/runtime');
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(){
  const db=new PersistentDatabase(':memory:'),memory=new MemoryStore(null,{db}),events=[],handlers={},exported={},active=new Map(),serviceSessions=new Map(),npcLocks=new Map(),pendingJobs=new Map(),entities=new Map(),net=new Map();
  function entity(id,{netId,type=1,x=0,y=0,z=0,...rest}={}){const value={id,type,position:{x,y,z},bucket:0,health:200,model:123,vehicle:0,state:{},...rest};entities.set(id,value);if(netId)net.set(netId,id);return value;}
  const player=entity(1),other=entity(2,{x:100}),driver=entity(201,{netId:101,x:1}),police=entity(202,{netId:102,x:2}),escort=entity(203,{netId:103,x:4}),giver=entity(204,{netId:104,x:2}),vehicle=entity(301,{netId:501,type:2,plate:'TAXI1',engineHealth:1000,speed:0,driver:0});
  const npcs=[['driver',101,'driver'],['police',102,'police'],['escort',103,'resident'],['giver',104,'journalist']].map(([id,netId,jobId])=>({id,netId,jobId,model:'a_m_y_business_01',coords:{...entities.get(net.get(netId)).position},firstName:id,lastName:'Test',voice:'cedar',story:'Test',personality:'Test'}));
  const npcById=new Map(npcs.map(n=>[n.id,n])),emit=(...args)=>events.push(args);
  const game={GetPlayerPed:src=>Number(src)===7?1:Number(src)===8?2:0,DoesEntityExist:id=>entities.has(id),GetEntityCoords:id=>{const p=entities.get(id)?.position;return p?[p.x,p.y,p.z]:[NaN,NaN,NaN];},
    GetPlayerRoutingBucket:src=>entities.get(Number(src)===7?1:2)?.bucket??-1,GetEntityRoutingBucket:id=>entities.get(id)?.bucket??-1,GetEntityHealth:id=>entities.get(id)?.health??0,
    NetworkGetEntityFromNetworkId:id=>net.get(id)||0,GetEntityModel:id=>entities.get(id)?.model??0,GetEntityType:id=>entities.get(id)?.type??0,NetworkGetNetworkIdFromEntity:id=>[...net].find(([,value])=>value===id)?.[0]||0,
    GetVehicleNumberPlateText:id=>entities.get(id)?.plate||'',GetVehicleEngineHealth:id=>entities.get(id)?.engineHealth,GetVehicleBodyHealth:()=>1000,GetEntitySpeed:id=>entities.get(id)?.speed,
    GetVehiclePedIsIn:id=>entities.get(id)?.vehicle||0,GetPedInVehicleSeat:(id,seat)=>seat===-1?entities.get(id)?.driver||0:0,GetAllVehicles:()=>[301],Entity:id=>({state:{...entities.get(id).state,set:(key,value)=>{entities.get(id).state[key]=value;}}})};
  const lookup=id=>npcById.get(id),position=npc=>{const e=entities.get(net.get(npc.netId));return e?{...e.position}:null;},npcBucket=npc=>game.GetEntityRoutingBucket(net.get(npc.netId));
  const nearby=(src,npc,max=5)=>{const p=entities.get(game.GetPlayerPed(src)),n=position(npc);return !!p&&!!n&&p.bucket===npcBucket(npc)&&distance(p.position,n)<=max;};
  const actions=new NPCActionManager({inspect:()=>({}),send:(src,event,data)=>emit(event,src,data),schedule:()=>0,cancelTimer(){}}),jobs=new JobRegistry();
  const config={npcs,destinations:{destination:{label:'Destination',x:1000,y:0,z:0}},economy:{initialBalance:1000},simulation:{enabled:false},missions:[{id:'escort_help',npcId:'giver',title:'Escort',reward:{money:100},social:{trust:2,reputation:1},stages:[{type:'escort',npcId:'escort',destination:{x:50,y:0,z:0},radius:4,dwellSeconds:0}]}]};
  const inspectVehicle=()=>({entity:301,model:vehicle.model,netId:501,plate:vehicle.plate,distance:1});
  const runtime=createCityRuntime({db,config,profiles:{get:id=>lookup(id)},memory,jobs,actions,active,serviceSessions,npcLocks,identity:src=>[7,8].includes(Number(src))?`license:${src}`:null,lookup,position,npcBucket,nearby,inspectVehicle,inspectAction:()=>({}),applyVehicle:async()=>({ok:true}),pendingJobs,finishJob(){},limiter:new RequestLimiter(),emit,onNet:(name,fn)=>handlers[name]=fn,on(){},exports:(name,fn)=>exported[name]=fn,getPlayers:()=>['7','8'],game});
  function ctx(id){const session={npc:lookup(id),player:'license:7',src:7,behavior:'calm'};active.set(7,session);npcLocks.set(id,7);return {src:7,session};}
  function call(name,src,...args){const previous=global.source;global.source=src;try{return handlers[name](...args);}finally{global.source=previous;}}
  const close=async()=>{runtime.stop();await settle();await settle();db.close();};
  return {db,memory,runtime,actions,jobs,active,serviceSessions,npcLocks,events,handlers,exported,player,other,driver,police,escort,giver,vehicle,ctx,call,close};
}
async function startTaxi(f){
  const ctx=f.ctx('driver'),job=f.runtime.services.jobs.driver,quote=await job.execute('taxi_quote',ctx,{destination:'destination'});
  const pending=job.execute('taxi_start',ctx,{quoteId:quote.quoteId,confirmed:true});await settle();
  const start=f.events.find(e=>e[0]==='fivemai:actionStart');assert.ok(start);f.vehicle.driver=f.driver.id;f.driver.vehicle=f.vehicle.id;f.player.vehicle=f.vehicle.id;
  assert.equal(f.actions.result(7,start[2].token,true),true);await settle();
  return {ctx,quote,pending,token:start[2].token};
}
function arrive(f){for(const e of [f.player,f.driver,f.vehicle])e.position={x:1000,y:0,z:0};}

test('taxi arrival claims at the starting location refund the reservation',async t=>{
  const f=fixture();t.after(f.close);const trip=await startTaxi(f);assert.equal(f.runtime.actionFinished(7,trip.token,'arrived'),true);
  const result=await trip.pending;assert.equal(result.ok,false);assert.equal(result.interrupted,true);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,1000);
  assert.equal(f.db.get('payments',`taxi:${trip.quote.quoteId}`).status,'refunded');
});
test('a failed physical taxi startup refunds and closes its server trip timer',async t=>{
  const f=fixture();t.after(f.close);const ctx=f.ctx('driver'),job=f.runtime.services.jobs.driver,quote=await job.execute('taxi_quote',ctx,{destination:'destination'});
  const pending=job.execute('taxi_start',ctx,{quoteId:quote.quoteId,confirmed:true});await settle();const start=f.events.find(e=>e[0]==='fivemai:actionStart');f.actions.result(7,start[2].token,false,'control');
  assert.equal((await pending).ok,false);assert.equal(f.db.get('payments',`taxi:${quote.quoteId}`).status,'refunded');assert.equal((await f.runtime.economy.getWallet('license:7')).balance,1000);
});
test('taxi captures payment once after server arrival, even after its voice session closes',async t=>{
  const f=fixture();t.after(f.close);const trip=await startTaxi(f);f.active.delete(7);f.serviceSessions.set(7,trip.ctx.session);arrive(f);
  assert.equal(f.runtime.actionFinished(8,trip.token,'arrived'),false);assert.equal(f.runtime.actionFinished(7,trip.token,'arrived'),true);
  const result=await trip.pending;assert.equal(result.arrived,true);assert.equal(result.paid,trip.quote.price);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,1000-trip.quote.price);
  assert.equal(f.runtime.actionFinished(7,trip.token,'arrived'),false);assert.equal(f.serviceSessions.size,0);assert.ok(!f.npcLocks.has('driver'));
});
test('a taxi cannot bill dead participants, cross-bucket actors, moving or unreadable vehicles',async t=>{
  for(const mutate of [f=>f.player.health=0,f=>f.driver.health=0,f=>f.driver.bucket=1,f=>f.vehicle.speed=10,f=>f.vehicle.speed=undefined,f=>f.vehicle.position.x=NaN]){
    const f=fixture();try{const trip=await startTaxi(f);arrive(f);mutate(f);assert.doesNotThrow(()=>f.runtime.actionFinished(7,trip.token,'arrived'));const result=await trip.pending;assert.equal(result.ok,false);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,1000);}finally{await f.close();}
  }
});
test('police accepts only trusted incidents witnessed in the same routing bucket',async t=>{
  const f=fixture();t.after(f.close);const ctx=f.ctx('police');
  assert.equal(f.handlers.RecordIncident,undefined);await assert.rejects(f.runtime.services.jobs.police.execute('police_sanction',ctx,{incidentId:'invented'}),/Incident non validé/);assert.equal(f.db.count('sanctions'),0);
  f.player.bucket=1;assert.equal(f.exported.RecordIncident(7,{type:'threat',description:'Untrusted accusation',witnesses:['police']}),false);assert.equal(f.db.count('incidents'),0);
  f.player.bucket=0;const id=f.exported.RecordIncident(7,{id:'server-incident',type:'threat',description:'Observed server threat',witnesses:['police','police','missing']});
  assert.equal(id,'server-incident');assert.deepEqual(f.db.get('incidents',id).witnesses,['police']);assert.equal(f.memory.get('license:7','police')[0].provenance,'server_validated');
});
test('wrong-source police acknowledgements cannot charge, and bucket changes cancel enforcement',async t=>{
  const f=fixture();t.after(f.close);const ctx=f.ctx('police'),id=f.exported.RecordIncident(7,{id:'threat-one',type:'threat',description:'Server observed threat',witnesses:['police']});
  const pending=f.runtime.services.jobs.police.execute('police_sanction',ctx,{incidentId:id});await settle();const task=f.events.find(e=>e[0]==='fivemai:policeTask');assert.ok(task);
  f.call('fivemai:policeResult',8,task[2].token,true,'challenged');assert.equal(f.db.get('sanctions',`police:${id}`).status,'preparing');
  f.player.bucket=1;f.call('fivemai:policeResult',7,task[2].token,true,'challenged');assert.equal((await pending).ok,false);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,1000);
});
test('verified police intervention applies a configured fine once',async t=>{
  const f=fixture();t.after(f.close);const ctx=f.ctx('police'),id=f.exported.RecordIncident(7,{id:'threat-two',type:'threat',description:'Server observed threat',witnesses:['police']});
  const pending=f.runtime.services.jobs.police.execute('police_sanction',ctx,{incidentId:id});await settle();const task=f.events.find(e=>e[0]==='fivemai:policeTask');f.call('fivemai:policeResult',7,task[2].token,true,'challenged');
  assert.equal((await pending).paid,100);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,900);assert.equal((await f.runtime.services.jobs.police.execute('police_sanction',ctx,{incidentId:id})).duplicate,true);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,900);
});
test('escort mission creates a real NPC action and requires actor arrival before reward',async t=>{
  const f=fixture();t.after(f.close);const ctx=f.ctx('giver'),offer=await f.runtime.missions.execute('mission_offer',ctx,{missionId:'escort_help'});
  const accepting=f.runtime.missions.execute('mission_accept',ctx,{offerId:offer.offerId,confirmed:true});await settle();
  const start=f.events.find(e=>e[0]==='fivemai:actionStart');assert.ok(start);assert.equal(start[2].action,'follow');assert.equal(start[2].npcId,'escort');
  assert.ok(f.runtime.gameplayFor(7,start[2].token));assert.equal(f.runtime.gameplayFor(8,start[2].token),null);f.actions.result(7,start[2].token,true);await accepting;
  f.player.position={x:50,y:0,z:0};await f.runtime.tick();assert.equal(f.runtime.missions.status('license:7').active,true);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,1000);
  f.escort.position={x:50,y:0,z:0};await f.runtime.tick();assert.equal(f.runtime.missions.status('license:7').active,false);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,1100);
  assert.ok(!f.npcLocks.has('escort'));assert.equal(f.npcLocks.get('giver'),7);assert.equal(f.actions.running.size,0);
});
test('transport mission sends a passenger action and rewards only a shared vehicle arrival',async t=>{
  const f=fixture();t.after(f.close);f.runtime.missions.definitions.set('transport_help',{id:'transport_help',npcId:'giver',reward:{money:50},stages:[{type:'transport',npcId:'escort',destination:{x:50,y:0,z:0},radius:4,dwellSeconds:0}]});
  f.player.vehicle=f.vehicle.id;f.vehicle.driver=f.player.id;const ctx=f.ctx('giver'),offer=await f.runtime.missions.execute('mission_offer',ctx,{missionId:'transport_help'});
  const accepting=f.runtime.missions.execute('mission_accept',ctx,{offerId:offer.offerId,confirmed:true});await settle();const start=f.events.find(e=>e[0]==='fivemai:actionStart');
  assert.equal(start[2].action,'enter_vehicle');assert.equal(start[2].vehicleNetId,501);f.actions.result(7,start[2].token,true);await accepting;
  f.player.position=f.vehicle.position={x:50,y:0,z:0};await f.runtime.tick();assert.equal(f.runtime.missions.status('license:7').active,true);
  f.escort.vehicle=f.vehicle.id;f.escort.position={x:50,y:0,z:0};await f.runtime.tick();assert.equal(f.runtime.missions.status('license:7').active,false);assert.equal((await f.runtime.economy.getWallet('license:7')).balance,1050);
  assert.ok(!f.npcLocks.has('escort'));
});
test('ambient routines dispatch to nearby owners and yield to an active conversation',async t=>{
  const f=fixture();t.after(f.close);f.runtime.simulation.config.enabled=true;
  f.runtime.simulation.tick([{src:7,player:'license:7',position:f.player.position,bucket:0}]);
  const routine=f.events.find(e=>e[0]==='fivemai:routine'&&e[2].npcId==='driver');assert.ok(routine);assert.equal(routine[1],7);assert.ok(['idle','walk','scenario'].includes(routine[2].task));
  f.call('fivemai:routineResult',8,routine[2].token,false,'control');assert.equal(f.runtime.simulation.state('driver').lastTaskFailureAt,undefined);
  f.ctx('driver');f.runtime.simulation.tick([{src:7,player:'license:7',position:f.player.position,bucket:0}]);
  assert.ok(f.events.some(e=>e[0]==='fivemai:routine'&&e[2].token===routine[2].token&&(e[2].task==='cancel'||e[2].action==='cancel')));
  assert.ok(!f.events.some(e=>e[0]==='fivemai:answer'||e[0]==='fivemai:voiceOwner'));
});
test('trusted police incident dispatches pursuit, confirms catch-up, cuffs and fines once',async t=>{
  const f=fixture();t.after(f.close);const id=f.exported.RecordIncident(7,{id:'automatic-assault',type:'assault',description:'Actual server-validated assault',witnesses:['police']});
  f.player.position={x:40,y:0,z:0};await f.runtime.tick();await settle();const pursuit=f.events.find(e=>e[0]==='fivemai:policeTask'&&e[2].action==='pursuit');assert.ok(pursuit);
  f.call('fivemai:policeResult',7,pursuit[2].token,true,'pursuing');f.call('fivemai:policeProgress',8,pursuit[2].token,'caught_up');f.call('fivemai:policeProgress',7,pursuit[2].token,'caught_up');await settle();
  assert.ok(!f.events.some(e=>e[0]==='fivemai:policeTask'&&e[2].action==='cuff'));assert.equal(f.db.count('sanctions'),0);
  f.police.position={x:39,y:0,z:0};f.call('fivemai:policeProgress',7,pursuit[2].token,'caught_up');await settle();
  const cuff=f.events.find(e=>e[0]==='fivemai:policeTask'&&e[2].action==='cuff');assert.ok(cuff);f.call('fivemai:policeResult',7,cuff[2].token,true,'restraint_ready');await settle();
  const restraint=f.events.find(e=>e[0]==='fivemai:policeRestraint'&&e[2].enabled);assert.ok(restraint);f.call('fivemai:policeRestraintResult',8,restraint[2].token,true,'cuffed');await settle();assert.equal(f.db.get('custody','license:7'),null);
  f.call('fivemai:policeRestraintResult',7,restraint[2].token,true,'cuffed');await settle();assert.equal(f.db.get('sanctions',`police:${id}`).status,'completed');assert.equal((await f.runtime.economy.getWallet('license:7')).balance,750);
  assert.equal(f.db.get('custody','license:7').token,restraint[2].token);assert.ok(f.player.state.fivemai_custody_until>Date.now());
  const speech=f.events.find(e=>e[0]==='fivemai:policeSpeech');assert.ok(speech);assert.equal(f.runtime.consumeSpeechRequest(8,'police',speech[2].requestToken),null);assert.equal(f.runtime.consumeSpeechRequest(7,'police','invented-token'),null);
  assert.ok(f.runtime.consumeSpeechRequest(7,'police',speech[2].requestToken));assert.equal(f.runtime.consumeSpeechRequest(7,'police',speech[2].requestToken),null);
  await f.runtime.tick();assert.equal((await f.runtime.economy.getWallet('license:7')).balance,750);assert.ok(!f.npcLocks.has('police'));
});
test('fabricated perception and police speech requests cannot authorize a sanction',async t=>{
  const f=fixture();t.after(f.close);f.call('fivemai:perception',7,{victimNetId:102,kind:'injury',actorSource:8});await f.runtime.tick();
  assert.equal(f.db.count('incidents'),0);assert.equal(f.db.count('sanctions'),0);assert.equal(f.runtime.consumeSpeechRequest(7,'police','fabricated'),null);
  assert.ok(!f.events.some(e=>e[0]==='fivemai:policeTask'||e[0]==='fivemai:policeSpeech'));
});
test('a medicine acknowledgement without replicated healing returns the reserved item',async t=>{
  const f=fixture();t.after(f.close);f.player.health=120;await f.exported.GrantReward(7,'medicine-supply',{money:0,items:{medicine:1}});
  const pending=f.exported.UseInventoryItem(7,'medicine','unverified-heal');await settle();const task=f.events.find(e=>e[0]==='fivemai:inventoryEffect');assert.equal(task[2].targetHealth,160);
  f.call('fivemai:inventoryResult',8,task[2].token,true);await settle();assert.equal(f.db.get('item_reservations','use:unverified-heal').status,'reserved');
  f.call('fivemai:inventoryResult',7,'wrong-token',true);f.call('fivemai:inventoryResult',7,task[2].token,true);
  assert.equal((await pending).ok,false);assert.equal(f.db.get('item_reservations','use:unverified-heal').status,'refunded');assert.equal((await f.runtime.economy.inventory('license:7')).medicine,1);
});
test('medicine is consumed once after server natives confirm the requested healing',async t=>{
  const f=fixture();t.after(f.close);f.player.health=120;await f.exported.GrantReward(7,'medicine-supply',{money:0,items:{medicine:1}});
  const pending=f.exported.UseInventoryItem(7,'medicine','verified-heal');await settle();const task=f.events.find(e=>e[0]==='fivemai:inventoryEffect');f.player.health=160;
  f.call('fivemai:inventoryResult',7,task[2].token,true);f.call('fivemai:inventoryResult',7,task[2].token,true);assert.equal((await pending).ok,true);
  assert.equal(f.db.get('item_reservations','use:verified-heal').status,'captured');assert.equal((await f.runtime.economy.inventory('license:7')).medicine,undefined);
  assert.equal((await f.exported.UseInventoryItem(7,'medicine','verified-heal')).duplicate,true);assert.equal(f.player.health,160);
});
test('public NPC rumor context preserves uncertainty and excludes private conversations',async t=>{
  const f=fixture();t.after(f.close);f.memory.add('license:7','driver','conversation','SECRET_PLAYER_DETAILS');f.runtime.simulation.config.enabled=true;
  assert.equal(f.runtime.simulation.recordPublicEvent({id:'private-copy',source:'conversation',visibility:'private',description:'SECRET_PLAYER_DETAILS',witnesses:['driver']}),false);
  assert.equal(f.runtime.simulation.recordPublicEvent({id:'public-library',source:'server_public',visibility:'public',description:'La bibliothèque a réouvert.',witnesses:['driver']}),true);
  f.runtime.simulation.tick([{src:7,player:'license:7',position:f.player.position,bucket:0}]);
  const context=f.runtime.publicMemory('police');assert.ok(context.some(m=>m.text==='La bibliothèque a réouvert.'&&m.kind==='rumor'&&m.provenance==='rumor'&&m.source==='driver'&&m.visibility==='public'));
  assert.ok(!JSON.stringify(context).includes('SECRET_PLAYER_DETAILS'));assert.ok(f.runtime.publicMemory('driver').some(m=>m.provenance==='server_validated'));
});
