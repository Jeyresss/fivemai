'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const resourceRoot=path.resolve(__dirname,'..');
function startup({players=true}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-startup-'));
 const config=JSON.parse(fs.readFileSync(path.join(resourceRoot,'config.json'),'utf8'));config.demoNetwork=true;
 fs.writeFileSync(path.join(directory,'config.json'),JSON.stringify(config));
 const load=require('node:module').createRequire(path.join(resourceRoot,'package.json'));
 const events=new Map(),api=new Map(),sent=[],intervals=[],warnings=[],databases=[],entities=new Map(),network=new Map();
 let nextEntity=100,source=7;
 const playerCoords=[config.npcs[0].coords.x,config.npcs[0].coords.y,config.npcs[0].coords.z];
 entities.set(1,{type:1,model:0,coords:playerCoords,health:200,bucket:0,state:{}});
 function addEntity(type,model,x,y,z){const entity=nextEntity++,netId=entity+1000;entities.set(entity,{type,model,coords:[x,y,z],health:200,bucket:0,state:{},netId});network.set(netId,entity);return entity;}
 const context={
  require:id=>id==='node:module'?{createRequire:()=>name=>{
   const actual=load(name);
   if(name==='./server/database.js')return {...actual,PersistentDatabase:class extends actual.PersistentDatabase{constructor(_file,options){super(':memory:',options);this.file=_file;databases.push(this);}}};
   return actual;
  }}:load(id),
  GetResourcePath:()=>directory,GetCurrentResourceName:()=> 'fivemai',GetConvar:()=>'',
  getPlayers:()=>players?['7']:[],getPlayerIdentifiers:src=>String(src)==='7'?['license:startup']:[],
  GetPlayerPed:src=>String(src)==='7'&&players?1:0,GetPlayerRoutingBucket:()=>0,
  DoesEntityExist:entity=>entities.has(entity),GetEntityType:entity=>entities.get(entity)?.type||0,GetEntityHealth:entity=>entities.get(entity)?.health||0,
  GetEntityCoords:entity=>entities.get(entity)?.coords||[0,0,0],GetEntityRoutingBucket:entity=>entities.get(entity)?.bucket||0,GetEntityModel:entity=>entities.get(entity)?.model||0,
  GetAllVehicles:()=>[...entities].filter(([,entry])=>entry.type===2).map(([entity])=>entity),GetVehicleNumberPlateText:()=> 'START123',GetVehicleEngineHealth:()=>950,GetVehicleBodyHealth:()=>1000,GetEntitySpeed:()=>0,
  NetworkGetNetworkIdFromEntity:entity=>entities.get(entity)?.netId||0,NetworkGetEntityFromNetworkId:netId=>network.get(netId)||0,
  GetVehiclePedIsIn:()=>0,GetPedInVehicleSeat:()=>0,
  Entity:entity=>{const entry=entities.get(entity);if(!entry)throw new Error('Missing entity');return {state:new Proxy(entry.state,{get(target,key){if(key==='set')return (name,value)=>target[name]=value;return target[key];}})};},
  CreatePed:(_type,model,x,y,z)=>addEntity(1,model,x,y,z),CreateVehicle:(model,x,y,z)=>addEntity(2,model,x,y,z),SetEntityOrphanMode:()=>{},DeleteEntity:entity=>{const entry=entities.get(entity);if(entry?.netId)network.delete(entry.netId);entities.delete(entity);},
  SetEntityHealth:(entity,health)=>entities.get(entity).health=health,SetEntityCoords:(entity,x,y,z)=>entities.get(entity).coords=[x,y,z],GetPlayerName:()=> 'Joueur test',RegisterCommand:()=>{},
  onNet:(name,fn)=>events.set(name,fn),on:(name,fn)=>events.set(name,fn),exports:(name,fn)=>api.set(name,fn),emitNet:(...args)=>sent.push(args),
  setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{},
  console:{log:()=>{},warn:text=>warnings.push(text)},fetch:()=>{throw new Error('Unexpected real network call');},FormData,Blob,AbortSignal,Buffer,Date,
  source,global:null
 };
 context.global=context;const sandbox=vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(resourceRoot,'server/index.js'),'utf8'),sandbox,{filename:'server/index.js'});
 async function invoke(name,...args){const previous=global.source;global.source=source;context.source=source;try{const fn=events.get(name)||api.get(name);assert.equal(typeof fn,'function',`Missing hook ${name}`);return await fn(...args);}finally{if(previous===undefined)delete global.source;else global.source=previous;}}
 const evaluate=code=>vm.runInContext(code,sandbox);
 const close=async()=>{try{await invoke('onResourceStop','fivemai');}finally{for(const db of databases)db.close();fs.rmSync(directory,{recursive:true,force:true});}};
 return {config,events,api,sent,intervals,warnings,databases,entities,invoke,evaluate,close};
}
test('full resource starts with actual SQLite, jobs, economy, missions and simulation modules',async()=>{
 const s=startup();try{
  const city=s.evaluate('city');assert.ok(city.services.economy);assert.ok(city.missions.definitions.size>=3);assert.equal(city.services.jobs.mechanic.id,'mechanic');assert.equal(city.services.jobs.driver.id,'driver');assert.equal(city.services.jobs.police.id,'police');assert.equal(city.services.jobs.seller.id,'seller');
  assert.equal(s.databases[0].count('profiles'),s.config.npcs.length);assert.equal(s.evaluate('demoPeds.size'),s.config.npcs.length);
  for(const name of ['RegisterVoiceProvider','GetWallet','GetInventory','RegisterAdapter','RecordIncident','GetMissionStatus','BackupDatabase','BindNPCProfile','AssignNPCJob'])assert.equal(typeof s.api.get(name),'function',name);
  assert.equal(s.warnings.length,0);assert.ok(s.intervals.length>=1);
 }finally{await s.close();}
});
test('full startup resolves a persistent demo profile and performs a real city tick without network',async()=>{
 const s=startup();try{
  await s.invoke('fivemai:resolve',{id:s.config.npcs[0].id,requestId:1});const reply=s.sent.find(event=>event[0]==='fivemai:resolved');assert.equal(reply[2].ok,true);assert.equal(reply[2].profile.id,s.config.npcs[0].id);assert.ok(reply[2].profile.netId>0);
  const city=s.evaluate('city');await city.tick();assert.ok(s.databases[0].count('city_npcs')>=s.config.npcs.length);assert.equal(s.warnings.length,0);
  const status=await s.invoke('GetMissionStatus',7);assert.equal(status.active,false);const wallet=await s.invoke('GetWallet',7);assert.ok(Number.isInteger(wallet.balance));
  await s.invoke('fivemai:offer',s.config.npcs[0].id,'v=0\r\n');assert.ok(s.sent.some(event=>event[0]==='fivemai:error'&&/clé OpenAI/.test(event[2]?.message||event[2])));
 }finally{await s.close();}
});
test('real modules start and tick with no connected player, and stop removes demo entities',async()=>{
 const s=startup({players:false});try{await s.evaluate('city').tick();assert.equal(s.warnings.length,0);const before=s.entities.size;assert.ok(before>s.config.npcs.length);await s.invoke('onResourceStop','fivemai');assert.equal(s.entities.size,1);}finally{await s.close();}
});

test('full resource backup export snapshots live profile data into the isolated fixture directory',async()=>{
 const s=startup();let restored;
 try{const file=await s.invoke('BackupDatabase');assert.ok(file.startsWith(path.dirname(path.dirname(s.databases[0].file))+path.sep));assert.equal(fs.existsSync(file),true);const {PersistentDatabase}=require('../server/database');restored=new PersistentDatabase(file);assert.equal(restored.count('profiles'),s.config.npcs.length);assert.equal(restored.get('profiles',s.config.npcs[0].id).story,s.config.npcs[0].story);}finally{restored?.close();await s.close();}
});
