const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PersistentDatabase}=require('../server/database.js');
const {StandaloneEconomy}=require('../server/economy.js');
const {MissionEngine,validateDefinition}=require('../server/missions.js');
const {DEFAULT_MISSIONS}=require('../server/content.js');
const A={x:0,y:0,z:0},B={x:100,y:0,z:0};
function fixture(t,definitions){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-missions-')),file=path.join(directory,'state.sqlite');
 let db=new PersistentDatabase(file),now=10000;const people=new Map([[1,{position:{...A},bucket:0,alive:true}],[2,{position:{...A},bucket:0,alive:true}]]),npcs=new Map([['giver',{exists:true,alive:true,bucket:0,position:{...A},netId:10}]]),vehicles=new Map(),starts=[],stops=[];
 let economy,engine;
 const build=()=>{economy=new StandaloneEconomy({db,now:()=>now});engine=new MissionEngine({db,economy,definitions,snapshot:src=>people.get(src),npcSnapshot:id=>npcs.get(id),vehicleSnapshot:id=>vehicles.get(id),startObjective:(ctx,run,step)=>starts.push({ctx,run,step}),stopObjective:run=>stops.push(run.id),now:()=>now});};build();
 t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
 return {get db(){return db;},get economy(){return economy;},get engine(){return engine;},people,npcs,vehicles,starts,stops,ctx:{src:1,player:'license:one',session:{npc:{id:'giver'}}},advance:n=>now+=n,reopen:()=>{db.close();db=new PersistentDatabase(file);build();}};
}
function definition(stages,extra={}){return {id:'test',npcId:'giver',title:'Mission',reward:{money:75},social:{trust:2,reputation:1},deadlineSeconds:60,stages,...extra};}
async function accept(f,ctx=f.ctx){const offer=await f.engine.execute('mission_offer',ctx,{missionId:'test'});return f.engine.execute('mission_accept',ctx,{offerId:offer.offerId,confirmed:true});}
const tick=f=>f.engine.tick([{src:1,player:'license:one'}]);
test('mission content is finite, complete and rejects invented predicates',()=>{
 assert.ok(DEFAULT_MISSIONS.length>=5);assert.ok(new Set(DEFAULT_MISSIONS.map(m=>m.npcId)).size>=4);
 for(const def of DEFAULT_MISSIONS)assert.doesNotThrow(()=>validateDefinition(def));
 assert.throws(()=>validateDefinition(definition([{type:'model_says_complete',destination:A}])),/Objectif/);
});
test('offers are bound to server identity, giver, proximity and explicit agreement',async t=>{
 const f=fixture(t,[definition([{type:'visit',destination:B}])]);
 const offer=await f.engine.execute('mission_offer',f.ctx,{missionId:'test',reward:{money:999999}});
 assert.equal(offer.reward.money,75);
 await assert.rejects(f.engine.execute('mission_accept',{...f.ctx,src:2,player:'license:two'},{offerId:offer.offerId,confirmed:true}),/Proposition/);
 await assert.rejects(f.engine.execute('mission_accept',f.ctx,{offerId:offer.offerId,confirmed:false}),/accord/);
 f.people.get(1).bucket=4;
 await assert.rejects(f.engine.execute('mission_accept',f.ctx,{offerId:offer.offerId,confirmed:true}),/près/);
 f.people.get(1).bucket=0;await f.engine.execute('mission_accept',f.ctx,{offerId:offer.offerId,confirmed:true});
 await assert.rejects(f.engine.execute('mission_complete',f.ctx,{completed:true}),/outil/);
 await assert.rejects(f.engine.execute('mission_accept',f.ctx,{offerId:offer.offerId,confirmed:true}),/Proposition/);
});
test('delivery escrow survives restart and completed rewards cannot replay',async t=>{
 const f=fixture(t,[definition([{type:'pickup',destination:A,items:{sealed_parcel:1}},{type:'delivery',destination:B,items:{sealed_parcel:1}},{type:'visit',npcId:'giver'}])]);
 const accepted=await accept(f);await tick(f);assert.equal(f.engine.status('license:one').progress,1);
 assert.deepEqual(await f.economy.inventory('license:one'),{});assert.equal(f.db.get('item_reservations',f.engine.current('license:one').cargo.escrowId).status,'reserved');
 f.reopen();assert.equal((await f.economy.recover()).items,0);assert.equal(f.engine.recover().resumed,1);
 await f.engine.tick([]);assert.equal(f.engine.status('license:one').progress,1);
 f.people.get(1).position={...B};await tick(f);assert.equal(f.engine.status('license:one').progress,2);
 f.people.get(1).position={...A};await tick(f);assert.equal((await f.economy.getWallet('license:one')).balance,1075);
 assert.equal(f.db.get('mission_runs',accepted.id).status,'completed');assert.equal(f.engine.standings('license:one','giver').trust,2);
 await tick(f);await tick(f);assert.equal((await f.economy.getWallet('license:one')).balance,1075);
 const replay=await f.economy.reward('license:one',`mission-reward:${accepted.id}`,{money:75},{kind:'mission',missionId:accepted.id,definitionId:'test'});assert.equal(replay.duplicate,true);
 await assert.rejects(f.engine.execute('mission_offer',f.ctx,{missionId:'test'}),/déjà terminée/);
});
test('final objective, payment and reputation roll back together if a transaction fails',async t=>{
 const f=fixture(t,[definition([{type:'visit',destination:B}])]);await accept(f);f.people.get(1).position={...B};
 const original=f.economy.rewardInTransaction.bind(f.economy);f.economy.rewardInTransaction=()=>{throw new Error('disk_full');};
 await assert.rejects(tick(f),/disk_full/);assert.equal(f.engine.status('license:one').progress,0);assert.equal(f.engine.status('license:one').active,true);assert.equal(f.engine.standings('license:one','giver').trust,0);
 f.economy.rewardInTransaction=original;await tick(f);assert.equal((await f.economy.getWallet('license:one')).balance,1075);
});
test('repair requires the selected real damaged vehicle and a trusted verified effect',async t=>{
 const f=fixture(t,[definition([{type:'select_vehicle',destination:A,maxEngineHealth:800},{type:'repair',npcId:'giver',minEngineHealth:900}])]);
 const vehicle={exists:true,netId:20,plate:'TEST',model:123,position:{...A},engineHealth:500};f.vehicles.set(20,vehicle);f.people.get(1).vehicle=vehicle;
 await accept(f);await tick(f);assert.equal(f.engine.status('license:one').progress,1);
 const evidence={type:'mechanic_repair',player:'license:one',npcId:'giver',vehicleNetId:20,operationId:'trusted-job'};
 assert.equal(f.engine.trustedEvent({...evidence,player:'license:other'}),false);assert.equal(f.engine.trustedEvent({...evidence,vehicleNetId:21}),false);assert.equal(f.engine.trustedEvent(evidence),false);
 await tick(f);assert.equal(f.engine.status('license:one').active,true);
 vehicle.engineHealth=1000;assert.equal(f.engine.trustedEvent(evidence),true);f.people.get(1).vehicle=null;await tick(f);assert.equal((await f.economy.getWallet('license:one')).balance,1075);
});
test('unfinished repair reselects entity after restart to prevent recycled network ID claims',async t=>{
 const f=fixture(t,[definition([{type:'select_vehicle',destination:A,maxEngineHealth:800},{type:'repair',npcId:'giver',minEngineHealth:900}])]);
 const vehicle={exists:true,netId:20,plate:'TEST',model:123,position:{...A},engineHealth:500};f.vehicles.set(20,vehicle);f.people.get(1).vehicle=vehicle;
 await accept(f);await tick(f);assert.equal(f.engine.status('license:one').progress,1);f.reopen();f.engine.recover();assert.equal(f.engine.status('license:one').progress,0);assert.equal(f.engine.current('license:one').vehicle,null);
});
test('verified repair effect and completion notifications recover across the crash window',async t=>{
 const f=fixture(t,[definition([{type:'select_vehicle',destination:A,maxEngineHealth:800},{type:'repair',npcId:'giver',minEngineHealth:900}])]);
 const vehicle={exists:true,netId:20,plate:'TEST',model:123,position:{...A},engineHealth:500};f.vehicles.set(20,vehicle);f.people.get(1).vehicle=vehicle;
 const accepted=await accept(f);await tick(f);vehicle.engineHealth=1000;
 assert.equal(f.engine.trustedEvent({type:'mechanic_repair',player:'license:one',npcId:'giver',vehicleNetId:20,operationId:'trusted-job'}),true);
 f.reopen();f.vehicles.delete(20);f.people.get(1).vehicle=null;f.engine.recover();assert.equal(f.db.get('mission_runs',accepted.id).status,'completed');assert.equal((await f.economy.getWallet('license:one')).balance,1075);
 let notifications=0;f.engine.onCompleted=()=>{notifications++;throw new Error('temporary_notification_failure');};await tick(f);assert.equal(notifications,1);assert.ok(f.db.get('mission_notifications',accepted.id));
 f.engine.onCompleted=()=>{notifications++;};await tick(f);assert.equal(notifications,2);assert.equal(f.db.get('mission_notifications',accepted.id),null);await tick(f);assert.equal(notifications,2);assert.equal((await f.economy.getWallet('license:one')).balance,1075);
});
test('passenger transport checks NPC vehicle, driver and routing bucket rather than arrival claims',async t=>{
 const f=fixture(t,[definition([{type:'transport',npcId:'giver',destination:B}])]);await accept(f);assert.equal(f.starts.length,1);
 const p=f.people.get(1),n=f.npcs.get('giver');p.position={...B};n.position={...B};p.vehicle={netId:20,driver:true};n.vehicleNetId=21;
 await tick(f);assert.equal(f.engine.status('license:one').active,true);n.vehicleNetId=20;p.vehicle.driver=false;await tick(f);assert.equal(f.engine.status('license:one').active,true);
 p.vehicle.driver=true;n.bucket=1;await tick(f);assert.equal(f.engine.status('license:one').active,true);n.bucket=0;await tick(f);assert.equal((await f.economy.getWallet('license:one')).balance,1075);
});
test('an executor that never acknowledges entry cannot stall the city mission tick',async t=>{
 const f=fixture(t,[definition([{type:'transport',npcId:'giver',destination:B}])]);
 f.engine.startObjective=()=>new Promise(()=>{});
 const accepted=await accept(f);assert.equal(accepted.active,true);const metrics=await tick(f);assert.equal(metrics.active,1);assert.equal(metrics.completed,0);
});
test('continuous dwell resets on disconnection and a dead escort fails without reward',async t=>{
 const f=fixture(t,[definition([{type:'escort',npcId:'giver',destination:B,dwellSeconds:3}])]);await accept(f);f.people.get(1).position={...B};f.npcs.get('giver').position={...B};
 await tick(f);f.advance(2000);await tick(f);assert.equal(f.engine.current('license:one').dwellMs,2000);await f.engine.tick([]);assert.equal(f.engine.current('license:one').dwellMs,0);
 f.npcs.get('giver').alive=false;await tick(f);assert.equal(f.engine.status('license:one').active,false);assert.equal((await f.economy.getWallet('license:one')).balance,1000);
});
test('abandon and deadline dispose of sealed mission cargo without reward or inventory duplication',async t=>{
 const f=fixture(t,[definition([{type:'pickup',destination:A,items:{parcel:1}},{type:'delivery',destination:B,items:{parcel:1}}])]);
 await accept(f);await tick(f);const escrow=f.engine.current('license:one').cargo.escrowId;
 await f.engine.execute('mission_abandon',f.ctx,{confirmed:true});assert.equal(f.db.get('item_reservations',escrow).status,'captured');assert.deepEqual(await f.economy.inventory('license:one'),{});
 await accept(f);await tick(f);f.advance(61000);await f.engine.tick([]);assert.equal(f.engine.status('license:one').active,false);assert.equal((await f.economy.getWallet('license:one')).balance,1000);
});
