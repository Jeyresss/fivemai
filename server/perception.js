'use strict';
const crypto=require('node:crypto');
const {finitePosition}=require('./security');
const {distance}=require('./core');
const {validKey}=require('./database');
const DEFAULT_RELATION_EFFECTS=Object.freeze({
 assault:{trust:-12,fear:20,hostility:12,respect:-4},injury:{trust:-8,fear:10,hostility:4},
 collision:{trust:-4,fear:5,hostility:3},arrest:{trust:-5,fear:10,respect:2},
 service:{trust:2,respect:2,affection:1},rescue:{trust:15,fear:-5,affection:5},
 threat:{trust:-8,fear:12,hostility:6},weapon:{trust:-3,fear:10}
});
const clone=value=>JSON.parse(JSON.stringify(value));
function validSnapshot(snapshot){return snapshot?.exists!==false&&finitePosition(snapshot?.position)&&Number.isInteger(snapshot.bucket)&&snapshot.bucket>=0;}
function sameTarget(a,b){return a&&b&&a.netId===b.netId&&a.bucket===b.bucket&&(a.entity===undefined||b.entity===undefined||a.entity===b.entity)&&(a.model===undefined||b.model===undefined||a.model===b.model);}
function finiteHealth(snapshot){return Number.isFinite(snapshot?.health)&&snapshot.health>=0&&snapshot.health<=100000;}
/** All inputs named snapshots come from server natives. Never expose publish to onNet. */
class PerceptionEngine{
 constructor({db,memory,identity,snapshot,npcSnapshot,npcForNetId,now=Date.now,config={},onEvent=()=>{},onPublic=()=>{}}={}){
  if(!db||typeof identity!=='function'||typeof snapshot!=='function'||typeof npcSnapshot!=='function')throw new Error('Perception dependencies required');
  Object.assign(this,{db,memory,identity,snapshot,npcSnapshot,npcForNetId,now,onEvent,onPublic});
  this.config={observationRadius:35,witnessRadius:60,maxWeaponDistance:120,sampleMaxAgeMs:2500,damageConfirmMs:1500,maxSamples:5000,maxPending:256,maxEvents:1000,eventRetentionMs:86400000,...config};
  for(const [key,value]of Object.entries(this.config))if(key!=='relationEffects'&&(!Number.isFinite(value)||value<1))throw new Error('Invalid perception budget');
  for(const key of ['maxSamples','maxPending','maxEvents'])if(!Number.isSafeInteger(this.config[key]))throw new Error('Invalid perception count limit');
  this.effects={...DEFAULT_RELATION_EFFECTS,...config.relationEffects};this.samples=new Map();this.pending=new Map();this.consumedHealth=new Map();
 }
 actor(src){if(!Number.isInteger(src)||src<=0)return null;const player=this.identity(src),snapshot=this.snapshot(src);return typeof player==='string'&&player&&validSnapshot(snapshot)?{player,snapshot}:null;}
 sample(npcIds){
  if(!Array.isArray(npcIds))throw new Error('NPC samples require an array');const sampled=[];
  for(const npcId of new Set(npcIds)){
   if(typeof npcId!=='string')continue;const value=this.npcSnapshot(npcId);
   if(!validSnapshot(value)||!Number.isInteger(value.netId)||value.netId<1||!finiteHealth(value)){this.samples.delete(npcId);this.consumedHealth.delete(npcId);continue;}
   const previous=this.samples.get(npcId);if(previous&&!sameTarget(previous.snapshot,value))this.consumedHealth.delete(npcId);
   if(this.consumedHealth.has(npcId)&&value.health>this.consumedHealth.get(npcId))this.consumedHealth.set(npcId,value.health);
   const history=previous&&sameTarget(previous.snapshot,value)?[{snapshot:previous.snapshot,at:previous.at},...(previous.history||[])].filter(entry=>this.now()-entry.at<=this.config.sampleMaxAgeMs).slice(0,2):[];
   this.samples.delete(npcId);this.samples.set(npcId,{npcId,snapshot:clone(value),at:this.now(),history});sampled.push(npcId);
  }
  while(this.samples.size>this.config.maxSamples){const id=this.samples.keys().next().value;this.samples.delete(id);this.consumedHealth.delete(id);}
  return sampled.length;
 }
 observe(src,npcId,telemetry){
  const actor=this.actor(src),target=this.npcSnapshot(npcId);
  if(!actor||!validSnapshot(target)||target.alive===false||!telemetry||typeof telemetry!=='object'||Array.isArray(telemetry)||actor.snapshot.bucket!==target.bucket||distance(actor.snapshot.position,target.position)>this.config.observationRadius)return null;
  // A claimed actor or network identity cannot redirect an observation.
  if(telemetry.actorSource!==undefined&&telemetry.actorSource!==src)return null;
  const claimedTarget=telemetry.targetNetId??telemetry.netId;
  if(claimedTarget!==undefined&&claimedTarget!==target.netId)return null;
  const previous=this.samples.get(npcId),healthDrop=previous&&sameTarget(previous.snapshot,target)&&this.now()-previous.at<=this.config.sampleMaxAgeMs&&finiteHealth(target)?Math.max(0,previous.snapshot.health-target.health):0;
  const observation={npcId,actorSource:src,player:actor.player,targetNetId:target.netId,at:this.now(),position:clone(target.position),bucket:target.bucket,
   aimed:telemetry.aimed===true,armed:telemetry.armed===true,hit:telemetry.hit===true&&healthDrop>0,claimedHit:telemetry.hit===true,
   collision:telemetry.collision===true&&healthDrop>0,healthDrop,provenance:'observation',source:'witnessed_client_corroborated',certainty:'client_claim_with_server_context',validated:false,sanctionEligible:false};
  // Matching health proves injury, never the client-provided attacker or cause.
  if(healthDrop>0)observation.injuryObserved=true;
  return observation;
 }
 findTarget(netId){
  if(typeof this.npcForNetId==='function'){const found=this.npcForNetId(netId);if(typeof found==='string')return found;if(found?.id)return found.id;}
  for(const [npcId,entry]of this.samples)if(entry.snapshot.netId===netId)return npcId;return null;
 }
 weaponDamage(src,payload){
  const actor=this.actor(src);if(!actor||!payload||typeof payload!=='object'||Array.isArray(payload))return [];
  if(payload.actorSource!==undefined&&payload.actorSource!==src)return [];
  if(payload.actorNetId!==undefined&&payload.actorNetId!==(actor.snapshot.pedNetId??actor.snapshot.netId))return [];
  if(payload.weaponDamage!==undefined&&(!Number.isFinite(payload.weaponDamage)||payload.weaponDamage<0||payload.weaponDamage>100000))return [];
  if(payload.weaponType!==undefined&&(!Number.isInteger(payload.weaponType)||payload.weaponType< -2147483648||payload.weaponType>4294967295))return [];
  const raw=Array.isArray(payload.hitGlobalIds)&&payload.hitGlobalIds.length?payload.hitGlobalIds:[payload.hitGlobalId];
  const targets=[...new Set(raw)].filter(id=>Number.isInteger(id)&&id>0).slice(0,8),results=[];
  for(const targetNetId of targets){
   const npcId=this.findTarget(targetNetId),latest=npcId&&this.samples.get(npcId),target=npcId&&this.npcSnapshot(npcId);
   const sample=latest&&[latest,...(latest.history||[])].filter(entry=>this.now()-entry.at<=this.config.sampleMaxAgeMs&&sameTarget(entry.snapshot,target)).sort((a,b)=>b.snapshot.health-a.snapshot.health||b.at-a.at)[0];
   if(!sample||!validSnapshot(target)||!sameTarget(sample.snapshot,target)||!finiteHealth(sample.snapshot)||sample.snapshot.health<=0||this.now()-sample.at>this.config.sampleMaxAgeMs||actor.snapshot.bucket!==target.bucket||distance(actor.snapshot.position,target.position)>this.config.maxWeaponDistance)continue;
   const time=Number.isFinite(payload.damageTime)?payload.damageTime:Math.floor(this.now()/50),fingerprint=[src,actor.player,targetNetId,payload.weaponType??0,time,payload.weaponDamage??null];
   const id='damage:'+crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
   if(this.db.get('perception_events',id)||this.pending.has(id))continue;
   if(this.pending.size>=this.config.maxPending)break;
   const entry={id,src,player:actor.player,npcId,targetNetId,baseline:clone(sample.snapshot),actor:clone(actor.snapshot),at:this.now(),deadline:this.now()+this.config.damageConfirmMs,weaponType:payload.weaponType??null};
   this.pending.set(id,entry);const confirmed=this.confirmDamage(entry);if(confirmed)results.push(confirmed);
  }
  return results;
 }
 confirmDamage(entry){
  if(!this.pending.has(entry.id))return null;
  if(this.now()>entry.deadline||this.identity(entry.src)!==entry.player){this.pending.delete(entry.id);return null;}
  const actor=this.actor(entry.src),target=this.npcSnapshot(entry.npcId);
  if(!actor||!validSnapshot(target)||!sameTarget(entry.baseline,target)||!finiteHealth(target)||actor.snapshot.bucket!==target.bucket||distance(actor.snapshot.position,target.position)>this.config.maxWeaponDistance){this.pending.delete(entry.id);return null;}
  const before=Math.min(entry.baseline.health,this.consumedHealth.get(entry.npcId)??entry.baseline.health),damage=before-target.health;
  if(damage<=0)return null;
  const record=this.publish({id:entry.id,actorSource:entry.src,npcId:entry.npcId,type:'assault',description:'Une attaque contre ce PNJ a été corrélée à un événement réseau de dégâts et à une baisse de santé observée par le serveur.',source:'server_weapon_damage_corroborated',certainty:'native_event_and_health_delta',healthBefore:before,healthAfter:target.health,healthDrop:damage,weaponType:entry.weaponType,sanctionEligible:true},{witnesses:[entry.npcId],actorSnapshot:actor.snapshot});
  if(record){this.pending.delete(entry.id);this.consumedHealth.set(entry.npcId,target.health);}
  return record;
 }
 publish(event,{witnesses=event?.witnesses,actorSnapshot,witnessSnapshots}={}){
  if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'||!event.type.trim()||event.type.length>64||typeof event.description!=='string'||!event.description.trim()||event.description.length>1200)return null;
  const actor=this.actor(event.actorSource);if(!actor||event.player!==undefined&&event.player!==actor.player)return null;
  const authoritativeActor=actorSnapshot??actor.snapshot;if(!validSnapshot(authoritativeActor)||authoritativeActor.bucket!==actor.snapshot.bucket)return null;
  const target=event.npcId?this.npcSnapshot(event.npcId):null,center=event.position??target?.position??authoritativeActor.position;
  if(!finitePosition(center)||(event.bucket!==undefined&&event.bucket!==authoritativeActor.bucket)||target&&(!validSnapshot(target)||target.bucket!==authoritativeActor.bucket))return null;
  if(!Array.isArray(witnesses))witnesses=event.npcId?[event.npcId]:[];
  if(witnesses.length>this.config.maxSamples)return null;
  const radius=event.radius??this.config.witnessRadius;if(!Number.isFinite(radius)||radius<1||radius>this.config.witnessRadius)return null;
  const selected=[];
  for(const npcId of new Set(witnesses)){
   if(typeof npcId!=='string')continue;
   const witness=witnessSnapshots instanceof Map?witnessSnapshots.get(npcId):witnessSnapshots?.[npcId]??this.npcSnapshot(npcId);
   if(validSnapshot(witness)&&witness.bucket===authoritativeActor.bucket&&(witness.alive!==false||npcId===event.npcId)&&witness.lineOfSight!==false&&distance(witness.position,center)<=radius)selected.push(npcId);
  }
  if(!selected.length)return null;
  let id=event.id??crypto.randomUUID();try{validKey(id,'event');}catch{return null;}
  if(id.length>180)return null;
  const at=event.at??this.now();if(!Number.isFinite(at)||at>this.now()+1000||this.now()-at>this.config.eventRetentionMs)return null;
  const source=event.source??'trusted_server_gameplay';if(typeof source!=='string'||!source.trim()||source.length>128||['witnessed_client_corroborated','player','conversation','rumor'].includes(source))return null;
  const record={id,type:event.type,description:event.description.trim(),actorSource:event.actorSource,player:actor.player,npcId:event.npcId??null,position:clone(center),bucket:authoritativeActor.bucket,witnesses:selected,at,source,provenance:'server_validated',certainty:event.certainty??'trusted_server_event',validated:true,sanctionEligible:event.sanctionEligible===true,visibility:event.visibility==='public'?'public':'private'};
  for(const field of ['healthBefore','healthAfter','healthDrop','weaponType'])if(Number.isFinite(event[field]))record[field]=event[field];
  const relationChanges=event.relationChanges??this.effects[event.type];let inserted=false;
  const result=this.db.transaction(tx=>{
   const existing=tx.get('perception_events',id);if(existing)return existing.player===record.player&&existing.type===record.type&&existing.npcId===record.npcId?existing:null;
   tx.set('perception_events',id,record);
   for(const npcId of selected){
    this.memory?.add(record.player,npcId,'game_event',record.description,{source,provenance:'server_validated',eventId:id});
    if(relationChanges&&Object.keys(relationChanges).length)this.memory?.updateRelation(record.player,npcId,relationChanges,{validated:true,source,eventId:id});
   }
   const events=tx.list('perception_events').sort((a,b)=>a.value.at-b.value.at||a.key.localeCompare(b.key));
   for(const entry of events.slice(0,Math.max(0,events.length-this.config.maxEvents)))tx.delete('perception_events',entry.key);
   inserted=true;return record;
  });
  if(inserted){try{this.onEvent(clone(result));}catch{}if(result.visibility==='public'){try{this.onPublic({...clone(result),visibility:'public',originSource:result.source,source:'server_public'});}catch{}}}
  return result?clone(result):null;
 }
 tick(){
  const confirmed=[];for(const entry of [...this.pending.values()]){const record=this.confirmDamage(entry);if(record)confirmed.push(record);}
  for(const [npcId,entry]of this.samples)if(this.now()-entry.at>this.config.sampleMaxAgeMs*4){this.samples.delete(npcId);this.consumedHealth.delete(npcId);}
  return confirmed;
 }
 forget(src){for(const [id,entry]of this.pending)if(entry.src===src)this.pending.delete(id);}
 stop(){this.pending.clear();this.samples.clear();this.consumedHealth.clear();}
}
module.exports={PerceptionEngine,DEFAULT_RELATION_EFFECTS,validSnapshot,sameTarget};
