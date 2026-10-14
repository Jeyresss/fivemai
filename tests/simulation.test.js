const test=require('node:test');
const assert=require('node:assert/strict');
const {PersistentDatabase}=require('../server/database.js');
const {CitySimulation}=require('../server/simulation.js');
const A={x:0,y:0,z:0},B={x:20,y:0,z:0};
function fixture(t,count=3,config={}){
 const db=new PersistentDatabase(':memory:');t.after(()=>db.close());let now=10000,minute=600;const sent=[],rumors=[],snapshots=new Map();
 const characters=Array.from({length:count},(_,i)=>({id:`npc_${i}`,coords:{x:i,y:0,z:0},routine:[{id:'work',start:0,end:1000,destination:B,scenario:'WORLD_HUMAN_CLIPBOARD'},{id:'night',start:1000,end:1440,destination:A}]}));
 characters.forEach((npc,i)=>snapshots.set(npc.id,{exists:true,alive:true,bucket:0,netId:i+10,position:{x:i,y:0,z:0}}));
 const simulation=new CitySimulation({db,characters,npcSnapshot:id=>snapshots.get(id),dispatch:(src,data)=>sent.push({src,data}),onRumor:(id,data)=>rumors.push({id,data}),now:()=>now,minuteOfDay:()=>minute,config});
 return {db,simulation,sent,rumors,snapshots,characters,advance:n=>now+=n,minute:n=>minute=n,players:[{src:1,player:'license:one',position:A,bucket:0}]};
}
test('detail and physical task budgets stay bounded across 128 players and 200 NPCs',t=>{
 const f=fixture(t,200,{nearRadius:1000,maxDetailed:40,perPlayer:8,maxDispatchPerTick:5});
 const players=Array.from({length:128},(_,i)=>({src:i+1,player:`license:${i}`,position:{x:i*2,y:0,z:0},bucket:0}));
 const result=f.simulation.tick(players);assert.equal(result.players,128);assert.equal(result.characters,200);assert.ok(result.detailed<=40);assert.equal(result.dispatches,5);
 assert.ok(f.sent.every(s=>s.data.task==='walk'));assert.ok(f.sent.every(s=>!Object.hasOwn(s.data,'teleport')));
});
test('far timeline persists logical schedules without changing authoritative entity coordinates',t=>{
 const f=fixture(t);f.simulation.tick([]);const physical=JSON.stringify([...f.snapshots]);
 assert.equal(f.simulation.state('npc_0').phase,'work');f.minute(1200);f.advance(70000);const metrics=f.simulation.tick([]);
 assert.equal(metrics.dispatches,0);assert.equal(metrics.detailed,0);assert.equal(f.simulation.state('npc_0').phase,'night');assert.equal(JSON.stringify([...f.snapshots]),physical);
 const resumed=new CitySimulation({db:f.db,characters:f.characters,npcSnapshot:id=>f.snapshots.get(id)});assert.equal(resumed.state('npc_0').phase,'night');
});
test('conversation, mission, action and danger priorities interrupt routine tasks',t=>{
 const f=fixture(t,1);f.simulation.tick(f.players);assert.equal(f.sent.length,1);
 f.simulation.setPriority('npc_0','conversation',true);assert.equal(f.sent.at(-1).data.task,'cancel');f.advance(20000);assert.equal(f.simulation.tick(f.players).dispatches,0);
 f.simulation.setPriority('npc_0','mission',true);f.simulation.setPriority('npc_0','conversation',false);assert.equal(f.simulation.tick(f.players).dispatches,0);
 f.simulation.setPriority('npc_0','mission',false);assert.equal(f.simulation.tick(f.players).dispatches,1);
 f.simulation.setPriority('npc_0','flee',true);assert.equal(f.simulation.priority('npc_0'),10);assert.equal(f.simulation.tick(f.players).dispatches,0);
});
test('routing buckets and server positions gate executors and forged task results',t=>{
 const f=fixture(t,1);f.simulation.tick([{...f.players[0],bucket:2}]);assert.equal(f.sent.length,0);
 f.simulation.tick(f.players);const token=f.sent[0].data.token;assert.equal(f.simulation.result(2,token,true,'arrived'),false);assert.equal(f.simulation.result(1,'invented',true,'arrived'),false);assert.equal(f.simulation.result(1,token,true,'arrived'),false);
 f.snapshots.get('npc_0').position={...B};assert.equal(f.simulation.result(1,token,true,'arrived'),true);
 f.snapshots.get('npc_0').netId=99;assert.equal(f.simulation.result(1,token,true,'arrived'),false);
});
test('source-labelled public rumors exchange only once per encounter and reject private conversation',t=>{
 const f=fixture(t,2);f.simulation.tick([]);
 assert.equal(f.simulation.recordPublicEvent({id:'private',visibility:'private',source:'server_public',description:'Secret',witnesses:['npc_0']}),false);
 assert.equal(f.simulation.recordPublicEvent({id:'conversation',visibility:'public',source:'conversation',description:'Private talk',witnesses:['npc_0']}),false);
 assert.equal(f.simulation.recordPublicEvent({id:'public',visibility:'public',source:'mission',description:'Une livraison est arrivée au garage.',witnesses:['npc_0']}),true);
 const result=f.simulation.tick(f.players);assert.equal(result.encounters,1);assert.equal(f.rumors.length,1);assert.equal(f.rumors[0].id,'npc_1');assert.equal(f.rumors[0].data.kind,'rumor');assert.equal(f.rumors[0].data.heardFrom,'npc_0');assert.match(f.rumors[0].data.text,/source mission/);
 f.simulation.tick(f.players);assert.equal(f.rumors.length,1);f.advance(100000);f.simulation.tick(f.players);assert.equal(f.rumors.length,1);
});
test('NPC arrival switches physical routine from pathing to configured scenario without moving it',t=>{
 const f=fixture(t,1);f.simulation.tick(f.players);assert.equal(f.sent.at(-1).data.task,'walk');f.snapshots.get('npc_0').position={...B};f.simulation.tick(f.players);assert.equal(f.sent.at(-1).data.task,'scenario');assert.equal(f.sent.at(-1).data.scenario,'WORLD_HUMAN_CLIPBOARD');
});
