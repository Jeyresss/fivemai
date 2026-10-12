const crypto=require('node:crypto');
const ACTIONS=['hands_up','release','follow','flee','approach_vehicle','enter_vehicle'];
const REASONS={control:'Contrôle réseau du PNJ indisponible',danger:'Le PNJ ne peut pas effectuer cette action dans son état actuel',weapon:'Le joueur ne braque plus le PNJ',refused:'Ce personnage refuse de se rendre dans cette situation',vehicle:'Véhicule inaccessible ou siège occupé',path:'Destination non atteinte',animation:'Animation de reddition non confirmée',gone:'Personnage disparu',script:'Erreur client; consulter F8',expired:'Action expirée',distance:'Joueur trop éloigné',released:'Menace levée',interrupted:'Action interrompue'};
class NPCActionManager {
 constructor({config={},inspect,send,changed=()=>{},remember=()=>{},now=()=>Date.now(),schedule=setTimeout,cancelTimer=clearTimeout}){
  Object.assign(this,{config,inspect,send,changed,remember,now,schedule,cancelTimer});this.pending=new Map();this.running=new Map();
 }
 tools(jobId){
  if(this.config.enabled===false)return [];
  const tools=[{type:'function',name:'npc_action',description:'Exécuter une action réelle de ce PNJ à la demande vocale du joueur: lever les mains sous la menace, libérer la posture, suivre, fuir, rejoindre un véhicule ou monter comme passager. Ne jamais annoncer que l’action a eu lieu avant son résultat. La reddition peut être refusée selon le tempérament et la situation.',parameters:{type:'object',properties:{action:{type:'string',enum:ACTIONS},plate:{type:'string',description:'Plaque du véhicule si plusieurs véhicules sont proches'}},required:['action'],additionalProperties:false}}];
  if(jobId==='driver')tools.push({type:'function',name:'driver_trip',description:'Après une demande explicite, conduire un véhicule garé avec siège conducteur libre vers une destination autorisée. Demander la destination au joueur; ne pas inventer de destination. Service gratuit sans économie.',parameters:{type:'object',properties:{destination:{type:'string'},plate:{type:'string'}},required:['destination'],additionalProperties:false}});
  return tools;
 }
 async execute(name,ctx,args){
  if(!this.tools(ctx.session.npc.jobId).some(t=>t.name===name))throw new Error('Outil action indisponible');
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Arguments invalides');
  const action=name==='driver_trip'?'drive':args.action;
  if(name==='npc_action'&&!ACTIONS.includes(action))throw new Error('Action inconnue');
  if(action==='release'){
   this.inspect(ctx,action,args);
   const running=this.running.get(ctx.session);
   if(!running){const hadPending=[...this.pending.values()].some(p=>p.ctx.session===ctx.session);this.stop(ctx.session,'released');return {ok:true,completed:!hadPending,cancellationRequested:hadPending,action:'release'};}
   if(running.releaseResolve)throw new Error('Un arrêt est déjà en cours');
   return new Promise(resolve=>{
    running.releaseResolve=resolve;running.releaseTimer=this.schedule(()=>{
     this.running.delete(ctx.session);ctx.session.actionState=null;this.changed(ctx.session);resolve({ok:false,error:'Arrêt de l’action non confirmé'});
    },3000);
    this.send(ctx.src,'fivemai:actionCancel',{token:running.token});
   });
  }
  if([...this.pending.values()].some(p=>p.ctx.session===ctx.session))throw new Error('Une action est déjà en préparation');
  const observed=this.inspect(ctx,action,args);
  if(observed.needsPlate)return {ok:false,...observed};
  if(action==='hands_up'){
   if(!observed.aimed||this.now()-observed.at>2000)throw new Error('Le joueur doit réellement braquer ce PNJ à proximité');
   if(observed.armed&&!this.config.allowArmedSurrender)return {ok:false,refused:true,reason:'PNJ armé: résistance à la reddition'};
   // Stable per-character disposition; sex is deliberately not a factor.
   const pressure=observed.armed?0.65:1;
   if(pressure<(ctx.session.npc.surrenderThreshold??0.3))return {ok:false,refused:true,reason:'Ce personnage résiste à la menace'};
  }else if(!['calm','surrendered'].includes(ctx.session.behavior||'calm')&&action!=='flee'){
   throw new Error('Le PNJ a peur ou se bat et refuse cette action');
  }
  this.stop(ctx.session,'interrupted');
  return new Promise(resolve=>{
   const token=crypto.randomUUID();
   const pending={ctx,action,observed,resolve,timer:null};this.pending.set(token,pending);
   pending.timer=this.schedule(()=>this.result(ctx.src,token,false,'expired'),action==='drive'?30000:20000);
   this.send(ctx.src,'fivemai:actionStart',{token,action,npcId:ctx.session.npc.id,npcNetId:ctx.session.npc.netId,...observed,
    durationSeconds:action==='hands_up'?(this.config.surrenderSeconds||30):action==='drive'?(this.config.maxTripSeconds||150):(this.config.maxFollowSeconds||60),releaseAfterThreatSeconds:this.config.releaseAfterThreatSeconds||8,maxDistance:this.config.maxDistance||30});
  });
 }
 result(src,token,ok,reason){
  const pending=this.pending.get(token);if(!pending||pending.ctx.src!==src)return false;
  this.pending.delete(token);this.cancelTimer(pending.timer);
  if(ok!==true){this.send(src,'fivemai:actionCancel',{token});pending.resolve({ok:false,error:REASONS[reason]||'Action non confirmée'});return true;}
  const {ctx,action}=pending;
  this.running.set(ctx.session,{token,src,action,ctx,observed:pending.observed});ctx.session.actionState=action;this.changed(ctx.session);
  let memorySaved=true;try{this.remember(ctx,`Action du PNJ confirmée: ${action}.`);}catch{memorySaved=false;}
  pending.resolve({ok:true,memorySaved,completed:!['follow','drive','flee'].includes(action),started:true,action,...(action==='drive'?{destination:pending.observed.destination.label,instruction:'Le trajet a commencé; ne prétends pas être déjà arrivé.'}:{})});return true;
 }
 ended(src,token,reason){
  for(const [session,action] of this.running){if(action.token!==token||action.src!==src)continue;
   this.running.delete(session);session.actionState=null;this.changed(session);
   if(action.releaseResolve){this.cancelTimer(action.releaseTimer);action.releaseResolve(reason==='control'?{ok:false,error:REASONS.control}:{ok:true,completed:true,action:'release'});}
   return true;
  }
  return false;
 }
 stop(session,reason='interrupted'){
  for(const [token,p]of this.pending)if(p.ctx.session===session)this.result(p.ctx.src,token,false,reason);
  const running=this.running.get(session);if(running){this.running.delete(session);if(running.releaseResolve){this.cancelTimer(running.releaseTimer);running.releaseResolve({ok:false,error:'Conversation ou action interrompue'});}this.send(running.src,'fivemai:actionCancel',{token:running.token});session.actionState=null;this.changed(session);}
 }
}
module.exports={NPCActionManager,ACTIONS};
