const test=require('node:test');
const assert=require('node:assert/strict');
const {PersistentDatabase}=require('../server/database.js');
const {PersistentPopulation}=require('../server/population.js');
const A={x:0,y:0,z:0};
function fixture(t,config={}){
 const db=new PersistentDatabase(':memory:');t.after(()=>db.close());let now=10000,next=100,createdProfiles=0;
 const entities=new Map(),associated=new Map(),spawns=[],removes=[];let refuseSpawn=false,refuseBind=false,refuseRemove=false;
 const profiles={get:id=>db.get('profiles',id),create:(model,jobId,sex)=>{createdProfiles++;const profile={id:`seed_profile_${createdProfiles}`,model,jobId,sex};db.set('profiles',profile.id,profile);return profile;}};
 const options={db,profiles,config,now:()=>now,players:()=>[{position:A,bucket:0}],
  spawn:(profile,coords)=>{spawns.push({profile,coords});if(refuseSpawn)return null;const entity=++next,netId=entity+1000;entities.set(entity,{exists:true,entity,netId,position:{...coords},bucket:profile.bucket??0,alive:true});return {entity,netId};},
  bind:(netId,id)=>{if(refuseBind)return false;const entity=[...entities.values()].find(e=>e.netId===netId);if(!entity)return false;entity.profileId=id;associated.set(id,entity.entity);return true;},
  exists:binding=>{const entity=entities.get(binding.entity);return !!entity&&entity.netId===binding.netId&&entity.profileId===binding.id;},
  remove:binding=>{removes.push(binding);if(refuseRemove)return false;entities.delete(binding.entity);if(associated.get(binding.id)===binding.entity)associated.delete(binding.id);return true;},
  snapshot:id=>{const entity=entities.get(associated.get(id));return entity?{...entity}:null;}
 };
 let population=new PersistentPopulation(options);
 return {db,profiles,options,entities,associated,spawns,removes,get population(){return population;},get createdProfiles(){return createdProfiles;},advance:ms=>now+=ms,
  failSpawn:v=>refuseSpawn=v,failBind:v=>refuseBind=v,failRemove:v=>refuseRemove=v,
  restart:()=>{entities.clear();associated.clear();population=new PersistentPopulation(options);},
  add:(id,coords=A,binding=null)=>{const profile={id,model:'a_m_y_business_01',jobId:'resident'};db.set('profiles',id,profile);if(binding)entities.set(binding.entity,{exists:true,entity:binding.entity,netId:binding.netId,profileId:id,position:{...coords},bucket:binding.bucket??0,alive:true});return population.register(profile,coords,binding);}
 };
}
test('naturally encountered entities retain stable identity and are never deleted by far culling',t=>{
 const f=fixture(t),record=f.add('known',A,{entity:11,netId:1011});assert.equal(record.incarnation,1);assert.equal(f.population.ownedBindings().length,0);assert.equal(record.routine.length,3);
 f.entities.get(11).position={x:45,y:0,z:0};f.population.tick([{position:{x:1000,y:0,z:0},bucket:0}]);assert.equal(f.removes.length,0);assert.equal(f.population.get('known').lastPosition.x,45);
 f.entities.delete(11);assert.equal(f.population.entityRemoved(11),1);assert.equal(f.population.get('known').alive,true);
 f.population.tick([{position:{x:45,y:0,z:0},bucket:0}]);assert.equal(f.spawns.length,1);assert.equal(f.spawns[0].profile.id,'known');assert.equal(f.spawns[0].coords.x,45);assert.equal(f.population.get('known').incarnation,2);assert.equal(f.population.ownedBindings().length,1);
});
test('managed actors cull only after persisting genuine observed location and retain it on reentry',t=>{
 const f=fixture(t);f.add('managed');f.population.tick();const binding=f.population.ownedBindings()[0];f.entities.get(binding.entity).position={x:60,y:4,z:0};
 const result=f.population.tick([{position:{x:1000,y:0,z:0},bucket:0}]);assert.equal(result.culled,1);assert.equal(f.population.get('managed').lastPosition.x,60);assert.equal(f.population.get('managed').status,'unbound');
 f.advance(16000);f.population.tick([{position:{x:60,y:4,z:0},bucket:0}]);assert.equal(f.spawns.at(-1).coords.x,60);assert.equal(f.spawns.at(-1).profile.id,'managed');
});
test('recycled network IDs cannot bind another profile or count as the original incarnation',t=>{
 const f=fixture(t);f.add('known',A,{entity:11,netId:1011});f.entities.get(11).profileId='different_person';
 const result=f.population.tick();assert.equal(result.spawned,1);assert.equal(f.spawns[0].profile.id,'known');assert.equal(f.entities.has(11),true);assert.equal(f.removes.some(b=>b.entity===11),false);assert.equal(f.population.ownedBindings()[0].netId===1011,false);
});
test('persistent seed mappings create each profile once and preserve actual last positions across restart',t=>{
 const seeds=[0,1,2,3].map(i=>({id:`seed_${i}`,model:'a_m_y_business_01',coords:{x:i,y:0,z:0},bucket:0}));
 const f=fixture(t,{seeds,maxManagedEntities:2,maxSpawnsPerTick:2});assert.equal(f.createdProfiles,4);const first=f.population.tick();assert.equal(first.spawned,2);assert.equal(first.managed,2);
 const binding=f.population.ownedBindings()[0];f.entities.get(binding.entity).position={x:20,y:0,z:0};f.population.tick();const id=binding.id;f.options.config.nearRadius=2;f.restart();assert.equal(f.createdProfiles,4);assert.equal(f.population.get(id).lastPosition.x,20);
 f.advance(16000);const second=f.population.tick([{position:{x:20,y:0,z:0},bucket:0}]);assert.equal(second.spawned,1);assert.equal(second.managed,1);assert.equal(f.spawns.at(-1).profile.id,id);assert.equal(f.spawns.at(-1).coords.x,20);
});
test('spawn attempts, routing buckets and physical population caps are bounded',t=>{
 const f=fixture(t,{maxManagedEntities:3,maxSpawnsPerTick:2});for(let i=0;i<10;i++)f.add(`known_${i}`,{x:i,y:0,z:0});f.add('other_bucket',{...A,bucket:2});
 assert.equal(f.population.tick().spawned,2);f.advance(16000);assert.equal(f.population.tick().spawned,1);assert.equal(f.population.ownedBindings().length,3);f.advance(16000);assert.equal(f.population.tick().spawned,0);
 assert.equal(f.population.get('other_bucket').incarnation,0);assert.ok(f.spawns.every(s=>s.profile.id!=='other_bucket'));
});
test('failed spawn or bind leaves a persistent identity, throttles retries and removes only a created orphan',t=>{
 const f=fixture(t);f.add('known');f.failSpawn(true);assert.equal(f.population.tick().refused,1);assert.equal(f.population.get('known').status,'unbound');assert.equal(f.population.tick().attempted,0);
 f.advance(16000);f.failSpawn(false);f.failBind(true);assert.equal(f.population.tick().refused,1);assert.equal(f.population.ownedBindings().length,0);assert.equal(f.removes.length,1);assert.equal(f.entities.size,0);
 f.advance(16000);f.failBind(false);assert.equal(f.population.tick().spawned,1);assert.equal(f.spawns.at(-1).profile.id,'known');
});
test('an initially refused binding never deletes the naturally encountered entity',t=>{
 const f=fixture(t);f.failBind(true);assert.throws(()=>f.add('known',A,{entity:11,netId:1011}),/refusée/);assert.equal(f.entities.has(11),true);assert.equal(f.removes.length,0);assert.equal(f.population.get('known'),null);
});
test('death persists after removal and restart; default population never resurrects a dead character',t=>{
 const f=fixture(t);f.add('known',A,{entity:11,netId:1011});f.entities.get(11).alive=false;f.population.tick();assert.equal(f.population.get('known').alive,false);
 f.entities.delete(11);f.population.entityRemoved(11);f.advance(1000000);assert.equal(f.population.tick().spawned,0);f.restart();assert.equal(f.population.tick().spawned,0);assert.throws(()=>f.add('known',A,{entity:12,netId:1012}),/résurrection/);
});
test('death respawn requires an explicit configured delay and preserves the same identity',t=>{
 const f=fixture(t,{respawnAfterDeathSeconds:10});f.add('known',A,{entity:11,netId:1011});f.entities.get(11).alive=false;f.population.tick();f.entities.delete(11);f.population.entityRemoved(11);
 f.advance(9000);assert.equal(f.population.tick().spawned,0);f.advance(1000);assert.equal(f.population.tick().spawned,1);assert.equal(f.spawns[0].profile.id,'known');assert.equal(f.population.get('known').deadAt,null);
});
test('failed owned removal prevents duplicate spawning while an existing entity remains',t=>{
 const f=fixture(t);f.add('known');f.population.tick();f.failRemove(true);assert.equal(f.population.tick([{position:{x:1000,y:0,z:0},bucket:0}]).culled,0);assert.equal(f.population.ownedBindings().length,1);f.advance(20000);assert.equal(f.population.tick().spawned,0);assert.equal(f.entities.size,1);
});
test('shutdown never deletes an unrelated entity that recycled a formerly owned binding',t=>{
 const f=fixture(t);f.add('known');f.population.tick();const binding=f.population.ownedBindings()[0];f.entities.get(binding.entity).profileId='another_person';
 f.population.shutdown();assert.equal(f.entities.has(binding.entity),true);assert.equal(f.removes.length,0);
});
test('a resource restart reattaches a surviving natural actor instead of spawning a duplicate',t=>{
 const f=fixture(t);f.add('known',A,{entity:11,netId:1011});const restarted=new PersistentPopulation(f.options);
 const metrics=restarted.tick();assert.equal(metrics.spawned,0);assert.equal(metrics.observed,1);assert.equal(f.spawns.length,0);assert.equal(restarted.ownedBindings().length,0);
 restarted.tick([{position:{x:1000,y:0,z:0},bucket:0}]);assert.equal(f.removes.length,0);assert.equal(f.entities.size,1);
});
