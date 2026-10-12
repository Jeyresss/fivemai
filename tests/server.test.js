const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function server({near=true,key=''}={}){
 const handlers={},sent=[],saved=[];
 const resourceRoot=path.resolve(__dirname,'..');
 const rootRequire=require('node:module').createRequire(path.join(resourceRoot,'dummy.js'));
 const context={require:id=>id==='node:module'?{createRequire:file=>{
   const load=require('node:module').createRequire(file);
   return name=>{const loaded=load(name);return name==='./server/core.js'?{...loaded,MemoryStore:class{get(){return [];}add(...args){saved.push(args);}}}:loaded;};
 }}:rootRequire(id),
 GetResourcePath:()=>path.resolve(__dirname,'..'),GetCurrentResourceName:()=> 'fivemai',GetConvar:()=>key,
 GetPlayerPed:()=>1,GetPlayerRoutingBucket:()=>0,GetEntityCoords:()=>near?[-341.7,-133.5,39]:[0,0,0],getPlayerIdentifiers:()=>['license:test'],
 onNet:(n,h)=>handlers[n]=h,on:()=>{},emitNet:(...args)=>sent.push(args),exports:(n,h)=>handlers[n]=h,
 setInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{},console,fetch:()=>{throw new Error('Unexpected network');},FormData,Blob,AbortSignal};
 context.global=context;context.source=7;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../server/index.js'),'utf8'),context);
 return {handlers,sent,saved};
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
