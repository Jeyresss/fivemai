const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FIRST=['Alex','Camille','Dominique','Charlie','Sacha','Morgan','Lou','Claude','Maxime','Noa','Andrea','Sam'];
const LAST=['Laurent','Morel','Garcia','Roux','Petit','Leroy','Bernard','Fontaine','Martinez','Marchand','Lefèvre','Mercier'];
const CITIES=['Lyon','Marseille','Toulouse','Lille','Bordeaux','Nantes','Paris','Montréal','Bruxelles','Nice'];
const EVENTS=['dû fermer une petite boutique','aidé ses voisins après un incendie','quitté un emploi trop stressant','retrouvé un ami perdu de vue','traversé une période de chômage','gagné un concours local'];
const GOALS=['ouvrir un atelier indépendant','économiser pour voyager','retrouver sa famille','aider son quartier','acheter une maison','changer de carrière'];
const TRAITS=['Réservé, observateur et loyal.','Sociable, prudent avec les inconnus.','Direct, sensible aux injustices.','Calme, curieux et un peu nostalgique.','Drôle, généreux mais méfiant envers les promesses.'];
const pick=list=>list[crypto.randomInt(list.length)];
class ProfileStore {
 constructor(file,{jobs=[],maxProfiles=5000}={}){
  this.file=file;this.jobs=jobs;this.maxProfiles=maxProfiles;
  this.profiles=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
 }
 save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.profiles));fs.renameSync(this.file+'.tmp',this.file);}
 get(id){return Object.hasOwn(this.profiles,id)?this.profiles[id]:null;}
 assignJob(id,jobId,label){
  const p=this.get(id);if(!p)throw new Error('Profil inconnu');
  if(p.jobId!==jobId)p.story+=` A ensuite changé de métier pour devenir ${label}.`;
  p.jobId=jobId;p.job=label;this.save();return p;
 }
 create(model,jobId){
  if(Object.keys(this.profiles).length>=this.maxProfiles)throw new Error('Limite de profils atteinte');
  const job=this.jobs.find(j=>j.id===jobId)||pick(this.jobs.length?this.jobs:[{id:'resident',label:'Habitant de Los Santos'}]);
  let profile;
  do{
   const firstName=pick(FIRST),lastName=pick(LAST),age=crypto.randomInt(22,66),year=crypto.randomInt(2005,2025),relative=pick(FIRST);
   profile={id:'npc_'+crypto.randomUUID(),firstName,lastName,job:job.label,jobId:job.id,model,voice:pick(['marin','cedar']),personality:pick(TRAITS),
    story:`${firstName} ${lastName} a ${age} ans, vient de ${pick(CITIES)} et vit à Los Santos depuis ${year}. Travaille comme ${job.label}. A ${pick(EVENTS)} en ${crypto.randomInt(2015,2025)}. Reste proche de ${relative}, un membre de sa famille. Souhaite ${pick(GOALS)}. A pour habitude de se promener le ${pick(['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'])} près de ${pick(['Vespucci','Mirror Park','Davis','Sandy Shores','Paleto Bay'])}.`,createdAt:new Date().toISOString()};
  }while(Object.values(this.profiles).some(p=>p.story===profile.story));
  this.profiles[profile.id]=profile;this.save();return profile;
 }
}
module.exports={ProfileStore};
