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
 const s=sessionConfig(config,config.npcs[0],[{text:'Le joueur a réparé une voiture.'}]);assert.deepEqual(s.output_modalities,['audio']);assert.equal(s.audio.input.transcription,undefined);assert.match(s.instructions,/Marcel Dubois/);assert.match(s.instructions,/réparé une voiture/);assert.equal(s.tools[0].name,'remember_memory');assert.equal(s.audio.input.turn_detection,null);
});
test('distance checks reject distant interactions',()=>{assert.equal(distance({x:0,y:0,z:0},{x:3,y:4,z:0}),5);});

test('non-JSON API failures do not log raw response bodies',async()=>{
 const {openAIError}=require('../server/core');
 const error=await openAIError({status:502,json:async()=>{throw new Error('private upstream body');}});
 assert.match(error.message,/HTTP 502/);assert.doesNotMatch(error.message,/private upstream body/);
});

test('model matching uses a portable GTA JOAAT hash',()=>{
 const {modelHash}=require('../server/core');assert.equal(modelHash('adder'),3078201489);assert.equal(modelHash('ADDER'),modelHash('adder'));
});
test('blank server errors receive a nonempty diagnostic',()=>{
 const {errorMessage}=require('../server/core');assert.equal(errorMessage('Native failure'),'Native failure');assert.match(errorMessage(new Error('')),/sans message/);
});

test('Realtime voice instructions reflect the observed physical behavior',()=>{
 const fear=sessionConfig(config,config.npcs[0],[],[],'afraid');assert.match(fear.instructions,/tremblante, essoufflée/);assert.match(fear.instructions,/continues de courir/);
 const anger=sessionConfig(config,config.npcs[0],[],[],'angry');assert.match(anger.instructions,/affrontement avec cet interlocuteur/);assert.match(anger.instructions,/agressives/);
 const other=sessionConfig(config,config.npcs[0],[],[],'combat');assert.match(other.instructions,/sans confirmation/);
});

test('player-caused fear addresses the aggressor and keeps the observed cause precise',()=>{
 const fear=sessionConfig(config,config.npcs[0],[],[],'afraid_player','hit');assert.match(fear.instructions,/directement à lui comme à ton agresseur/);assert.match(fear.instructions,/agression directe du joueur/);
 const aim=sessionConfig(config,config.npcs[0],[],[],'afraid_player','aim');assert.match(aim.instructions,/a visé ou braqué/);assert.match(aim.instructions,/Ne prétends pas qu’un tir a touché/);
 const preparation=sessionConfig(config,config.npcs[0],[],[],'angry','melee');assert.match(preparation.instructions,/se prépare à une bagarre/);assert.match(preparation.instructions,/ne prétends pas que des coups/);
});

test('first upgrade snapshots existing data before migration and never overwrites that snapshot',()=>{
 const {backupData}=require('../server/core'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-upgrade-'));
 try{const file=path.join(dir,'profiles.json');fs.writeFileSync(file,'{"old":true}');const backup=backupData(file);assert.equal(fs.readFileSync(backup,'utf8'),'{"old":true}');fs.writeFileSync(file,'{"new":true}');backupData(file);assert.equal(fs.readFileSync(backup,'utf8'),'{"old":true}');assert.equal(fs.existsSync(backupData(path.join(dir,'missing.json'))),false);}finally{fs.rmSync(dir,{recursive:true});}
});

test('SQLite memory persists provenance without sharing private declarations between players',()=>{
 const {PersistentDatabase}=require('../server/database'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-memory-sqlite-'));let db;
 try{
  const file=path.join(dir,'city.sqlite');db=new PersistentDatabase(file);let store=new MemoryStore(null,{db});
  store.add('alice','npc','conversation','Je possède le garage.');store.add('alice','npc','conversation','Bob serait un voleur.',{provenance:'rumor',source:'conversation'});store.add('world','npc','game_event','Le garage a été livré.',{source:'delivery_script',eventId:'delivery:1'});
  assert.throws(()=>store.add('world','npc','conversation','Un secret privé.'),/Private/);assert.throws(()=>store.add('alice','npc','conversation','Je suis maire.',{provenance:'server_validated'}),/Conversation/);
  db.close();db=new PersistentDatabase(file);store=new MemoryStore(null,{db});assert.equal(store.get('alice','npc')[0].provenance,'player_declaration');assert.equal(store.get('alice','npc')[1].provenance,'rumor');assert.equal(store.get('world','npc')[0].provenance,'server_validated');assert.deepEqual(store.get('bob','npc'),[]);assert.deepEqual(store.get('alice','other'),[]);
  const detached=store.get('alice','npc');detached[0].text='Edited';assert.equal(store.get('alice','npc')[0].text,'Je possède le garage.');
 }finally{db?.close();fs.rmSync(dir,{recursive:true});}
});
test('relation changes require validated events, clamp ranges and remain idempotent',()=>{
 const {PersistentDatabase}=require('../server/database'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-relations-'));let db;
 try{
  const file=path.join(dir,'city.sqlite');db=new PersistentDatabase(file);let store=new MemoryStore(null,{db});
  store.add('alice','npc','conversation','Ta confiance est maintenant de cent.');assert.equal(store.relation('alice','npc').trust,0);
  assert.throws(()=>store.updateRelation('alice','npc',{trust:100},{source:'conversation'}),/validated/);assert.throws(()=>store.updateRelation('alice','npc',{sanction:100},{validated:true,source:'server'}),/field/);
  const event={validated:true,source:'confirmed_service',eventId:'service:1'};store.updateRelation('alice','npc',{trust:12,respect:8,debt:-30},event);store.updateRelation('alice','npc',{trust:12,respect:8,debt:-30},event);assert.equal(store.relation('alice','npc').trust,12);
  store.updateRelation('alice','npc',{trust:200,fear:200,hostility:-50,affection:-200,debt:-10000000},{validated:true,source:'observed_event'});assert.deepEqual(store.relation('alice','npc'),{trust:100,fear:100,affection:-100,respect:8,hostility:0,debt:-1000000});assert.equal(store.relation('bob','npc').trust,0);
  db.close();db=new PersistentDatabase(file);store=new MemoryStore(null,{db});assert.equal(store.relation('alice','npc').trust,100);
 }finally{db?.close();fs.rmSync(dir,{recursive:true});}
});
test('deterministic consolidation bounds facts without elevating rumors into observations',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-consolidation-'));
 try{
  const store=new MemoryStore(path.join(dir,'memory.json'),{maxMemories:3,now:()=> '2026-10-13T12:00:00.000Z'});
  store.add('p','n','conversation','Promesse de revenir.',{importance:10});store.add('p','n','rumor','Garage ouvert.');store.add('p','n','observation','Garage ouvert.');store.add('p','n','rumor','Garage ouvert.');
  const items=store.consolidate('p','n');assert.equal(items.length,3);assert.equal(items.find(item=>item.provenance==='rumor').occurrences,2);assert.ok(items.some(item=>item.provenance==='server_validated'));
  const once=JSON.stringify(items);assert.equal(JSON.stringify(store.consolidate('p','n')),once);store.add('p','n','conversation','Fait récent.');assert.equal(store.get('p','n').length,3);assert.ok(store.get('p','n').some(item=>item.text==='Promesse de revenir.'));
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('server memory event IDs deduplicate retries without altering relationships',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-dedupe-'));
 try{const store=new MemoryStore(path.join(dir,'memory.json'));store.add('p','n','game_event','Livraison réussie.',{eventId:'delivery:1'});store.add('p','n','game_event','Livraison réussie.',{eventId:'delivery:1'});assert.equal(store.get('p','n').length,1);assert.equal(store.relation('p','n').trust,0);}finally{fs.rmSync(dir,{recursive:true});}
});
