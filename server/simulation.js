const crypto=require('node:crypto');
const {DEFAULT_CHARACTERS}=require('./content.js');
const PRIORITIES={routine:0,idle:1,conversation:4,job:5,mission:6,action:7,combat:9,flee:10};
const PUBLIC_SOURCES=new Set(['server_public','mission','job','police']);
function validPosition(p){return p&&['x','y','z'].every(k=>Number.isFinite(p[k]));}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}
function values(rows){return rows.map(row=>row.value??row);}
function clone(v){return JSON.parse(JSON.stringify(v));}
function phaseAt(character,minute){return (character.routine||[]).find(r=>minute>=r.start&&minute<r.end)||{id:'idle',destination:character.coords,scenario:'WORLD_HUMAN_STAND_MOBILE'};}
class CitySimulation {
 constructor({db,characters=DEFAULT_CHARACTERS,npcSnapshot,dispatch=()=>{},onRumor=()=>{},now=()=>Date.now(),minuteOfDay=()=>Math.floor(now()/60000)%1440,config={}}={}){
  if(!db||typeof npcSnapshot!=='function')throw new Error('Dépendances de simulation manquantes');
  Object.assign(this,{db,npcSnapshot,dispatch,onRumor,now,minuteOfDay});
  this.characters=new Map(characters.map(n=>[n.id,clone(n)]));this.priorities=new Map();this.executors=new Map();
  this.config={enabled:true,nearRadius:100,maxDetailed:32,perPlayer:8,maxDispatchPerTick:8,dispatchIntervalMs:15000,coarseIntervalMs:60000,encounterRadius:4,encounterCooldownMs:90000,maxRumors:16,maxPublicEvents:250,...config};
  for(const key of ['nearRadius','maxDetailed','perPlayer','maxDispatchPerTick'])if(!Number.isFinite(this.config[key])||this.config[key]<0)throw new Error('Budget de simulation invalide');
 }
 register(character){if(!character?.id||!validPosition(character.coords))throw new Error('Personnage invalide');this.characters.set(character.id,clone(character));}
 state(id){return this.db.get('city_npcs',id)||null;}
 priority(id){const locks=this.priorities.get(id);return locks?.size?Math.max(...[...locks].map(name=>PRIORITIES[name]??7)):0;}
 setPriority(id,reason,enabled=true){
  if(!Object.hasOwn(PRIORITIES,reason))throw new Error('Priorité inconnue');
  const locks=this.priorities.get(id)||new Set();if(enabled)locks.add(reason);else locks.delete(reason);if(locks.size)this.priorities.set(id,locks);else this.priorities.delete(id);
  if(this.priority(id)>PRIORITIES.routine){const task=this.executors.get(id);if(task){this.dispatch(task.src,{type:'routine',task:'cancel',npcId:id,npcNetId:task.netId,token:task.token,priority:this.priority(id)});this.executors.delete(id);}}
 }
 cancel(id){const task=this.executors.get(id);if(!task)return;this.dispatch(task.src,{type:'routine',task:'cancel',npcId:id,npcNetId:task.netId,token:task.token,priority:0});this.executors.delete(id);}
 tick(players=[]){
  const metrics={players:players.length,characters:this.characters.size,detailed:0,dispatches:0,coarse:0,encounters:0};if(!this.config.enabled)return metrics;
  const online=players.filter(p=>Number.isInteger(p.src)&&validPosition(p.position)),radius=this.config.nearRadius,cellSize=Math.max(radius,1),cells=new Map();
  for(const p of online){const key=`${p.bucket}:${Math.floor(p.position.x/cellSize)}:${Math.floor(p.position.y/cellSize)}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(p);}
  const states=new Map(),snapshots=new Map(),dirty=new Map(),candidates=[],minute=((this.minuteOfDay()%1440)+1440)%1440;
  for(const npc of this.characters.values()){
   const phase=phaseAt(npc,minute),saved=this.state(npc.id),state=saved||{id:npc.id,phase:phase.id,logicalPosition:phase.destination||npc.coords,createdAt:this.now(),lastCoarseAt:this.now(),needs:{hunger:20,fatigue:20},rumors:[]};
   const snap=this.npcSnapshot(npc.id);snapshots.set(npc.id,snap);states.set(npc.id,state);
   if(!saved||state.phase!==phase.id||this.now()-state.lastCoarseAt>=this.config.coarseIntervalMs){
    const minutes=Math.max(0,Math.min(120,(this.now()-state.lastCoarseAt)/60000));state.needs.hunger=Math.min(100,state.needs.hunger+minutes*.12);state.needs.fatigue=phase.id==='night'?Math.max(0,state.needs.fatigue-minutes*.2):Math.min(100,state.needs.fatigue+minutes*.1);
    state.phase=phase.id;state.activity=phase.scenario||'idle';state.logicalPosition=clone(phase.destination||npc.coords);state.lastCoarseAt=this.now();state.detail='coarse';dirty.set(npc.id,state);metrics.coarse++;
   }
   // Logical far-away schedules never write the physical entity coordinates.
   // Existing entities are always selected using authoritative server positions.
   if(!snap?.exists||snap.alive===false||!validPosition(snap.position))continue;
   const cx=Math.floor(snap.position.x/cellSize),cy=Math.floor(snap.position.y/cellSize);let nearest=null,best=Infinity;
   for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const p of cells.get(`${snap.bucket}:${cx+dx}:${cy+dy}`)||[]){const d=distance(snap.position,p.position);if(d<=radius&&d<best){best=d;nearest=p;}}
   if(nearest)candidates.push({npc,snap,state,phase,player:nearest,distance:best});
  }
  candidates.sort((a,b)=>a.distance-b.distance||a.npc.id.localeCompare(b.npc.id));const counts=new Map(),detailed=[];
  for(const candidate of candidates){if(detailed.length>=this.config.maxDetailed)break;const count=counts.get(candidate.player.src)||0;if(count>=this.config.perPlayer)continue;counts.set(candidate.player.src,count+1);detailed.push(candidate);}
  const selected=new Set(detailed.map(c=>c.npc.id));
  for(const id of this.executors.keys())if(!selected.has(id))this.cancel(id);
  for(const {npc,snap,state,phase,player}of detailed){
   metrics.detailed++;state.detail='near';state.lastObservedPosition=clone(snap.position);state.lastObservedAt=this.now();dirty.set(npc.id,state);
   if(this.priority(npc.id)>0||snap.busy===true){this.cancel(npc.id);continue;}
   const destination=phase.destination||npc.coords,task=distance(snap.position,destination)>2.5?'walk':(phase.scenario?'scenario':'idle');
   const signature=`${phase.id}:${task}`,previous=this.executors.get(npc.id);
   if(previous&&previous.src===player.src&&previous.netId===snap.netId&&previous.signature===signature&&this.now()-previous.at<this.config.dispatchIntervalMs)continue;
   if(metrics.dispatches>=this.config.maxDispatchPerTick)continue;
   if(previous)this.cancel(npc.id);
   const token=crypto.randomUUID(),command={type:'routine',npcId:npc.id,npcNetId:snap.netId,task,destination:clone(destination),scenario:phase.scenario,speed:1,priority:0,token,durationSeconds:Math.max(20,this.config.dispatchIntervalMs/1000+5)};
   this.executors.set(npc.id,{src:player.src,netId:snap.netId,token,signature,at:this.now(),destination:clone(destination),task});this.dispatch(player.src,command);metrics.dispatches++;
  }
  this.db.transaction(tx=>{for(const [id,state]of dirty)tx.set('city_npcs',id,state);});
  // Only physical, nearby characters encounter one another. This path never
  // creates a Realtime call or touches private player conversation memory.
  let encounters=0;
  for(let i=0;i<detailed.length;i++)for(let j=i+1;j<detailed.length;j++){
   if(encounters>=this.config.maxDispatchPerTick)break;const a=detailed[i],b=detailed[j];
   if(a.snap.bucket!==b.snap.bucket||this.priority(a.npc.id)>0||this.priority(b.npc.id)>0||distance(a.snap.position,b.snap.position)>this.config.encounterRadius)continue;
   const id=[a.npc.id,b.npc.id].sort().join(':'),previous=this.db.get('city_encounters',id);if(previous&&this.now()-previous.at<this.config.encounterCooldownMs)continue;
   const notifications=this.db.transaction(tx=>{tx.set('city_encounters',id,{id,participants:[a.npc.id,b.npc.id],at:this.now()});return [this.exchangeRumor(tx,a.npc.id,b.npc.id),this.exchangeRumor(tx,b.npc.id,a.npc.id)].filter(Boolean);});
   for(const item of notifications)try{this.onRumor(item.npcId,item.rumor);}catch{}
   encounters++;
  }
  metrics.encounters=encounters;return metrics;
 }
 result(src,token,ok,state){
  const entry=[...this.executors].find(([,e])=>e.src===src&&e.token===token);if(!entry)return false;
  const [id,task]=entry,snap=this.npcSnapshot(id);if(!snap?.exists||snap.netId!==task.netId)return false;
  if(ok===true&&state==='arrived'&&(!validPosition(snap.position)||distance(snap.position,task.destination)>5))return false;
  if(ok===false){task.at=this.now();task.signature='failed';const saved=this.state(id);if(saved){saved.lastTaskFailureAt=this.now();this.db.set('city_npcs',id,saved);}}
  return true;
 }
 recordPublicEvent(event){
  if(!event||event.visibility!=='public'||!PUBLIC_SOURCES.has(event.source)||typeof event.id!=='string'||!event.id||event.id.length>180||typeof event.description!=='string'||!event.description.trim()||event.description.length>600||!Array.isArray(event.witnesses))return false;
  const witnesses=[...new Set(event.witnesses)].filter(id=>this.characters.has(id));if(!witnesses.length)return false;
  const saved={id:event.id,source:event.source,description:event.description,witnesses,at:this.now()};
  this.db.transaction(tx=>{
   if(tx.get('city_public_events',saved.id))return;tx.set('city_public_events',saved.id,saved);
   for(const id of witnesses){const character=this.characters.get(id),state=tx.get('city_npcs',id)||{id,phase:'idle',logicalPosition:character.coords,createdAt:this.now(),lastCoarseAt:this.now(),needs:{hunger:20,fatigue:20},rumors:[]};state.rumors=[...(state.rumors||[]).filter(r=>r.eventId!==saved.id),{eventId:saved.id,kind:'observation',source:saved.source,at:this.now()}].slice(-this.config.maxRumors);tx.set('city_npcs',id,state);}
   const events=values(tx.list('city_public_events')).sort((a,b)=>a.at-b.at);for(const old of events.slice(0,Math.max(0,events.length-this.config.maxPublicEvents)))tx.delete('city_public_events',old.id);
  });return true;
 }
 exchangeRumor(tx,fromId,toId){
  const from=tx.get('city_npcs',fromId),to=tx.get('city_npcs',toId);if(!from||!to)return;
  const known=new Set((to.rumors||[]).map(r=>r.eventId)),rumor=(from.rumors||[]).slice().reverse().find(r=>!known.has(r.eventId)&&tx.get('city_public_events',r.eventId));if(!rumor)return;
  const event=tx.get('city_public_events',rumor.eventId),item={eventId:event.id,kind:'rumor',heardFrom:fromId,source:event.source,at:this.now()};to.rumors=[...(to.rumors||[]),item].slice(-this.config.maxRumors);tx.set('city_npcs',toId,to);
  return {npcId:toId,rumor:{...item,description:event.description,text:`Rumeur publique entendue auprès de ${fromId} (source ${event.source}): ${event.description}`}};
 }
 shutdown(){for(const id of [...this.executors.keys()])this.cancel(id);this.priorities.clear();}
}
module.exports={CitySimulation,PRIORITIES,PUBLIC_SOURCES,phaseAt};
