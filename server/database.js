'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const SCHEMA_VERSION=2;
const PROVENANCE=new Set(['server_validated','observation','player_declaration','rumor']);
function ownObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function validKey(value,label='key'){
 if(typeof value!=='string'||!value.trim()||value.length>512||/[\u0000-\u001f]/.test(value))throw new Error(`Invalid ${label}`);
 return value;
}
function memoryKey(player,npc){return JSON.stringify([validKey(player,'player'),validKey(npc,'NPC')]);}
function provenanceFor(kind){return ['observation','game_event','action','service'].includes(kind)?'server_validated':kind==='rumor'?'rumor':'player_declaration';}
function normalizeMemory(entry){
 if(!ownObject(entry)||typeof entry.text!=='string'||!entry.text.trim()||entry.text.length>1200)throw new Error('Invalid legacy memory');
 const kind=typeof entry.kind==='string'&&entry.kind.length<=64?entry.kind:'conversation';
 const provenance=PROVENANCE.has(entry.provenance)?entry.provenance:provenanceFor(kind);
 const time=typeof entry.time==='string'&&Number.isFinite(Date.parse(entry.time))?entry.time:'1970-01-01T00:00:00.000Z';
 return {...entry,kind,text:entry.text.trim(),time,provenance,source:typeof entry.source==='string'?entry.source:provenance==='server_validated'?'legacy_server':'legacy_conversation'};
}
function snapshotLegacy(file){
 const backup=file+'.before-sqlite-v1.bak';
 if(fs.existsSync(file)&&!fs.existsSync(backup))fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
 return backup;
}
/** Durable server-owned key spaces. All writes and migrations are synchronous transactions. */
class PersistentDatabase {
 constructor(file,options={}){
  if(typeof file!=='string'||!file)throw new Error('SQLite path required');
  this.file=file;this.closed=false;this.depth=0;
  this.maxRecordBytes=options.maxRecordBytes??1024*1024;
  this.maxBytes=options.maxBytes??64*1024*1024;
  this.maxRecords=options.maxRecords??100000;
  for(const limit of [this.maxRecordBytes,this.maxBytes,this.maxRecords])if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid storage limit');
  if(file!==':memory:')fs.mkdirSync(path.dirname(file),{recursive:true});
  let DatabaseSync=options.DatabaseSync;
  if(!DatabaseSync){try{({DatabaseSync}=require('node:sqlite'));}catch{throw new Error('SQLite indisponible : utilisez un runtime Node avec node:sqlite (FiveM Node 22 compatible).');}}
  this.sqlite=new DatabaseSync(file);
  try{
   this.sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
   const version=Number(this.sqlite.prepare('PRAGMA user_version').get().user_version);
   if(version>SCHEMA_VERSION)throw new Error('SQLite schema is newer than this resource');
   this.transaction(()=>{
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS records(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), updated_at TEXT NOT NULL, PRIMARY KEY(namespace,key)); CREATE TABLE IF NOT EXISTS migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, details TEXT NOT NULL CHECK(json_valid(details)));');
    if(version<1)this.sqlite.prepare('INSERT OR IGNORE INTO migrations(id,applied_at,details) VALUES(?,?,?)').run('schema-v1',new Date().toISOString(),'{}');
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS storage_stats(id INTEGER PRIMARY KEY CHECK(id=1), record_count INTEGER NOT NULL, payload_bytes INTEGER NOT NULL); INSERT OR IGNORE INTO storage_stats(id,record_count,payload_bytes) SELECT 1,COUNT(*),COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM records; CREATE TRIGGER IF NOT EXISTS records_insert_stats AFTER INSERT ON records BEGIN UPDATE storage_stats SET record_count=record_count+1,payload_bytes=payload_bytes+length(CAST(NEW.value AS BLOB)) WHERE id=1; END; CREATE TRIGGER IF NOT EXISTS records_update_stats AFTER UPDATE OF value ON records BEGIN UPDATE storage_stats SET payload_bytes=payload_bytes-length(CAST(OLD.value AS BLOB))+length(CAST(NEW.value AS BLOB)) WHERE id=1; END; CREATE TRIGGER IF NOT EXISTS records_delete_stats AFTER DELETE ON records BEGIN UPDATE storage_stats SET record_count=record_count-1,payload_bytes=payload_bytes-length(CAST(OLD.value AS BLOB)) WHERE id=1; END;');
    if(version<2)this.sqlite.prepare('INSERT OR IGNORE INTO migrations(id,applied_at,details) VALUES(?,?,?)').run('schema-v2',new Date().toISOString(),'{"storage_stats":true}');
    this.sqlite.exec('PRAGMA user_version=2');
   });
   this.readStatement=this.sqlite.prepare('SELECT value FROM records WHERE namespace=? AND key=?');
   this.setStatement=this.sqlite.prepare('INSERT INTO records(namespace,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
   this.importLegacy(options.legacyProfiles??options.profilesFile,options.legacyMemory??options.memoryFile);
  }catch(error){this.sqlite.close();this.closed=true;throw error;}
 }
 ensureOpen(){if(this.closed)throw new Error('Database closed');}
 get(namespace,key,fallback=null){
  this.ensureOpen();validKey(namespace,'namespace');validKey(key);
  const row=this.readStatement.get(namespace,key);return row?JSON.parse(row.value):fallback;
 }
 set(namespace,key,value){
  this.ensureOpen();validKey(namespace,'namespace');validKey(key);
  const serialized=JSON.stringify(value);
  if(serialized===undefined)throw new Error('Value is not JSON serializable');
  const bytes=Buffer.byteLength(serialized);
  if(bytes>this.maxRecordBytes)throw new Error('Storage record limit reached');
  return this.transaction(()=>{
   const current=this.sqlite.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM records WHERE namespace=? AND key=?').get(namespace,key);
   const totals=this.sqlite.prepare('SELECT record_count AS count,payload_bytes AS bytes FROM storage_stats WHERE id=1').get();
   if((!current&&totals.count>=this.maxRecords)||totals.bytes-(current?.bytes||0)+bytes>this.maxBytes)throw new Error('Storage capacity reached');
   this.setStatement.run(namespace,key,serialized,new Date().toISOString());return JSON.parse(serialized);
  });
 }
 delete(namespace,key){this.ensureOpen();validKey(namespace,'namespace');validKey(key);return this.sqlite.prepare('DELETE FROM records WHERE namespace=? AND key=?').run(namespace,key).changes>0;}
 list(namespace){this.ensureOpen();validKey(namespace,'namespace');return this.sqlite.prepare('SELECT key,value FROM records WHERE namespace=? ORDER BY key').all(namespace).map(row=>({key:row.key,value:JSON.parse(row.value)}));}
 count(namespace){this.ensureOpen();validKey(namespace,'namespace');return this.sqlite.prepare('SELECT COUNT(*) AS count FROM records WHERE namespace=?').get(namespace).count;}
 stats(){this.ensureOpen();return {...this.sqlite.prepare('SELECT record_count AS records,payload_bytes AS payloadBytes FROM storage_stats WHERE id=1').get()};}
 transaction(fn){
  this.ensureOpen();if(typeof fn!=='function')throw new Error('Transaction callback required');
  if(fn.constructor?.name==='AsyncFunction')throw new Error('SQLite transaction callbacks must be synchronous');
  const nested=this.depth>0,savepoint=`fivemai_${this.depth}`;
  this.sqlite.exec(nested?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');this.depth++;
  try{
   const result=fn(this);
   if(result&&typeof result.then==='function')throw new Error('SQLite transaction callbacks must be synchronous');
   this.sqlite.exec(nested?`RELEASE ${savepoint}`:'COMMIT');return result;
  }catch(error){this.sqlite.exec(nested?`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`:'ROLLBACK');throw error;}
  finally{this.depth--;}
 }
 importLegacy(profilesFile,memoryFile){
  if(!profilesFile&&!memoryFile)return false;
  const marker='legacy-json-v1';
  if(this.sqlite.prepare('SELECT id FROM migrations WHERE id=?').get(marker))return false;
  const parsed={},details={};
  for(const [type,file]of [['profiles',profilesFile],['memories',memoryFile]]){
   if(!file||!fs.existsSync(file))continue;
   snapshotLegacy(file);
   const source=fs.readFileSync(file,'utf8');
   try{parsed[type]=JSON.parse(source);}catch{throw new Error(`Legacy ${type} JSON is corrupt; original and backup preserved`);}
   if(!ownObject(parsed[type]))throw new Error(`Invalid legacy ${type} root`);
   details[type]={path:path.resolve(file),sha256:crypto.createHash('sha256').update(source).digest('hex')};
  }
  if(!Object.keys(parsed).length)return false;
  this.transaction(()=>{
   for(const [id,profile]of Object.entries(parsed.profiles||{})){
    validKey(id,'NPC');if(!ownObject(profile)||(profile.id!==undefined&&profile.id!==id))throw new Error('Invalid legacy profile identity');
    if(!this.get('profiles',id))this.set('profiles',id,{...profile,id});
   }
   for(const [player,npcs]of Object.entries(parsed.memories||{})){
    validKey(player,'player');if(!ownObject(npcs))throw new Error('Invalid legacy player memory');
    for(const [npc,entries]of Object.entries(npcs)){
     const key=memoryKey(player,npc);if(!Array.isArray(entries))throw new Error('Invalid legacy memory list');
     const normalized=entries.map(normalizeMemory).slice(-100).map(entry=>({...entry,visibility:player==='world'?'public':'private'}));
     if(!this.get('memories',key))this.set('memories',key,normalized);
    }
   }
   this.sqlite.prepare('INSERT INTO migrations(id,applied_at,details) VALUES(?,?,?)').run(marker,new Date().toISOString(),JSON.stringify(details));
  });return true;
 }
 backup(target){
  this.ensureOpen();if(this.depth)throw new Error('Cannot back up during a transaction');
  if(typeof target!=='string'||!target)throw new Error('Backup path required');
  if(fs.existsSync(target))throw new Error('Backup already exists');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temporary=target+`.tmp-${crypto.randomUUID()}`;
  try{this.sqlite.exec(`VACUUM INTO '${temporary.replace(/'/g,"''")}'`);fs.copyFileSync(temporary,target,fs.constants.COPYFILE_EXCL);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return target;
 }
 close(){if(this.closed)return;if(this.depth)throw new Error('Cannot close during a transaction');this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.sqlite.close();this.closed=true;}
}
module.exports={PersistentDatabase,SCHEMA_VERSION,memoryKey,normalizeMemory,provenanceFor,snapshotLegacy,validKey};
