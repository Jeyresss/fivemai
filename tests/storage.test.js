'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PersistentDatabase,SCHEMA_VERSION,memoryKey}=require('../server/database');
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fivemai-sqlite-'));return {dir,file:path.join(dir,'city.sqlite'),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};}
test('WAL records and schema survive restart, preserving independent namespaces',()=>{
 const f=fixture();let db;
 try{
  db=new PersistentDatabase(f.file);assert.equal(db.sqlite.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  assert.equal(db.sqlite.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
  db.set('profiles','npc:1',{firstName:'Léa'});db.set('wallets','license:one',{balance:123});
  assert.deepEqual(db.stats(),{records:2,payloadBytes:Buffer.byteLength('{"firstName":"Léa"}')+Buffer.byteLength('{"balance":123}')});
  db.close();db=new PersistentDatabase(f.file);assert.equal(db.get('profiles','npc:1').firstName,'Léa');assert.equal(db.get('wallets','license:one').balance,123);assert.equal(db.get('wallets','npc:1'),null);
  const value=db.get('wallets','license:one');value.balance=999;assert.equal(db.get('wallets','license:one').balance,123);
 }finally{db?.close();f.cleanup();}
});
test('transactions roll back related balances and nested writes together',()=>{
 const f=fixture();let db;
 try{
  db=new PersistentDatabase(f.file);db.set('wallets','player',{balance:100});const before=db.stats();
  assert.throws(()=>db.transaction(tx=>{tx.set('wallets','player',{balance:75});tx.transaction(inner=>inner.set('stock','shop',{count:2}));throw new Error('failure');}),/failure/);
  assert.equal(db.get('wallets','player').balance,100);assert.equal(db.get('stock','shop'),null);assert.deepEqual(db.stats(),before);
  db.transaction(tx=>{tx.set('wallets','player',{balance:90});try{tx.transaction(inner=>{inner.set('stock','shop',{count:3});throw new Error('inner');});}catch{}tx.set('orders','one',{paid:true});});
  assert.equal(db.get('wallets','player').balance,90);assert.equal(db.get('stock','shop'),null);assert.equal(db.get('orders','one').paid,true);
  assert.throws(()=>db.transaction(async tx=>{tx.set('orders','bad',{paid:true});}),/synchronous/);assert.equal(db.get('orders','bad'),null);
 }finally{db?.close();f.cleanup();}
});
test('legacy import preserves original IDs and files, normalizes provenance, and is idempotent',()=>{
 const f=fixture();let db;
 try{
  const profiles=path.join(f.dir,'profiles.json'),memory=path.join(f.dir,'memory.json');
  const profileText=JSON.stringify({saved:{id:'saved',firstName:'Marcel',voice:'cedar',story:'Texte personnalisé'}});
  const memoryText=JSON.stringify({alice:{saved:[{kind:'conversation',text:'Je connais le maire.',time:'2025-01-01T00:00:00Z'}]},world:{saved:[{kind:'observation',text:'Le garage est ouvert.',time:'2025-01-01T00:00:00Z'}]}});
  fs.writeFileSync(profiles,profileText);fs.writeFileSync(memory,memoryText);
  db=new PersistentDatabase(f.file,{legacyProfiles:profiles,legacyMemory:memory});
  assert.equal(db.get('profiles','saved').story,'Texte personnalisé');assert.equal(db.get('memories',memoryKey('alice','saved'))[0].provenance,'player_declaration');assert.equal(db.get('memories',memoryKey('world','saved'))[0].visibility,'public');
  for(const [file,source]of [[profiles,profileText],[memory,memoryText]]){assert.equal(fs.readFileSync(file,'utf8'),source);assert.equal(fs.readFileSync(file+'.before-sqlite-v1.bak','utf8'),source);}
  db.set('profiles','saved',{id:'saved',firstName:'Personnalisé'});db.close();fs.writeFileSync(profiles,JSON.stringify({saved:{id:'saved',firstName:'Replaced'}}));
  db=new PersistentDatabase(f.file,{legacyProfiles:profiles,legacyMemory:memory});assert.equal(db.get('profiles','saved').firstName,'Personnalisé');assert.equal(fs.readFileSync(profiles+'.before-sqlite-v1.bak','utf8'),profileText);
 }finally{db?.close();f.cleanup();}
});
test('invalid legacy entry rolls back the whole import and remains repairable',()=>{
 const f=fixture();let db;
 try{
  const profiles=path.join(f.dir,'profiles.json'),memory=path.join(f.dir,'memory.json');
  fs.writeFileSync(profiles,JSON.stringify({saved:{id:'saved',firstName:'Léa'}}));fs.writeFileSync(memory,JSON.stringify({alice:{saved:[{kind:'conversation',text:123}]}}));
  assert.throws(()=>new PersistentDatabase(f.file,{legacyProfiles:profiles,legacyMemory:memory}),/legacy memory/);
  db=new PersistentDatabase(f.file);assert.equal(db.get('profiles','saved'),null);assert.equal(db.list('memories').length,0);db.close();
  fs.writeFileSync(memory,JSON.stringify({alice:{saved:[{kind:'conversation',text:'Un souvenir corrigé.'}]}}));db=new PersistentDatabase(f.file,{legacyProfiles:profiles,legacyMemory:memory});assert.equal(db.get('profiles','saved').firstName,'Léa');
 }finally{db?.close();f.cleanup();}
});
test('corrupt legacy JSON and corrupt SQLite fail without silently replacing data',()=>{
 const f=fixture();
 try{
  const profiles=path.join(f.dir,'profiles.json');fs.writeFileSync(profiles,'{broken');assert.throws(()=>new PersistentDatabase(f.file,{legacyProfiles:profiles}),/corrupt/);assert.equal(fs.readFileSync(profiles,'utf8'),'{broken');assert.equal(fs.readFileSync(profiles+'.before-sqlite-v1.bak','utf8'),'{broken');
  const bad=path.join(f.dir,'bad.sqlite');fs.writeFileSync(bad,'this is not a database');assert.throws(()=>new PersistentDatabase(bad),/database/);assert.equal(fs.readFileSync(bad,'utf8'),'this is not a database');
 }finally{f.cleanup();}
});
test('SQLite backup includes committed WAL writes and refuses to overwrite a snapshot',()=>{
 const f=fixture();let db,restored;
 try{
  db=new PersistentDatabase(f.file);db.set('profiles','one',{id:'one',name:'Original'});const backup=path.join(f.dir,"backup'city.sqlite");db.backup(backup);
  db.set('profiles','one',{id:'one',name:'Modified'});assert.throws(()=>db.backup(backup),/exists/);restored=new PersistentDatabase(backup);assert.equal(restored.get('profiles','one').name,'Original');assert.equal(db.get('profiles','one').name,'Modified');
 }finally{restored?.close();db?.close();f.cleanup();}
});
test('storage capacity and per-record limits roll back cleanly and release quota after deletion',()=>{
 const f=fixture();let db;
 try{
  db=new PersistentDatabase(f.file,{maxRecords:2,maxBytes:30,maxRecordBytes:20});db.set('a','one',{x:1});db.set('a','two',{x:2});const before=db.stats();
  assert.throws(()=>db.set('a','three',{x:3}),/capacity/);assert.throws(()=>db.set('a','one',{x:'a'.repeat(30)}),/record limit/);assert.deepEqual(db.stats(),before);
  db.set('a','one',{x:123456});assert.equal(db.stats().records,2);assert.equal(db.delete('a','two'),true);assert.equal(db.stats().records,1);db.set('a','three',{x:3});assert.equal(db.stats().records,2);
 }finally{db?.close();f.cleanup();}
});
test('v1 databases migrate quota metadata without losing records',()=>{
 const f=fixture();let db;
 try{
  const {DatabaseSync}=require('node:sqlite');const old=new DatabaseSync(f.file);old.exec('CREATE TABLE records(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(namespace,key)); PRAGMA user_version=1');old.prepare('INSERT INTO records VALUES(?,?,?,?)').run('profiles','old','{"id":"old"}','2025');old.close();
  db=new PersistentDatabase(f.file);assert.equal(db.get('profiles','old').id,'old');assert.equal(db.stats().records,1);assert.equal(db.sqlite.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
 }finally{db?.close();f.cleanup();}
});
