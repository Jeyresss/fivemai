'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PersistentDatabase}=require('../server/database'),{MemoryStore}=require('../server/core'),{PerceptionEngine}=require('../server/perception');
function fixture(config={}){
 let time=100000;const db=new PersistentDatabase(':memory:'),memory=new MemoryStore(null,{db}),events=[],publicEvents=[];
 const actors=new Map([[7,{position:{x:0,y:0,z:0},bucket:0,pedNetId:70,alive:true}],[8,{position:{x:1,y:0,z:0},bucket:0,pedNetId:80,alive:true}]]);
 const npcs=new Map([['victim',{exists:true,position:{x:2,y:0,z:0},bucket:0,netId:101,health:200,alive:true,entity:10,model:123}],['police',{exists:true,position:{x:4,y:0,z:0},bucket:0,netId:102,health:200,alive:true,entity:11,model:456}],['far',{exists:true,position:{x:500,y:0,z:0},bucket:0,netId:103,health:200,alive:true,entity:12,model:789}]]);
 const identity=src=>actors.has(src)?'license:'+src:null;
 const engine=new PerceptionEngine({db,memory,identity,snapshot:src=>actors.get(src),npcSnapshot:id=>npcs.get(id),npcForNetId:id=>[...npcs].find(([,npc])=>npc.netId===id)?.[0],now:()=>time,config,onEvent:event=>events.push(event),onPublic:event=>publicEvents.push(event)});
 return {db,memory,engine,actors,npcs,events,publicEvents,setTime:value=>time=value,close:()=>{engine.stop();db.close();}};
}
const attack=(overrides={})=>({hitGlobalId:101,weaponType:453432689,weaponDamage:30,damageTime:12,...overrides});
test('client observations retain uncertain provenance and never change relationships or sanctions',()=>{
 const f=fixture();try{
  f.engine.sample(['victim']);f.npcs.get('victim').health=170;
  const result=f.engine.observe(7,'victim',{aimed:true,armed:true,hit:true,collision:true,actorSource:7,targetNetId:101,description:'Fausse certitude',relationChanges:{trust:100}});
  assert.equal(result.source,'witnessed_client_corroborated');assert.equal(result.provenance,'observation');assert.equal(result.validated,false);assert.equal(result.sanctionEligible,false);assert.equal(result.healthDrop,30);assert.equal(result.injuryObserved,true);assert.equal(result.description,undefined);assert.equal(f.memory.relation('license:7','victim').trust,0);assert.equal(f.db.count('perception_events'),0);assert.equal(f.events.length,0);assert.deepEqual(f.memory.get('license:7','victim'),[]);
 }finally{f.close();}
});
test('forged actors, targets, cross-bucket and distant telemetry are rejected',()=>{
 const f=fixture();try{
  assert.equal(f.engine.observe(7,'victim',{actorSource:8}),null);assert.equal(f.engine.observe(7,'victim',{targetNetId:999}),null);assert.equal(f.engine.observe(7,'far',{hit:true}),null);
  f.npcs.get('victim').bucket=1;assert.equal(f.engine.observe(7,'victim',{hit:true}),null);f.npcs.get('victim').bucket=0;f.actors.get(7).position.x=NaN;assert.equal(f.engine.observe(7,'victim',{hit:true}),null);
 }finally{f.close();}
});
test('client hit flag without health loss remains an unconfirmed claim',()=>{
 const f=fixture();try{f.engine.sample(['victim']);const result=f.engine.observe(7,'victim',{hit:true});assert.equal(result.hit,false);assert.equal(result.claimedHit,true);assert.equal(result.healthDrop,0);}finally{f.close();}
});
test('native direct damage requires a matching prior health sample and produces one validated event',()=>{
 const f=fixture();try{
  assert.deepEqual(f.engine.weaponDamage(7,attack()),[]);f.engine.sample(['victim']);f.npcs.get('victim').health=170;
  const records=f.engine.weaponDamage(7,attack());assert.equal(records.length,1);const record=records[0];assert.equal(record.type,'assault');assert.equal(record.source,'server_weapon_damage_corroborated');assert.equal(record.certainty,'native_event_and_health_delta');assert.equal(record.healthDrop,30);assert.equal(record.validated,true);assert.equal(record.sanctionEligible,true);assert.equal(record.player,'license:7');assert.deepEqual(record.witnesses,['victim']);
  assert.equal(f.memory.get('license:7','victim')[0].source,record.source);assert.equal(f.memory.get('license:7','victim')[0].provenance,'server_validated');assert.equal(f.memory.relation('license:7','victim').trust,-12);assert.equal(f.events.length,1);assert.equal(f.publicEvents.length,0);
  assert.deepEqual(f.engine.weaponDamage(7,attack()),[]);assert.equal(f.memory.relation('license:7','victim').trust,-12);assert.equal(f.memory.get('license:8','victim').length,0);
 }finally{f.close();}
});
test('native damage waits for replicated health loss and expires uncorroborated events',()=>{
 const f=fixture();try{
  f.engine.sample(['victim']);assert.deepEqual(f.engine.weaponDamage(7,attack()),[]);assert.equal(f.engine.pending.size,1);f.setTime(100500);f.npcs.get('victim').health=160;assert.equal(f.engine.tick().length,1);assert.equal(f.engine.pending.size,0);
  f.engine.sample(['victim']);f.engine.weaponDamage(7,attack({damageTime:13}));f.setTime(102100);assert.deepEqual(f.engine.tick(),[]);assert.equal(f.engine.pending.size,0);assert.equal(f.db.count('perception_events'),1);
 }finally{f.close();}
});
test('damage rejects forged sender, wrong victim, stale health, entity reuse and another bucket',()=>{
 const cases=[
  f=>f.engine.weaponDamage(7,attack({actorSource:8})),
  f=>f.engine.weaponDamage(7,attack({actorNetId:80})),
  f=>f.engine.weaponDamage(7,attack({hitGlobalId:999})),
  f=>{f.setTime(103000);return f.engine.weaponDamage(7,attack());},
  f=>{f.npcs.get('victim').entity=99;return f.engine.weaponDamage(7,attack());},
  f=>{f.npcs.get('victim').bucket=1;return f.engine.weaponDamage(7,attack());},
  f=>{f.actors.get(7).position.x=1000;return f.engine.weaponDamage(7,attack());},
  f=>f.engine.weaponDamage(7,attack({weaponDamage:-100})),
  f=>f.engine.weaponDamage(7,attack({weaponDamage:Infinity}))
 ];
 for(const action of cases){const f=fixture();try{f.engine.sample(['victim']);f.npcs.get('victim').health=170;assert.deepEqual(action(f),[]);assert.equal(f.db.count('perception_events'),0);assert.equal(f.memory.relation('license:7','victim').trust,0);}finally{f.close();}}
});
test('one replicated health drop cannot corroborate multiple distinct damage claims',()=>{
 const f=fixture();try{f.engine.sample(['victim']);f.engine.weaponDamage(7,attack());f.engine.weaponDamage(7,attack({damageTime:13}));f.npcs.get('victim').health=170;assert.equal(f.engine.tick().length,1);assert.equal(f.db.count('perception_events'),1);assert.equal(f.memory.relation('license:7','victim').trust,-12);}finally{f.close();}
});
test('trusted injury, collision, arrest and service effects apply only to selected nearby witnesses',()=>{
 const f=fixture();try{
  for(const type of ['injury','collision','arrest','service']){
   const record=f.engine.publish({id:type,actorSource:7,npcId:'victim',type,description:'Événement serveur: '+type},{witnesses:['victim','police','far','missing','victim']});assert.deepEqual(record.witnesses,['victim','police']);assert.equal(record.visibility,'private');
  }
  assert.equal(f.memory.get('license:7','victim').length,4);assert.equal(f.memory.get('license:7','police').length,4);assert.equal(f.memory.get('license:7','far').length,0);assert.equal(f.memory.get('license:8','victim').length,0);assert.equal(f.memory.relation('license:7','victim').trust,-15);assert.equal(f.publicEvents.length,0);
  assert.equal(f.engine.publish({id:'service',actorSource:7,npcId:'victim',type:'service',description:'Retry'},{witnesses:['victim']}).id,'service');assert.equal(f.memory.relation('license:7','victim').trust,-15);assert.equal(f.events.length,4);
 }finally{f.close();}
});
test('public gossip requires explicit trusted visibility and never publishes a private conversation',()=>{
 const f=fixture();try{
  f.engine.publish({id:'private',actorSource:7,npcId:'victim',type:'service',description:'Service privé.'},{witnesses:['victim']});assert.equal(f.publicEvents.length,0);
  f.engine.publish({id:'public',actorSource:7,npcId:'victim',type:'service',description:'Livraison publique.',visibility:'public'},{witnesses:['victim']});assert.equal(f.publicEvents.length,1);assert.equal(f.publicEvents[0].source,'server_public');assert.equal(f.publicEvents[0].description,'Livraison publique.');assert.equal(f.memory.get('world','victim').length,0);
  f.engine.observe(7,'victim',{description:'Conversation privée.',visibility:'public'});assert.equal(f.publicEvents.length,1);
 }finally{f.close();}
});
test('invalid trusted event witness radius, identity and line of sight cannot authorize memories',()=>{
 const f=fixture();try{
  const base={actorSource:7,npcId:'victim',type:'injury',description:'Observation.'};
  assert.equal(f.engine.publish({...base,player:'license:8'},{witnesses:['victim']}),null);assert.equal(f.engine.publish({...base,radius:Infinity},{witnesses:['victim']}),null);assert.equal(f.engine.publish({...base,radius:9999},{witnesses:['victim']}),null);
  f.npcs.get('police').lineOfSight=false;assert.equal(f.engine.publish(base,{witnesses:['police']}),null);f.npcs.get('victim').bucket=1;assert.equal(f.engine.publish(base,{witnesses:['victim']}),null);assert.equal(f.db.count('perception_events'),0);
 }finally{f.close();}
});
test('relation failure rolls back event and memory together',()=>{
 const f=fixture();try{assert.throws(()=>f.engine.publish({id:'invalid',actorSource:7,npcId:'victim',type:'service',description:'Invalid delta.',relationChanges:{sanction:100}},{witnesses:['victim']}),/field/);assert.equal(f.db.get('perception_events','invalid'),null);assert.deepEqual(f.memory.get('license:7','victim'),[]);assert.equal(f.events.length,0);}finally{f.close();}
});
test('sample, pending and durable event budgets are bounded',()=>{
 const f=fixture({maxSamples:2,maxPending:2,maxEvents:2});try{
  f.engine.sample(['victim','police','far']);assert.equal(f.engine.samples.size,2);f.engine.sample(['victim']);f.engine.weaponDamage(7,attack());f.engine.weaponDamage(7,attack({damageTime:13}));f.engine.weaponDamage(7,attack({damageTime:14}));assert.equal(f.engine.pending.size,2);
  for(let i=0;i<3;i++)f.engine.publish({id:'event'+i,actorSource:7,npcId:'victim',type:'service',description:'Événement '+i},{witnesses:['victim']});assert.equal(f.db.count('perception_events'),2);f.engine.forget(7);assert.equal(f.engine.pending.size,0);
 }finally{f.close();}
});

test('default weapon damage amount and signed weapon hashes still require actual injury',()=>{
 const f=fixture();try{f.engine.sample(['victim']);f.npcs.get('victim').health=185;assert.equal(f.engine.weaponDamage(7,attack({weaponDamage:0,weaponType:-1786099057,hitGlobalIds:[]})).length,1);}finally{f.close();}
});
test('healed NPCs can receive a fresh corroborated injury without reusing previous damage',()=>{
 const f=fixture();try{
  f.engine.sample(['victim']);f.npcs.get('victim').health=170;assert.equal(f.engine.weaponDamage(7,attack()).length,1);
  f.npcs.get('victim').health=200;f.engine.sample(['victim']);f.npcs.get('victim').health=190;assert.equal(f.engine.weaponDamage(7,attack({damageTime:13})).length,1);assert.equal(f.events[1].healthDrop,10);
 }finally{f.close();}
});
test('uncertain client source cannot be promoted through trusted publish accidentally',()=>{
 const f=fixture();try{assert.equal(f.engine.publish({id:'claim',actorSource:7,npcId:'victim',type:'assault',description:'Client claim.',source:'witnessed_client_corroborated',sanctionEligible:true},{witnesses:['victim']}),null);assert.equal(f.db.count('perception_events'),0);}finally{f.close();}
});

test('an immediately preceding sample corroborates a native event arriving after health replication',()=>{
 const f=fixture();try{f.engine.sample(['victim']);f.setTime(100100);f.npcs.get('victim').health=170;f.engine.sample(['victim']);assert.equal(f.engine.weaponDamage(7,attack()).length,1);assert.equal(f.events[0].healthDrop,30);}finally{f.close();}
});
