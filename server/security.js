'use strict';
const crypto=require('node:crypto');

class RequestLimiter {
 constructor({now=Date.now,maxEntries=2048}={}){this.now=now;this.maxEntries=maxEntries;this.entries=new Map();}
 take(owner,kind,{count=10,windowMs=1000}={}){
  const key=String(owner)+':'+kind,time=this.now();let entry=this.entries.get(key);
  if(!entry||time-entry.start>=windowMs){entry={start:time,count:0};this.entries.delete(key);this.entries.set(key,entry);}
  if(this.entries.size>this.maxEntries){for(const [old,value]of this.entries){if(time-value.start>60000)this.entries.delete(old);}if(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);}
  if(entry.count>=count)return false;entry.count++;return true;
 }
 forget(owner){for(const key of this.entries.keys())if(key.startsWith(String(owner)+':'))this.entries.delete(key);}
}

/** Pessimistic session-duration reservation limits audio use without claiming a dollar price. */
class VoiceBudget {
 constructor({db,config={},now=Date.now}){Object.assign(this,{db,config,now});}
 day(){return new Date(this.now()).toISOString().slice(0,10);}
 reserve(seconds){
  const duration=Math.ceil(seconds);if(!Number.isFinite(duration)||duration<1)throw new Error('Durée de session invalide');
  return this.db.transaction(tx=>{
   const day=this.day(),record=tx.get('voice_budget',day,{calls:0,seconds:0});
   if(record.calls>=(this.config.maxCallsPerDay??200)||record.seconds+duration>(this.config.maxAudioSecondsPerDay??18000))throw new Error('Budget vocal journalier atteint');
   record.calls++;record.seconds+=duration;tx.set('voice_budget',day,record);
   // A crash retains the whole reservation, preventing free use through repeated restarts.
   return {id:crypto.randomUUID(),day,duration,started:this.now(),closed:false};
  });
 }
 finish(reservation){
  if(!reservation||reservation.closed)return;reservation.closed=true;
  const used=Math.min(reservation.duration,Math.max(1,Math.ceil((this.now()-reservation.started)/1000)));
  this.db.transaction(tx=>{const record=tx.get('voice_budget',reservation.day);if(record){record.seconds=Math.max(0,record.seconds-reservation.duration+used);tx.set('voice_budget',reservation.day,record);}});
 }
}
function finitePosition(pos){return pos&&['x','y','z'].every(key=>Number.isFinite(pos[key])&&Math.abs(pos[key])<20000);}
function safeArguments(text,max=8192){if(typeof text!=='string'||text.length>max)throw new Error('Arguments d’outil trop volumineux');const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>['__proto__','constructor','prototype'].includes(key)))throw new Error('Arguments d’outil invalides');return value;}
module.exports={RequestLimiter,VoiceBudget,finitePosition,safeArguments};
