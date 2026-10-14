const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {appearance,enrichFixed,DEFAULT_ARCHETYPES,VOICES}=require('./archetypes');
const {validKey}=require('./database');
const MALE=['Alexandre','Lucas','Hugo','Nathan','Gabriel','Thomas','Julien','Antoine'];
const FEMALE=['Léa','Emma','Chloé','Sarah','Alice','Julie','Manon','Clara'];
const FIRST=['Alex','Camille','Dominique','Charlie','Sacha','Morgan','Lou','Claude','Maxime','Noa','Andrea','Sam'];
const LAST=['Laurent','Morel','Garcia','Roux','Petit','Leroy','Bernard','Fontaine','Martinez','Marchand','Lefèvre','Mercier'];
const CITIES=['Lyon','Marseille','Toulouse','Lille','Bordeaux','Nantes','Paris','Montréal','Bruxelles','Nice'];
const EVENTS=['dû fermer une petite boutique','aidé ses voisins après un incendie','quitté un emploi trop stressant','retrouvé un ami perdu de vue','traversé une période de chômage','gagné un concours local'];
const GOALS=['ouvrir un atelier indépendant','économiser pour voyager','retrouver sa famille','aider son quartier','acheter une maison','changer de carrière'];
const TRAITS=['Réservé, observateur et loyal.','Sociable, prudent avec les inconnus.','Direct, sensible aux injustices.','Calme, curieux et un peu nostalgique.','Drôle, généreux mais méfiant envers les promesses.'];
const pick=list=>list[crypto.randomInt(list.length)];
class ProfileStore {
 constructor(file,{db=null,jobs=[],maxProfiles=5000,archetypes=DEFAULT_ARCHETYPES,voices=VOICES,sexOverrides={}}={}){
  this.file=file;this.db=db;this.jobs=jobs;this.archetypes=archetypes;this.voices=voices;this.sexOverrides=sexOverrides;this.maxProfiles=maxProfiles;
  if(!Number.isInteger(maxProfiles)||maxProfiles<1)throw new Error('Invalid profile limit');
  this.profiles=Object.create(null);
  const records=db?db.list('profiles'):Object.entries(file&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}).map(([key,value])=>({key,value}));
  for(const {key,value}of records){validKey(key,'NPC');if(!value||typeof value!=='object'||Array.isArray(value)||(value.id!==undefined&&value.id!==key))throw new Error('Invalid profile identity');this.profiles[key]={...value,id:key};}
 }
 save(){
  if(this.db)return this.db.transaction(()=>{for(const [id,profile]of Object.entries(this.profiles))this.db.set('profiles',id,profile);});
  fs.mkdirSync(path.dirname(this.file),{recursive:true});const fd=fs.openSync(this.file+'.tmp','w');
  try{fs.writeFileSync(fd,JSON.stringify(this.profiles));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(this.file+'.tmp',this.file);
 }
 persist(profile){
  const previous=this.profiles[profile.id];
  if(this.db){this.db.set('profiles',profile.id,profile);this.profiles[profile.id]=profile;}
  else{this.profiles[profile.id]=profile;try{this.save();}catch(error){if(previous)this.profiles[profile.id]=previous;else delete this.profiles[profile.id];throw error;}}
  return profile;
 }
 get(id){
  if(typeof id!=='string'||!id.trim()||id.length>512||/[\u0000-\u001f]/.test(id))return null;
  if(this.db){const profile=this.db.get('profiles',id);if(profile)this.profiles[id]=profile;else delete this.profiles[id];return profile;}
  return Object.hasOwn(this.profiles,id)?JSON.parse(JSON.stringify(this.profiles[id])):null;
 }
 upsertFixed(npc,hint){
  if(!npc||typeof npc!=='object'||Array.isArray(npc))throw new Error('Invalid configured NPC');validKey(npc.id,'NPC');
  const existing=this.get(npc.id);
  if(!existing&&(this.db?(this.db.count?this.db.count('profiles'):this.db.list('profiles').length):Object.keys(this.profiles).length)>=this.maxProfiles)throw new Error('Limite de profils atteinte');
  const enriched=enrichFixed(npc,{archetypes:this.archetypes,voices:this.voices,sexOverrides:this.sexOverrides},hint);
  const profile={...enriched,...existing,id:npc.id,fixed:true,appearanceVersion:existing?.appearanceVersion||1,createdAt:existing?.createdAt||new Date().toISOString()};
  return this.persist(profile);
 }
 assignJob(id,jobId,label){
  const p=this.get(id);if(!p)throw new Error('Profil inconnu');
  if(p.jobId!==jobId)p.story+=` A ensuite changé de métier pour devenir ${label}.`;
  p.jobId=jobId;p.job=label;return this.persist(p);
 }
 ensureAppearance(id,sex){
  const p=this.get(id);if(!p)return null;
  if(p.appearanceVersion===1)return p;
  const {voiceChoices,...traits}=appearance(p.model,sex,this.archetypes,this.voices,this.sexOverrides);
  Object.assign(p,traits,{voice:pick(voiceChoices),appearanceVersion:1});return this.persist(p);
 }
 create(model,jobId,sex){
  if((this.db?(this.db.count?this.db.count('profiles'):this.db.list('profiles').length):Object.keys(this.profiles).length)>=this.maxProfiles)throw new Error('Limite de profils atteinte');
  const job=this.jobs.find(j=>j.id===jobId)||pick(this.jobs.length?this.jobs:[{id:'resident',label:'Habitant de Los Santos'}]);
  const {voiceChoices,...traits}=appearance(model,sex,this.archetypes,this.voices,this.sexOverrides);
  const names=traits.sex==='male'?MALE:traits.sex==='female'?FEMALE:FIRST;
  let profile;
  do{
   const firstName=pick(names),lastName=pick(LAST),age=crypto.randomInt(22,66),year=crypto.randomInt(2005,2025),relative=pick(FIRST);
   profile={id:'npc_'+crypto.randomUUID(),firstName,lastName,job:job.label,jobId:job.id,model,...traits,appearanceVersion:1,voice:pick(voiceChoices),personality:pick(TRAITS),
    story:`${firstName} ${lastName} a ${age} ans, vient de ${pick(CITIES)} et vit à Los Santos depuis ${year}. Travaille comme ${job.label}. A ${pick(EVENTS)} en ${crypto.randomInt(2015,2025)}. Reste proche de ${relative}, un membre de sa famille. Souhaite ${pick(GOALS)}. A pour habitude de se promener le ${pick(['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'])} près de ${pick(['Vespucci','Mirror Park','Davis','Sandy Shores','Paleto Bay'])}.`,createdAt:new Date().toISOString()};
  }while(Object.values(this.profiles).some(p=>p.story===profile.story));
  return this.persist(profile);
 }
}
module.exports={ProfileStore};
