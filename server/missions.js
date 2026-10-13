const crypto=require('node:crypto');
const {DEFAULT_MISSIONS}=require('./content.js');
const STAGES=new Set(['visit','pickup','delivery','select_vehicle','repair','escort','transport']);
function position(p){return p&&['x','y','z'].every(k=>Number.isFinite(p[k]));}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}
function values(rows){return rows.map(row=>row.value??row);}
function clone(value){return JSON.parse(JSON.stringify(value));}
function validateDefinition(def){
 if(!def||typeof def.id!=='string'||!def.id||typeof def.npcId!=='string'||!Array.isArray(def.stages)||!def.stages.length||def.stages.length>16)throw new Error('Mission invalide');
 if(!Number.isSafeInteger(def.reward?.money??0)||(def.reward?.money??0)<0)throw new Error('Récompense invalide');
 for(const stage of def.stages){
  if(!STAGES.has(stage.type)||(!stage.npcId&&!position(stage.destination)))throw new Error('Objectif invalide');
  if(stage.destination&&!position(stage.destination))throw new Error('Destination invalide');
  if(stage.dwellSeconds!==undefined&&(!Number.isFinite(stage.dwellSeconds)||stage.dwellSeconds<0||stage.dwellSeconds>300))throw new Error('Durée invalide');
 }
 return clone(def);
}
class MissionEngine {
 constructor({db,economy,definitions=DEFAULT_MISSIONS,snapshot,npcSnapshot,vehicleSnapshot=()=>null,startObjective=()=>{},stopObjective=()=>{},onCompleted=()=>{},now=()=>Date.now(),config={}}={}){
  if(!db||!economy||typeof snapshot!=='function'||typeof npcSnapshot!=='function')throw new Error('Dépendances des missions manquantes');
  Object.assign(this,{db,economy,snapshot,npcSnapshot,vehicleSnapshot,startObjective,stopObjective,onCompleted,now});
  this.definitions=new Map(definitions.map(def=>[def.id,validateDefinition(def)]));
  if(this.definitions.size!==definitions.length)throw new Error('Identifiant de mission dupliqué');
  this.config={offerSeconds:60,maxTickGapMs:3000,objectiveRetryMs:10000,...config};
  this.objectives=new Map();this.running=false;
 }
 tools(npcId){if(![...this.definitions.values()].some(d=>d.npcId===npcId))return [];return [
  {type:'function',name:'mission_list',description:'Lister les missions réelles de ce personnage, leurs conditions et récompenses. Aucun objectif ne peut être inventé.',parameters:{type:'object',properties:{},additionalProperties:false}},
  {type:'function',name:'mission_offer',description:'Présenter une proposition de mission et ses conditions officielles. Attendre l’accord explicite du joueur avant mission_accept.',parameters:{type:'object',properties:{missionId:{type:'string'}},required:['missionId'],additionalProperties:false}},
  {type:'function',name:'mission_accept',description:'Accepter une proposition existante uniquement après accord explicite du joueur. La progression est vérifiée par le serveur.',parameters:{type:'object',properties:{offerId:{type:'string'},confirmed:{type:'boolean'}},required:['offerId','confirmed'],additionalProperties:false}},
  {type:'function',name:'mission_status',description:'Lire la mission active et les objectifs réellement validés. Ne jamais annoncer une réussite sur la seule parole du joueur.',parameters:{type:'object',properties:{},additionalProperties:false}},
  {type:'function',name:'mission_abandon',description:'Abandonner la mission active seulement après confirmation du joueur. Le colis scellé retourne au donneur; aucune récompense.',parameters:{type:'object',properties:{confirmed:{type:'boolean'}},required:['confirmed'],additionalProperties:false}}
 ];}
 player(ctx){const id=ctx.player||ctx.session?.player;if(typeof id!=='string'||!id||!Number.isInteger(ctx.src))throw new Error('Joueur non identifié');return id;}
 npcId(ctx){return ctx.session?.npc?.id||ctx.npcId;}
 standings(player,npcId){return this.db.get('mission_relations',`${player}:${npcId}`)||{trust:0,reputation:0};}
 available(player,def){const relation=this.standings(player,def.npcId);const done=this.db.get('mission_history',`${player}:${def.id}`);return {unlocked:relation.trust>=(def.prerequisites?.trust??0)&&relation.reputation>=(def.prerequisites?.reputation??0)&&!done,completed:!!done,standing:relation};}
 assertNear(ctx,npcId){const p=this.snapshot(ctx.src),n=this.npcSnapshot(npcId);if(!p||!position(p.position)||!n?.exists||n.alive===false||!position(n.position)||p.bucket!==n.bucket||distance(p.position,n.position)>8)throw new Error('Restez près du donneur de mission');return p;}
 terms(def){return {missionId:def.id,npcId:def.npcId,title:def.title,description:def.description,prerequisites:def.prerequisites||{},reward:clone(def.reward||{}),relationshipReward:clone(def.social||{}),deadlineSeconds:def.deadlineSeconds??1200,objectives:def.stages.map((s,index)=>({index,type:s.type,label:s.label||s.type,destination:s.destination,npcId:s.npcId,radius:s.radius??6,dwellSeconds:s.dwellSeconds??0}))};}
 current(player){const id=this.db.get('mission_active',player);return id?this.db.get('mission_runs',id):null;}
 definitionFor(run){return run.definition||this.definitions.get(run.definitionId);}
 status(player){
  const run=this.current(player);
  if(!run){const recentId=this.db.get('mission_recent',player),recent=recentId?this.db.get('mission_runs',recentId):null;return {ok:true,active:false,lastMission:recent?{id:recent.id,missionId:recent.definitionId,status:recent.status,rewardPaid:recent.status==='completed',reward:recent.status==='completed'?recent.reward:null,reason:recent.reason||null}:null};}
  const def=this.definitionFor(run);return {ok:true,active:run.status==='active',id:run.id,missionId:run.definitionId,status:run.status,progress:run.stage,total:def?.stages.length??run.total,objective:def?.stages[run.stage]?.label||null,deadlineAt:run.deadlineAt,cargo:run.cargo||null,reward:run.reward};
 }
 async execute(name,ctx,args={}){
  const player=this.player(ctx),npcId=this.npcId(ctx);
  if(!this.tools(npcId).some(t=>t.name===name))throw new Error('Ce personnage ne propose pas cet outil');
  if(name==='mission_status')return this.status(player);
  if(name==='mission_abandon'){
   if(args.confirmed!==true)throw new Error('Confirmez l’abandon avec le joueur');
   const run=this.current(player);if(!run)return {ok:false,error:'Aucune mission active'};
   this.end(run,'abandoned','player_choice');await this.stopPhysical(run);return {ok:true,abandoned:true,rewardPaid:false};
  }
  this.assertNear(ctx,npcId);
  if(name==='mission_list')return {ok:true,missions:[...this.definitions.values()].filter(d=>d.npcId===npcId).map(def=>({...this.terms(def),...this.available(player,def)}))};
  if(name==='mission_offer'){
   const def=this.definitions.get(args.missionId);if(!def||def.npcId!==npcId)throw new Error('Mission inconnue pour ce personnage');
   if(!this.available(player,def).unlocked)throw new Error('Conditions de confiance ou réputation non remplies, ou mission déjà terminée');
   if(this.current(player)?.status==='active')throw new Error('Terminez ou abandonnez la mission active');
   const offer={id:crypto.randomUUID(),player,npcId,definitionId:def.id,expiresAt:this.now()+this.config.offerSeconds*1000};this.db.set('mission_offers',offer.id,offer);
   return {ok:true,offerId:offer.id,expiresAt:offer.expiresAt,requiresExplicitAgreement:true,...this.terms(def)};
  }
  if(name!=='mission_accept')throw new Error('Outil de mission inconnu');
  if(args.confirmed!==true)throw new Error('L’accord explicite du joueur est requis');
  const offer=this.db.get('mission_offers',args.offerId);
  if(!offer||offer.player!==player||offer.npcId!==npcId||offer.expiresAt<this.now())throw new Error('Proposition invalide ou expirée');
  const def=this.definitions.get(offer.definitionId);if(!def||!this.available(player,def).unlocked)throw new Error('Mission indisponible');
  const run=this.db.transaction(tx=>{
   const prior=tx.get('mission_active',player);if(prior&&tx.get('mission_runs',prior)?.status==='active')throw new Error('Une mission est déjà active');
   const currentOffer=tx.get('mission_offers',offer.id);if(!currentOffer)throw new Error('Proposition déjà utilisée');
   const next={id:crypto.randomUUID(),player,npcId,definitionId:def.id,definition:clone(def),status:'active',stage:0,total:def.stages.length,dwellMs:0,lastSampleAt:null,createdAt:this.now(),deadlineAt:this.now()+(def.deadlineSeconds??1200)*1000,reward:clone(def.reward||{}),social:clone(def.social||{}),bucket:this.snapshot(ctx.src).bucket,cargo:null,vehicle:null,evidence:null};
   tx.set('mission_runs',next.id,next);tx.set('mission_active',player,next.id);tx.delete('mission_offers',offer.id);return next;
  });
  await this.ensurePhysical(ctx,run,def.stages[0]);return {ok:true,accepted:true,...this.status(player)};
 }
 ensurePhysical(ctx,run,step){
  if(!['escort','transport'].includes(step?.type))return;
  const target=this.snapshot(ctx.src)?.vehicle?.netId||null,key=`${run.id}:${run.stage}`,previous=this.objectives.get(key);
  if(previous&&previous.src===ctx.src&&previous.target===target&&this.now()-previous.at<this.config.objectiveRetryMs)return;
  this.objectives.set(key,{src:ctx.src,target,at:this.now()});
  try{
   const pending=this.startObjective({...ctx,player:run.player},clone(run),clone(step));
   if(pending&&typeof pending.then==='function')pending.catch(()=>{});
  }catch{/* Unavailable path/seat is retried; it never validates the objective. */}
 }
 async stopPhysical(run){for(const key of [...this.objectives.keys()])if(key.startsWith(run.id+':'))this.objectives.delete(key);try{await this.stopObjective(clone(run));}catch{/* Gameplay cleanup is retried by the executor/resource lifecycle. */}}
 end(run,status,reason){return this.db.transaction(tx=>{
  const saved=tx.get('mission_runs',run.id);if(!saved||saved.status!=='active')return saved;
  if(saved.cargo){const escrow=tx.get('item_reservations',saved.cargo.escrowId);if(escrow?.status==='reserved')this.economy.captureItemsInTransaction(tx,escrow.id);saved.cargo=null;}
  saved.status=status;saved.reason=reason;saved.endedAt=this.now();tx.set('mission_runs',saved.id,saved);tx.set('mission_recent',saved.player,saved.id);if(tx.get('mission_active',saved.player)===saved.id)tx.delete('mission_active',saved.player);return saved;
 });}
 vehicleMatches(a,b){return !!a&&!!b&&a.exists!==false&&a.netId===b.netId&&(b.plate===undefined||a.plate===b.plate)&&(b.model===undefined||a.model===b.model);}
 resolveVehicle(run,p){return run.vehicle?this.vehicleSnapshot(run.vehicle.netId)||((p?.vehicle?.netId===run.vehicle.netId)?p.vehicle:null):p?.vehicle;}
 // This method has no network event. Only a trusted gameplay adapter calls it
 // after checking the actual service effect; a model/client assertion is not evidence.
 trustedEvent(event){
  if(!event||event.type!=='mechanic_repair'||typeof event.player!=='string'||typeof event.operationId!=='string')return false;
  const run=this.current(event.player),def=run&&this.definitionFor(run),step=def?.stages[run.stage];
  if(!run||run.status!=='active'||step?.type!=='repair'||step.npcId!==event.npcId||run.vehicle?.netId!==event.vehicleNetId)return false;
  const vehicle=this.vehicleSnapshot(event.vehicleNetId);
  if(!this.vehicleMatches(vehicle,run.vehicle)||!Number.isFinite(vehicle.engineHealth)||vehicle.engineHealth<(step.minEngineHealth??900))return false;
  const npc=this.npcSnapshot(event.npcId);
  if(!npc?.exists||npc.alive===false||npc.bucket!==run.bucket||!position(vehicle.position)||!position(npc.position)||distance(vehicle.position,npc.position)>12)return false;
  return this.db.transaction(tx=>{const r=tx.get('mission_runs',run.id);if(r.status!=='active'||r.stage!==run.stage)return false;r.evidence={type:event.type,operationId:event.operationId,vehicleNetId:event.vehicleNetId,at:this.now()};tx.set('mission_runs',r.id,r);return true;});
 }
 qualifies(run,step,p){
  if(!p||p.alive===false||!position(p.position)||p.bucket!==run.bucket)return false;
  const npc=step.npcId?this.npcSnapshot(step.npcId):null;
  if(step.npcId&&(!npc?.exists||npc.alive===false||npc.bucket!==p.bucket||!position(npc.position)))return false;
  const destination=step.destination||npc?.position;
  if(!position(destination))return false;
  if(step.type==='select_vehicle'){
   const v=p.vehicle;if(!v||v.exists===false||!Number.isInteger(v.netId)||!position(v.position)||!Number.isFinite(v.engineHealth)||v.engineHealth>(step.maxEngineHealth??800))return false;
   return distance(v.position,destination)<=(step.radius??10)&&distance(p.position,v.position)<=12;
  }
  if(step.type==='repair'){
   const v=this.resolveVehicle(run,p);return !!run.evidence&&this.vehicleMatches(v,run.vehicle)&&v.engineHealth>=(step.minEngineHealth??900)&&position(v.position)&&distance(v.position,npc.position)<=12&&distance(p.position,npc.position)<=12;
  }
  if(distance(p.position,destination)>(step.radius??6))return false;
  if(step.type==='escort')return distance(npc.position,destination)<=(step.radius??8)&&distance(p.position,npc.position)<=(step.maxSeparation??25);
  if(step.type==='transport')return !!p.vehicle&&p.vehicle.driver===true&&p.vehicle.netId===npc.vehicleNetId&&distance(npc.position,destination)<=(step.radius??12);
  if(step.type==='delivery')return !!run.cargo&&Object.entries(step.items||{}).every(([item,n])=>run.cargo.items[item]===n);
  return true;
 }
 advance(run,step,p){return this.db.transaction(tx=>{
  const r=tx.get('mission_runs',run.id);if(!r||r.status!=='active'||r.stage!==run.stage)return r;
  if(step.type==='pickup'){
   const meta={kind:'mission_cargo',missionId:r.id};
   this.economy.rewardInTransaction(tx,r.player,`mission-supply:${r.id}:${r.stage}`,{items:step.items,money:0},meta);
   const escrowId=`mission-cargo:${r.id}:${r.stage}`;this.economy.reserveItemsInTransaction(tx,r.player,escrowId,step.items,meta);r.cargo={escrowId,items:clone(step.items)};
  }
  if(step.type==='delivery'){const escrow=r.cargo&&tx.get('item_reservations',r.cargo.escrowId);if(!escrow||escrow.status!=='reserved')throw new Error('Colis scellé indisponible');this.economy.captureItemsInTransaction(tx,escrow.id);r.cargo=null;}
  if(step.type==='select_vehicle')r.vehicle={netId:p.vehicle.netId,plate:p.vehicle.plate,model:p.vehicle.model};
  r.stage++;r.dwellMs=0;r.lastSampleAt=null;r.updatedAt=this.now();
  if(r.stage>=r.total){
   this.economy.rewardInTransaction(tx,r.player,`mission-reward:${r.id}`,r.reward,{kind:'mission',missionId:r.id,definitionId:r.definitionId});
   const relation=tx.get('mission_relations',`${r.player}:${r.npcId}`)||{trust:0,reputation:0};relation.trust=Math.min(100,relation.trust+(r.social.trust||0));relation.reputation=Math.min(100,relation.reputation+(r.social.reputation||0));tx.set('mission_relations',`${r.player}:${r.npcId}`,relation);
   r.status='completed';r.endedAt=this.now();tx.set('mission_history',`${r.player}:${r.definitionId}`,{id:r.id,completedAt:r.endedAt});tx.set('mission_recent',r.player,r.id);tx.delete('mission_active',r.player);tx.set('mission_notifications',r.id,{id:r.id});
  }
  tx.set('mission_runs',r.id,r);return r;
 });}
 async notifyCompletion(run){
  if(!this.db.get('mission_notifications',run.id))return;
  try{
   await this.onCompleted(clone(run));
   this.db.transaction(tx=>{const saved=tx.get('mission_runs',run.id);if(saved){saved.notifiedAt=this.now();tx.set('mission_runs',saved.id,saved);}tx.delete('mission_notifications',run.id);});
  }catch{/* Persistent notifications retry without replaying money or inventory. */}
 }
 async tick(players=[]){
  if(this.running)return {skipped:true};this.running=true;const metrics={active:0,advanced:0,completed:0,failed:0};
  try{
   const online=new Map(players.map(p=>[p.player,p]));
   for(const pending of values(this.db.list('mission_notifications'))){const done=this.db.get('mission_runs',pending.id);if(done?.status==='completed')await this.notifyCompletion(done);}
   for(const run of values(this.db.list('mission_runs')).filter(r=>r.status==='active')){
    metrics.active++;const def=this.definitionFor(run),step=def?.stages[run.stage],entry=online.get(run.player);
    if(!def||!step){this.end(run,'failed','definition_unavailable');await this.stopPhysical(run);metrics.failed++;continue;}
    if(this.now()>run.deadlineAt){this.end(run,'failed','deadline');await this.stopPhysical(run);metrics.failed++;continue;}
    const p=entry?this.snapshot(entry.src):null,npc=step.npcId?this.npcSnapshot(step.npcId):null;
    if((p&&p.alive===false)||(npc?.exists&&npc.alive===false)){this.end(run,'failed','participant_dead');await this.stopPhysical(run);metrics.failed++;continue;}
    if(entry&&p)await this.ensurePhysical({src:entry.src,player:run.player},run,step);
    const yes=this.qualifies(run,step,p),gap=run.lastSampleAt===null?0:this.now()-run.lastSampleAt;
    run.dwellMs=yes?run.dwellMs+(gap>=0&&gap<=this.config.maxTickGapMs?gap:0):0;run.lastSampleAt=yes?this.now():null;
    if(yes&&run.dwellMs>=(step.dwellSeconds??0)*1000){
     const next=this.advance(run,step,p);metrics.advanced++;await this.stopPhysical(run);
     if(next.status==='completed'){metrics.completed++;await this.notifyCompletion(next);}
    }else this.db.set('mission_runs',run.id,run);
   }
   return metrics;
  }finally{this.running=false;}
 }
 // Entity network IDs are recreated after a server restart. An unfinished repair
 // must reselect a real damaged vehicle rather than trusting an old reused ID.
 recover(){return this.db.transaction(tx=>{
  let resumed=0;
  for(const run of values(tx.list('mission_runs'))){
   if(run.status==='completed'&&!run.notifiedAt){tx.set('mission_notifications',run.id,{id:run.id});continue;}
   if(run.status!=='active')continue;run.dwellMs=0;run.lastSampleAt=null;const def=this.definitionFor(run),step=def?.stages[run.stage];
   // Already verified server evidence survives entity recreation. Complete this
   // fulfilled repair step rather than comparing a recycled network ID.
   if(run.evidence&&step?.type==='repair'){this.advance(run,step,{});resumed++;continue;}
   if(run.vehicle){const index=def?.stages.findIndex(s=>s.type==='select_vehicle');if(index>=0&&run.stage>index)run.stage=index;run.vehicle=null;}
   tx.set('mission_runs',run.id,run);tx.set('mission_active',run.player,run.id);resumed++;
  }return {resumed};
 });}
}
module.exports={MissionEngine,validateDefinition,STAGES};
