const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {MemoryStore,sessionConfig,distance}=require('../server/core');
const config=require('../config.json');
test('memories survive restart and are isolated by player and NPC',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-'));
 try{const file=path.join(dir,'memory.json');const store=new MemoryStore(file);store.add('alice','marcel','conversation','Le joueur promet de revenir.');const fresh=new MemoryStore(file);assert.equal(fresh.get('alice','marcel')[0].text,'Le joueur promet de revenir.');assert.deepEqual(fresh.get('bob','marcel'),[]);assert.deepEqual(fresh.get('alice','lea'),[]);assert.throws(()=>fresh.add('alice','marcel','conversation','x'.repeat(1201)));}finally{fs.rmSync(dir,{recursive:true});}
});
test('bounded memory retains the latest 100 facts',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-'));
 try{const s=new MemoryStore(path.join(dir,'memory.json'));for(let i=0;i<102;i++)s.add('p','n','game_event',String(i));assert.equal(s.get('p','n').length,100);assert.equal(s.get('p','n')[0].text,'2');}finally{fs.rmSync(dir,{recursive:true});}
});
test('Realtime session uses native audio, NPC identity and memory without transcription',()=>{
 const s=sessionConfig(config,config.npcs[0],[{text:'Le joueur a réparé une voiture.'}]);assert.deepEqual(s.output_modalities,['audio']);assert.equal(s.audio.input.transcription,undefined);assert.match(s.instructions,/Marcel Dubois/);assert.match(s.instructions,/réparé une voiture/);assert.equal(s.tools[0].name,'remember_memory');assert.equal(s.audio.input.turn_detection.interrupt_response,true);
});
test('distance checks reject distant interactions',()=>{assert.equal(distance({x:0,y:0,z:0},{x:3,y:4,z:0}),5);});

test('non-JSON API failures do not log raw response bodies',async()=>{
 const {openAIError}=require('../server/core');
 const error=await openAIError({status:502,json:async()=>{throw new Error('private upstream body');}});
 assert.match(error.message,/HTTP 502/);assert.doesNotMatch(error.message,/private upstream body/);
});
