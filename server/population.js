'use strict';
function validPosition(p){return p&&['x','y','z'].every(k=>Number.isFinite(p[k]));}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}
function clone(value){return JSON.parse(JSON.stringify(value));}
function rows(db){return db.list('population').map(row=>row.value??row);}
function routineFor(profile,home){
 if(Array.isArray(profile.routine)&&profile.routine.length)return clone(profile.routine);
 const workScenario=profile.jobId==='mechanic'?'WORLD_HUMAN_VEHICLE_MECHANIC':profile.jobId==='police'?'WORLD_HUMAN_CLIPBOARD':'WORLD_HUMAN_STAND_MOBILE';
 return [{id:'rest',start:0,end:420,destination:clone(home),scenario:'WORLD_HUMAN_STAND_MOBILE'},{id:'work',start:420,end:1080,destination:clone(home),scenario:workScenario},{id:'leisure',start:1080,end:1440,destination:{x:home.x+5,y:home.y+3,z:home.z},scenario:'WORLD_HUMAN_STAND_IMPATIENT'}];
}
class PersistentPopulation {
 constructor({db,profiles,spawn,bind,exists,remove,snapshot,players=()=>[],config={},now=()=>Date.now()}={}){
  if(!db||!profiles||[spawn,bind,exists,remove,snapshot,players].some(fn=>typeof fn!=='function'))throw new Error('Dépendances de population manquantes');
  Object.assign(this,{db,profiles,spawn,bind,exists,remove,snapshot,players,now});this.bindings=new Map();this.stopped=false;
  this.config={enabled:true,nearRadius:100,despawnRadius:150,maxManagedEntities:40,maxSpawnsPerTick:4,maxTrackedProfiles:5000,spawnRetryMs:15000,observationIntervalMs:15000,respawnAfterDeathSeconds:0,seeds:[],...config};
  for(const key of ['nearRadius','despawnRadius','maxManagedEntities','maxSpawnsPerTick','maxTrackedProfiles','spawnRetryMs','observationIntervalMs','respawnAfterDeathSeconds'])if(!Number.isFinite(this.config[key])||this.config[key]<0)throw new Error('Budget de population invalide');
  if(this.config.despawnRadius<this.config.nearRadius)this.config.despawnRadius=this.config.nearRadius;
  // Persisted entity handles are historical observations, never live bindings.
  // A new incarnation is attached explicitly or spawned after authoritative culling.
  this.initializeSeeds();
 }
 get(id){return this.db.get('population',id)||null;}
 ownedBindings(){return [...this.bindings.values()].filter(b=>b.owned).map(clone);}
 initializeSeeds(){
  for(const seed of this.config.seeds){
   if(!seed||typeof seed.id!=='string'||!seed.id||!validPosition(seed.coords))throw new Error('Point de population invalide');
   let mapping=this.db.get('population_seeds',seed.id),profile=mapping?this.profiles.get(mapping.profileId):null;
   // A missing/deleted mapped profile is never replaced every tick with new identities.
   if(mapping&&!profile)continue;
   if(!mapping){
    if(rows(this.db).length>=this.config.maxTrackedProfiles)break;
    profile=seed.profile||this.profiles.create(seed.model,seed.jobId,seed.sex);
    if(!profile?.id)throw new Error('Profil de population invalide');
    if(seed.profile&&!this.profiles.get(profile.id)){
     if(typeof this.profiles.persist==='function')profile=this.profiles.persist(profile);
     else if(typeof this.profiles.upsertFixed==='function')profile=this.profiles.upsertFixed(profile);
     else throw new Error('Le profil du point de population doit être persistant');
    }
    mapping={id:seed.id,profileId:profile.id};this.db.set('population_seeds',seed.id,mapping);
   }
   this.register(profile,{...seed.coords,bucket:seed.bucket??0});
  }
 }
 register(profile,coords,binding=null){
  if(!profile||typeof profile.id!=='string'||!profile.id||(!Number.isInteger(profile.model)&&typeof profile.model!=='string')||!validPosition(coords))throw new Error('Profil ou position de population invalide');
  const previous=this.get(profile.id);
  if(!previous&&rows(this.db).length>=this.config.maxTrackedProfiles)throw new Error('Limite de population persistante atteinte');
  const bucket=binding?(binding.bucket??coords.bucket??profile.bucket??previous?.bucket??0):(previous?.bucket??coords.bucket??profile.bucket??0);
  if(!Number.isInteger(bucket)||bucket<0)throw new Error('Bucket de population invalide');
  let attached=null,observedDead=false;
  if(binding){
   if(!Number.isInteger(binding.netId)||binding.netId<=0||!Number.isInteger(binding.entity)||binding.entity<=0)throw new Error('Entité de population invalide');
   if(previous?.alive===false&&!this.canRespawn(previous))throw new Error('Ce personnage est mort; résurrection désactivée');
   const current=this.bindings.get(profile.id),same=current?.netId===binding.netId&&current?.entity===binding.entity;
   if(binding.owned===true&&!current?.owned&&this.ownedBindings().length>=this.config.maxManagedEntities)throw new Error('Budget de PNJ physiques atteint');
   attached={id:profile.id,netId:binding.netId,entity:binding.entity,owned:binding.owned===true||same&&current.owned,incarnation:same?current.incarnation:(previous?.incarnation||0)+1};
   if(this.bind(attached.netId,profile.id)===false||!this.exists(attached))throw new Error('Association du personnage refusée');
   const observation=this.snapshot(profile.id);
   if(observation?.profileId&&observation.profileId!==profile.id)throw new Error('Identité de l’entité incorrecte');observedDead=observation?.alive===false;
  }
  const point={x:coords.x,y:coords.y,z:coords.z,...(Number.isFinite(coords.heading)?{heading:coords.heading}:{})};
  const record={...(previous||{}),id:profile.id,model:profile.model,home:previous?.home||point,lastPosition:attached||!previous?point:previous.lastPosition,bucket,alive:observedDead?false:attached?true:previous?.alive!==false,deadAt:observedDead?previous?.deadAt??this.now():attached?null:previous?.deadAt??null,createdAt:previous?.createdAt??this.now(),lastSeenAt:attached?this.now():previous?.lastSeenAt??null,incarnation:attached?.incarnation??previous?.incarnation??0,routine:previous?.routine||routineFor(profile,point),status:observedDead?'dead':attached?'bound':previous?.alive===false?'dead':'unbound'};
  if(attached){record.lastBinding={netId:attached.netId,entity:attached.entity,owned:attached.owned,incarnation:attached.incarnation};this.bindings.set(profile.id,attached);}
  this.db.set('population',profile.id,record);return clone(record);
 }
 canRespawn(record){return record.alive!==false||this.config.respawnAfterDeathSeconds>0&&Number.isFinite(record.deadAt)&&this.now()-record.deadAt>=this.config.respawnAfterDeathSeconds*1000;}
 detach(id){
  const binding=this.bindings.get(id);if(!binding)return false;this.bindings.delete(id);const record=this.get(id);
  if(record){record.status=record.alive===false?'dead':'unbound';record.unboundAt=this.now();this.db.set('population',id,record);}return true;
 }
 entityRemoved(entity){let removed=0;for(const [id,binding]of [...this.bindings])if(binding.entity===entity&&this.detach(id))removed++;return removed;}
 networkRemoved(netId){let removed=0;for(const [id,binding]of [...this.bindings])if(binding.netId===netId&&this.detach(id))removed++;return removed;}
 nearest(record,players){let nearest=Infinity;for(const player of players)if(player.bucket===record.bucket){const d=distance(record.lastPosition,player.position);if(d<nearest)nearest=d;}return nearest;}
 removeOwned(binding){
  if(!binding?.owned)return false;
  if(!this.exists(binding)){this.detach(binding.id);return false;}
  try{const result=this.remove(clone(binding));if(result===false||this.exists(binding))return false;}catch{return false;}
  this.detach(binding.id);return true;
 }
 tick(inputPlayers){
  const metrics={tracked:0,managed:0,observed:0,spawned:0,attempted:0,culled:0,dead:0,refused:0};if(this.stopped||!this.config.enabled)return metrics;
  const online=(inputPlayers??this.players()).filter(p=>validPosition(p.position)&&Number.isInteger(p.bucket));
  const candidates=[],dirty=[];
  for(const record of rows(this.db)){
   metrics.tracked++;let binding=this.bindings.get(record.id),observation=this.snapshot(record.id);
   // A trusted server locator may discover the original surviving actor after
   // a resource restart. Reattach it; never spawn a second copy beside it.
   if(!binding&&observation?.exists&&observation.profileId===record.id){
    if(Number.isInteger(observation.netId)&&observation.netId>0&&Number.isInteger(observation.entity)&&observation.entity>0){
     const survivor={id:record.id,netId:observation.netId,entity:observation.entity,owned:observation.owned===true,incarnation:record.incarnation||1};
     if(this.exists(survivor)&&this.bind(survivor.netId,record.id)!==false){this.bindings.set(record.id,survivor);binding=survivor;record.status=record.alive===false?'dead':'bound';record.lastBinding={netId:survivor.netId,entity:survivor.entity,owned:survivor.owned,incarnation:survivor.incarnation};dirty.push(record);}
    }
    if(!binding){metrics.refused++;continue;}
   }
   // snapshot(id) is the trusted profile-to-entity lookup; existence alone is
   // insufficient when a network ID has been recycled for another actor.
   if(binding&&(!this.exists(binding)||!observation?.exists||observation.netId!==binding.netId||observation.profileId&&observation.profileId!==record.id||observation.entity!==undefined&&observation.entity!==binding.entity)){
    this.detach(record.id);binding=null;observation=null;record.status=record.alive===false?'dead':'unbound';
   }
   if(binding&&observation){
    if(validPosition(observation.position)){
     const bucket=Number.isInteger(observation.bucket)?observation.bucket:record.bucket,changed=distance(record.lastPosition,observation.position)>.25||record.bucket!==bucket;
     if(changed||this.now()-(record.lastSeenAt??0)>=this.config.observationIntervalMs){record.lastPosition=clone(observation.position);record.bucket=bucket;record.lastSeenAt=this.now();dirty.push(record);}
    }
    if(observation.alive===false&&record.alive!==false){record.alive=false;record.deadAt=this.now();record.status='dead';dirty.push(record);}
    if(binding.owned&&this.nearest(record,online)>this.config.despawnRadius){
     // Save the genuine final position/death before culling. Only our own
     // entities can be deleted; naturally encountered unmanaged peds stay.
     this.db.set('population',record.id,record);
     if(this.removeOwned(binding)){metrics.culled++;binding=null;record.status=record.alive===false?'dead':'unbound';}
    }
   }
   if(binding?.owned)metrics.managed++;
   if(binding)metrics.observed++;
   if(record.alive===false)metrics.dead++;
   if(!binding&&this.canRespawn(record)&&this.nearest(record,online)<=this.config.nearRadius&&this.now()-(record.lastSpawnAttemptAt??-Infinity)>=this.config.spawnRetryMs)candidates.push(record);
  }
  this.db.transaction(tx=>{for(const record of dirty)tx.set('population',record.id,record);});
  candidates.sort((a,b)=>this.nearest(a,online)-this.nearest(b,online)||a.id.localeCompare(b.id));
  for(const record of candidates){
   if(metrics.managed>=this.config.maxManagedEntities||metrics.attempted>=this.config.maxSpawnsPerTick)break;
   const profile=this.profiles.get(record.id);if(!profile){metrics.refused++;continue;}
   record.lastSpawnAttemptAt=this.now();let created=null;
   try{
    metrics.attempted++;created=this.spawn({...profile,routine:record.routine,bucket:record.bucket},clone(record.lastPosition));
    if(!created||!Number.isInteger(created.netId)||created.netId<=0||!Number.isInteger(created.entity)||created.entity<=0)throw new Error('Création de PNJ refusée');
    const binding={id:record.id,netId:created.netId,entity:created.entity,owned:true,incarnation:record.incarnation+1};
    if(this.bind(binding.netId,record.id)===false||!this.exists(binding))throw new Error('Association du PNJ refusée');
    // Creation coordinates are explicit; an existing entity is never moved.
    this.bindings.set(record.id,binding);record.alive=true;record.deadAt=null;record.status='bound';record.incarnation=binding.incarnation;record.lastBinding={netId:binding.netId,entity:binding.entity,owned:true,incarnation:binding.incarnation};record.lastSpawnAt=this.now();record.lastSpawnError=null;
    metrics.managed++;metrics.spawned++;
   }catch(error){
    metrics.refused++;record.lastSpawnError=(error?.message||'spawn_failed').slice(0,180);
    if(created?.entity)try{this.remove({id:record.id,netId:created.netId,entity:created.entity,owned:true});}catch{}
   }
   this.db.set('population',record.id,record);
  }
  return metrics;
 }
 shutdown(){this.stopped=true;for(const binding of this.ownedBindings())this.removeOwned(binding);this.bindings.clear();}
}
module.exports={PersistentPopulation,routineFor};
