const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function server({near=true,key='',fetchImpl}={}){
 const handlers={},sent=[],saved=[],warnings=[];
 const resourceRoot=path.resolve(__dirname,'..');
 const rootRequire=require('node:module').createRequire(path.join(resourceRoot,'dummy.js'));
 const context={require:id=>id==='node:module'?{createRequire:file=>{
   const load=require('node:module').createRequire(file);
   return name=>{const loaded=load(name);return name==='./server/core.js'?{...loaded,MemoryStore:class{get(){return [];}add(...args){saved.push(args);}}}:loaded;};
 }}:rootRequire(id),
 GetResourcePath:()=>path.resolve(__dirname,'..'),GetCurrentResourceName:()=> 'fivemai',GetConvar:()=>key,
 GetPlayerPed:()=>1,GetPlayerRoutingBucket:()=>0,GetEntityCoords:()=>near?[-341.7,-133.5,39]:[0,0,0],getPlayerIdentifiers:()=>['license:test'],
 onNet:(n,h)=>handlers[n]=h,on:()=>{},emitNet:(...args)=>sent.push(args),exports:(n,h)=>handlers[n]=h,
 setInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{},console:{warn:message=>warnings.push(message)},fetch:fetchImpl||(()=>{throw new Error('Unexpected network');}),FormData,Blob,AbortSignal};
 context.global=context;context.source=7;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../server/index.js'),'utf8'),context);
 return {handlers,sent,saved,warnings};
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
