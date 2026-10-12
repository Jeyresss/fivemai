const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function server({near=true,key='',fetchImpl,entityVisible=true,profileError,now=()=>Date.now(),vehicles=[]}={}){
 const handlers={},sent=[],saved=[],warnings=[],stateIds=new Map(),storedProfiles=new Map();
 const resourceRoot=path.resolve(__dirname,'..');
 const rootRequire=require('node:module').createRequire(path.join(resourceRoot,'dummy.js'));
 const context={Date:{now},require:id=>id==='node:module'?{createRequire:file=>{
   const load=require('node:module').createRequire(file);
   return name=>{const loaded=load(name);return name==='./server/core.js'?{...loaded,MemoryStore:class{get(){return [];}add(...args){saved.push(args);}}}:name==='./server/profiles.js'?{ProfileStore:class{get(id){return storedProfiles.get(id);}create(model){if(profileError!==undefined)throw profileError;const p={id:'npc_'+(storedProfiles.size+1),firstName:'Alex',lastName:'Morel',model,jobId:'resident',job:'Habitant',voice:'cedar'};storedProfiles.set(p.id,p);return p;}}}:loaded;};
 }}:rootRequire(id),
 GetResourcePath:()=>path.resolve(__dirname,'..'),GetCurrentResourceName:()=> 'fivemai',GetConvar:()=>key,
 GetPlayerPed:()=>1,getPlayers:()=>['7'],NetworkGetEntityFromNetworkId:id=>id===101?(entityVisible?200:0):id===102?1:0,DoesEntityExist:()=>true,GetEntityType:()=>1,GetEntityHealth:()=>100,GetEntityRoutingBucket:entity=>vehicles.find(v=>v.entity===entity)?.bucket||0,GetEntityModel:entity=>vehicles.find(v=>v.entity===entity)?.model||123,GetHashKey:()=>456,Entity:entity=>({state:{get fivemai_profile_id(){return stateIds.get(entity);},set(key,value){stateIds.set(entity,value);}}}),
 GetAllVehicles:()=>vehicles.map(v=>v.entity),NetworkGetNetworkIdFromEntity:entity=>vehicles.find(v=>v.entity===entity)?.netId||0,GetVehicleNumberPlateText:entity=>vehicles.find(v=>v.entity===entity)?.plate||'',
 GetPlayerRoutingBucket:()=>0,GetEntityCoords:entity=>vehicles.find(v=>v.entity===entity)?.coords||(near?[-341.7,-133.5,39]:[0,0,0]),getPlayerIdentifiers:()=>['license:test'],
 onNet:(n,h)=>handlers[n]=h,on:()=>{},emitNet:(...args)=>sent.push(args),exports:(n,h)=>handlers[n]=h,
 setInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{},console:{log:()=>{},warn:message=>warnings.push(message)},fetch:fetchImpl||(()=>{throw new Error('Unexpected network');}),FormData,Blob,AbortSignal};
 context.global=context;context.source=7;const sandbox=vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../server/index.js'),'utf8'),sandbox);
 return {handlers,sent,saved,warnings,stateIds,inspectVehicle:selection=>{context.testSelection=selection||{};return vm.runInContext('if(!global.testSession){global.testSession={npc:config.npcs[0]};active.set(7,global.testSession);}inspectVehicle({src:7,session:global.testSession},testSelection)',sandbox);}};
}
test('server rejects distant SDP before any API call',async()=>{
 const s=server({near:false,key:'not-used'});await s.handlers['fivemai:offer']('marcel_dubois','v=0\r\n');assert.equal(s.sent[0][0],'fivemai:error');assert.match(s.sent[0][2],/inaccessible/);
});
test('server reports missing key without attempting an API call',async()=>{
 const s=server();await s.handlers['fivemai:offer']('marcel_dubois','v=0\r\n');assert.match(s.sent[0][2],/clé OpenAI/);
});
test('only a server export records gameplay, scoped to named witnesses',()=>{
 const s=server();assert.equal(s.handlers['fivemai:memory'],undefined);assert.equal(s.handlers.RecordEvent(7,{description:'Marcel a vu le vol.',witnesses:['marcel_dubois','marcel_dubois','unknown']}),true);assert.equal(s.saved.length,1);assert.deepEqual(s.saved[0],['license:test','marcel_dubois','game_event','Marcel a vu le vol.']);
});

test('server loads dependencies from the resource root like FiveM',()=>{
 const s=server();assert.equal(typeof s.handlers['fivemai:offer'],'function');assert.equal(typeof s.handlers.RecordEvent,'function');
});

test('call request uses text form fields and API rejection logs a redacted reason',async()=>{
 let called=0;
 const s=server({key:'private-test-key',fetchImpl:async(url,options)=>{
   called++;assert.equal(url,'https://api.openai.com/v1/realtime/calls');
   assert.equal(options.body.get('sdp'),'v=0\r\n');
   assert.equal(typeof options.body.get('session'),'string');
   assert.equal(JSON.parse(options.body.get('session')).model,'gpt-realtime');
   const encoded=await new Request(url,{method:'POST',body:options.body}).text();
   assert.doesNotMatch(encoded,/filename=/);
   return {ok:false,status:400,json:async()=>({error:{code:'invalid_request_error',param:'session',message:'Invalid session private-test-key sk-exampleToken'}})};
 }});
 await s.handlers['fivemai:offer']('marcel_dubois','v=0\r\n');
 assert.equal(called,1);assert.match(s.warnings[0],/OpenAI HTTP 400.*invalid_request_error.*session/);
 assert.doesNotMatch(s.warnings[0],/private-test-key|sk-exampleToken/);
 assert.equal(s.sent.some(e=>e[0]==='fivemai:answer'),false);
 assert.equal(s.sent.some(e=>e[0]==='fivemai:closed'),true);
});

test('ambient identity is shared across repeated resolutions of the same network ped',()=>{
 let time=1000;const s=server({now:()=>time});s.handlers['fivemai:resolve']({netId:101,requestId:1});const first=s.sent.find(e=>e[0]==='fivemai:resolved');assert.ok(first);assert.equal(first[2].requestId,1);assert.equal(first[2].profile.id,'npc_1');assert.equal(first[2].profile.netId,101);
 time+=1000;s.handlers['fivemai:resolve']({netId:101,requestId:2});assert.equal(s.sent.at(-1)[2].profile.id,first[2].profile.id);
});
test('a player ped cannot acquire an NPC profile',()=>{
 const s=server();s.handlers['fivemai:resolve']({netId:102});assert.equal(s.sent.at(-1)[0],'fivemai:resolved');assert.equal(s.sent.at(-1)[2].ok,false);assert.equal(s.stateIds.size,0);
});
test('a forged profile state cannot bind another existing character',()=>{
 const s=server();s.stateIds.set(200,'another-character');s.handlers['fivemai:resolve']({netId:101});assert.equal(s.sent.at(-1)[2].profile.id,'npc_1');assert.equal(s.stateIds.get(200),'npc_1');
});

test('unsynchronized network ped yields a retryable reply instead of timing out',()=>{
 const s=server({entityVisible:false});s.handlers['fivemai:resolve']({netId:101,requestId:12});const reply=s.sent.at(-1);assert.equal(reply[0],'fivemai:resolved');assert.equal(reply[2].requestId,12);assert.equal(reply[2].retryable,true);assert.match(reply[2].error,/synchronisé/);
});
test('rate limiting replies explicitly to every request',()=>{
 const s=server();s.handlers['fivemai:resolve']({netId:101,requestId:1});s.handlers['fivemai:resolve']({netId:101,requestId:2});assert.equal(s.sent.at(-1)[2].requestId,2);assert.equal(s.sent.at(-1)[2].retryable,true);
});
test('native string errors retain their diagnosis in the resolver reply and server log',()=>{
 const s=server({profileError:'Native operation failed'});s.handlers['fivemai:resolve']({netId:101,requestId:3});assert.match(s.sent.at(-1)[2].error,/création du profil: Native operation failed/);assert.match(s.warnings[0],/Native operation failed/);
});

test('server discovers a parked vehicle without requiring the player to occupy it',()=>{
 const s=server({vehicles:[{entity:300,netId:44,plate:' AA123BB ',coords:[-340.7,-133.5,39]}]});const v=s.inspectVehicle();assert.equal(v.netId,44);assert.equal(v.plate,'AA123BB');
});
test('server asks for a plate with multiple cars and preserves the quoted target',()=>{
 const vehicles=[{entity:300,netId:44,plate:'AA123BB',coords:[-340.7,-133.5,39]},{entity:301,netId:45,plate:'CC456DD',coords:[-339.7,-133.5,39]}];const s=server({vehicles});assert.equal(s.inspectVehicle().needsPlate,true);const selected=s.inspectVehicle({plate:'cc 456 dd'});assert.equal(selected.netId,45);vehicles[0].coords=[-341.6,-133.5,39];assert.equal(s.inspectVehicle({selected}).netId,45);
});
test('server excludes other buckets and vehicles beyond service range',()=>{
 const s=server({vehicles:[{entity:300,netId:44,plate:'AA123BB',coords:[-340.7,-133.5,39],bucket:1},{entity:301,netId:45,plate:'CC456DD',coords:[0,0,0]}]});assert.throws(()=>s.inspectVehicle(),/Aucun véhicule/);
});
