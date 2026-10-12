const {test}=require('node:test'),assert=require('node:assert/strict');
const {NPCActionManager}=require('../server/actions');
function fixture({armed=false,aimed=true,at=10000,behavior='calm',threshold=0.3,config={},inspect}={}){
 const sent=[],timers=[],changes=[],memories=[];
 const ctx={src:7,session:{npc:{id:'npc-a',jobId:'resident',surrenderThreshold:threshold},behavior}};
 const m=new NPCActionManager({config,inspect:inspect||(()=>({armed,aimed,at})),send:(...args)=>sent.push(args),changed:s=>changes.push(s.actionState),remember:(...args)=>memories.push(args),now:()=>10000,schedule:fn=>{timers.push(fn);return timers.length;},cancelTimer:()=>{}});
 return {m,ctx,sent,timers,changes,memories,token:()=>sent.find(e=>e[1]==='fivemai:actionStart')[2].token};
}
test('hands-up waits for actual client confirmation and associates it with the requesting player',async()=>{
 const f=fixture(),result=f.m.execute('npc_action',f.ctx,{action:'hands_up'});
 assert.equal(f.ctx.session.actionState,undefined);assert.equal(f.memories.length,0);
 assert.equal(f.m.result(8,f.token(),true),false);assert.equal(f.m.result(7,'fake',true),false);
 assert.equal(f.m.result(7,f.token(),true),true);assert.equal((await result).completed,true);assert.equal(f.ctx.session.actionState,'hands_up');assert.equal(f.memories.length,1);
 assert.equal(f.m.result(7,f.token(),true),false);
});
test('hands-up requires fresh direct weapon aim, not remembered fear',async()=>{
 for(const options of [{aimed:false},{at:7000}]){const f=fixture(options);await assert.rejects(f.m.execute('npc_action',f.ctx,{action:'hands_up'}),/réellement braquer/);assert.equal(f.sent.length,0);}
});
test('armed characters can resist surrender and configured temperaments still apply when armed surrender is enabled',async()=>{
 for(const options of [{armed:true},{armed:true,threshold:0.95,config:{allowArmedSurrender:true}}]){const f=fixture(options),result=await f.m.execute('npc_action',f.ctx,{action:'hands_up'});assert.equal(result.refused,true);assert.equal(f.sent.length,0);}
});
test('the same threat produces the same surrender disposition regardless of sex',async()=>{
 for(const sex of ['male','female']){const f=fixture();f.ctx.session.npc.sex=sex;const p=f.m.execute('npc_action',f.ctx,{action:'hands_up'});f.m.result(7,f.token(),true);assert.equal((await p).ok,true);}
});
test('timeout never records or announces an unconfirmed action',async()=>{
 const f=fixture(),p=f.m.execute('npc_action',f.ctx,{action:'hands_up'});f.timers[0]();assert.equal((await p).ok,false);assert.equal(f.memories.length,0);assert.equal(f.m.pending.size,0);assert.equal(f.sent.at(-1)[1],'fivemai:actionCancel');
});
test('stopping a conversation resolves pending actions and releases active tasks',async()=>{
 const f=fixture(),p=f.m.execute('npc_action',f.ctx,{action:'follow'});f.m.stop(f.ctx.session);assert.equal((await p).ok,false);
 const q=f.m.execute('npc_action',f.ctx,{action:'follow'}),token=f.sent.filter(e=>e[1]==='fivemai:actionStart').at(-1)[2].token;f.m.result(7,token,true);assert.equal((await q).started,true);f.m.stop(f.ctx.session);assert.equal(f.ctx.session.actionState,null);assert.equal(f.m.running.size,0);
});
test('parallel actions, unavailable job tools and invalid action names are rejected',async()=>{
 const f=fixture(),p=f.m.execute('npc_action',f.ctx,{action:'follow'});
 await assert.rejects(f.m.execute('npc_action',f.ctx,{action:'hands_up'}),/déjà/);f.m.stop(f.ctx.session);await p;
 await assert.rejects(f.m.execute('driver_trip',f.ctx,{destination:'garage'}),/indisponible/);
 await assert.rejects(f.m.execute('npc_action',f.ctx,{action:'attack_player'}),/inconnue/);
});
test('a frightened or fighting actor does not resume friendly following',async()=>{
 const f=fixture({behavior:'angry'});await assert.rejects(f.m.execute('npc_action',f.ctx,{action:'follow'}),/peur ou se bat/);
});
test('multiple vehicles return a plate question without starting an action',async()=>{
 const f=fixture({inspect:()=>({needsPlate:true,candidates:[{plate:'AA'},{plate:'BB'}]})});const r=await f.m.execute('npc_action',f.ctx,{action:'enter_vehicle'});assert.equal(r.needsPlate,true);assert.equal(f.sent.length,0);
});
test('driver tool is restricted to drivers and a confirmed departure is not an arrival',async()=>{
 const f=fixture({inspect:()=>({vehicleNetId:44,plate:'AA',destination:{label:'Garage',x:1,y:2,z:3}})});f.ctx.session.npc.jobId='driver';
 const p=f.m.execute('driver_trip',f.ctx,{destination:'garage'});f.m.result(7,f.token(),true);const r=await p;assert.equal(r.started,true);assert.equal(r.completed,false);assert.match(r.instruction,/pas.*arrivé/);assert.equal(f.m.ended(8,f.token(),'arrived'),false);assert.equal(f.m.ended(7,f.token(),'arrived'),true);
});
test('disabled actions expose no tools',()=>{assert.deepEqual(fixture({config:{enabled:false}}).m.tools('driver'),[]);});

test('release can cancel preparation immediately instead of waiting for its timeout',async()=>{
 const f=fixture(),p=f.m.execute('npc_action',f.ctx,{action:'follow'});const r=await f.m.execute('npc_action',f.ctx,{action:'release'});assert.equal(r.cancellationRequested,true);assert.equal(r.completed,false);assert.equal((await p).ok,false);assert.equal(f.m.pending.size,0);
});

test('release of an active posture waits for its client end acknowledgement',async()=>{
 const f=fixture(),p=f.m.execute('npc_action',f.ctx,{action:'hands_up'});f.m.result(7,f.token(),true);await p;
 let finished=false;const release=f.m.execute('npc_action',f.ctx,{action:'release'}).then(r=>{finished=true;return r;});await Promise.resolve();assert.equal(finished,false);assert.equal(f.ctx.session.actionState,'hands_up');f.m.ended(7,f.token(),'released');assert.equal((await release).completed,true);assert.equal(f.ctx.session.actionState,null);
});
test('an unconfirmed release times out instead of claiming the NPC has stopped',async()=>{
 const f=fixture(),p=f.m.execute('npc_action',f.ctx,{action:'follow'});f.m.result(7,f.token(),true);await p;const r=f.m.execute('npc_action',f.ctx,{action:'release'});f.timers.at(-1)();assert.equal((await r).ok,false);
});

test('loss of entity control cannot be reported as a successful release',async()=>{
 const f=fixture(),p=f.m.execute('npc_action',f.ctx,{action:'hands_up'});f.m.result(7,f.token(),true);await p;const r=f.m.execute('npc_action',f.ctx,{action:'release'});f.m.ended(7,f.token(),'control');assert.equal((await r).ok,false);
});
