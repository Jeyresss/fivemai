const crypto=require('node:crypto');
const COLOURS={red:[220,30,30],blue:[30,70,220],black:[15,15,15],white:[240,240,240],green:[30,160,60],yellow:[240,200,20],orange:[230,100,20],purple:[130,40,180]};
function normalizePlate(plate){return typeof plate==='string'?plate.toUpperCase().replace(/[\s-]/g,''):'';}
function selectVehicle(candidates,{plate,selected}={}){
 const ordered=[...candidates].sort((a,b)=>a.distance-b.distance);
 if(selected){
  const found=ordered.find(v=>v.netId===selected.netId&&normalizePlate(v.plate)===normalizePlate(selected.plate)&&(selected.entity===undefined||v.entity===selected.entity)&&(selected.model===undefined||v.model===selected.model));
  if(!found)throw new Error('Le véhicule du devis a disparu, changé ou quitté la zone');
  return found;
 }
 if(plate){
  const matches=ordered.filter(v=>normalizePlate(v.plate)===normalizePlate(plate));
  if(matches.length===0)throw new Error('Aucun véhicule proche ne porte cette plaque');
  if(matches.length>1)throw new Error('Plusieurs véhicules portent cette plaque; éloignez les autres véhicules');
  return matches[0];
 }
 if(!ordered.length)throw new Error('Aucun véhicule proche du mécanicien');
 if(ordered.length>1)return {needsPlate:true,candidates:ordered.slice(0,10).map(v=>({plate:v.plate,distance:Math.round(v.distance*10)/10})),instruction:'Plusieurs véhicules sont présents. Demandez au joueur la plaque et rappelez mechanic_quote avec cette plaque. Ne choisissez pas à sa place.'};
 return ordered[0];
}
class JobRegistry {
 constructor(){this.jobs=new Map();}
 register(job){
  if(!job || typeof job.id!=='string' || !Array.isArray(job.tools) || typeof job.execute!=='function')throw new Error('Métier invalide');
  if(this.jobs.has(job.id))throw new Error('Métier déjà enregistré');
  for(const tool of job.tools){
   if(tool.type!=='function'||!tool.name||['remember_memory','npc_action','driver_trip'].includes(tool.name))throw new Error('Outil métier invalide');
   for(const current of this.jobs.values())if(current.tools.some(t=>t.name===tool.name))throw new Error('Nom outil déjà enregistré');
  }
  this.jobs.set(job.id,job);
 }
 tools(jobId){return this.jobs.get(jobId)?.tools||[];}
 async execute(jobId,name,context,args){const job=this.jobs.get(jobId);if(!job?.tools.some(t=>t.name===name))throw new Error('Ce métier ne permet pas cette action');return job.execute(name,context,args);}
}
class MechanicJob {
 constructor({inspect,apply,remember=()=>{},now=()=>Date.now(),economy,identity=ctx=>ctx.session.player,relation=()=>0,config={}}){Object.assign(this,{inspect,apply,remember,now,economy,identity,relation,config});this.id='mechanic';this.label='Mécanicien';this.quotes=new Map();this.busy=new WeakSet();this.active=new Map();this.upgrades=config.upgrades||{};
  this.tools=[
   {type:'function',name:'mechanic_quote',description:'Proposer un devis pour un véhicule proche. Sans plaque, choisir le seul véhicule présent; si plusieurs sont présents demander sa plaque. Réparation, peinture ou amélioration autorisée; demander un accord explicite avant intervention.',parameters:{type:'object',properties:{plate:{type:'string'},service:{type:'string',enum:['repair','repaint','upgrade']},colour:{type:'string',enum:Object.keys(COLOURS)},upgrade:{type:'string',enum:Object.keys(this.upgrades).length?Object.keys(this.upgrades):['none']}},required:['service'],additionalProperties:false}},
   {type:'function',name:'mechanic_perform',description:'Exécuter un devis après accord explicite du joueur. Les fonds sont réservés; débit seulement après résultat vérifié, remboursement si interrompu. Ne pas annoncer une réussite avant le résultat.',parameters:{type:'object',properties:{quoteId:{type:'string'},confirmed:{type:'boolean'}},required:['quoteId','confirmed'],additionalProperties:false}}
  ];
 }
 async execute(name,ctx,args){
  if((Number(this.relation(ctx))||0)<-60)throw new Error('Ce personnage refuse de rendre service à ce joueur');
  if(this.busy.has(ctx.session))throw new Error('Une intervention est déjà en cours');
  if(name==='mechanic_quote'){
   if(!['repair','repaint','upgrade'].includes(args.service))throw new Error('Service inconnu');
   if(args.service==='repaint'&&!Object.hasOwn(COLOURS,args.colour))throw new Error('Couleur requise: rouge, bleu, noir, blanc, vert, jaune, orange ou violet');
   const upgrade=args.service==='upgrade'?this.upgrades[args.upgrade]:null;
   if(args.service==='upgrade'&&(!upgrade||!Number.isInteger(upgrade.slot)||upgrade.slot<0||upgrade.slot>49||!Number.isInteger(upgrade.level)||upgrade.level<0||upgrade.level>10))throw new Error('Amélioration non autorisée');
   for(const [id,q]of this.quotes)if(q.session===ctx.session||q.expires<=this.now())this.quotes.delete(id);
   const vehicle=await this.inspect(ctx,{plate:args.plate});if(vehicle.needsPlate)return {ok:false,...vehicle};
   const base=this.economy?(upgrade?.price??this.config.prices?.[args.service]??(args.service==='repair'?250:args.service==='repaint'?300:500)):0;
   if(!Number.isSafeInteger(base)||base<0)throw new Error('Tarif de service invalide');
   const discount=Math.max(0,Math.min(0.2,(Number(this.relation(ctx))||0)/500)),price=Math.round(base*(1-discount));
   const quote={id:crypto.randomUUID(),src:ctx.src,session:ctx.session,player:this.economy?this.identity(ctx):undefined,vehicle,service:args.service,colour:args.service==='repaint'?COLOURS[args.colour]:null,upgrade:upgrade?{slot:upgrade.slot,level:upgrade.level,id:args.upgrade}:null,price,expires:this.now()+60000};this.quotes.set(quote.id,quote);
   return {ok:true,quoteId:quote.id,service:quote.service,colour:args.colour,upgrade:args.upgrade,price,currency:this.economy?'$':'service gratuit (sans économie configurée)',expiresInSeconds:60,vehicle:vehicle.plate,requiresExplicitAgreement:true};
  }
  if(name!=='mechanic_perform')throw new Error('Action inconnue');
  const q=this.quotes.get(args.quoteId);if(!q||q.src!==ctx.src||q.session!==ctx.session||q.expires<=this.now())throw new Error('Devis invalide ou expiré');if(args.confirmed!==true)throw new Error('Accord du joueur nécessaire');
  this.busy.add(ctx.session);this.active.set(ctx.session,q);
  let payment;
  try{
   if((await this.inspect(ctx,{selected:q.vehicle})).netId!==q.vehicle.netId)throw new Error('Le véhicule a changé');
   if(this.economy){payment=await this.economy.reserve(q.player,`mechanic:${q.id}`,q.price,{kind:'mechanic',npc:ctx.session.npc?.id,service:q.service,plate:q.vehicle.plate});if(payment.status!=='reserved')throw new Error('Paiement déjà interrompu');}
   this.quotes.delete(q.id);const result=await this.apply(ctx,q);
   if(!result?.ok||q.cancelled){if(payment)await this.economy.refund(payment.id,'interrupted');return {ok:false,error:result?.error||'Intervention interrompue'};}
   if(payment)await this.economy.capture(payment.id);
   let memorySaved=true;try{this.remember(ctx,`Service terminé: ${q.service==='repair'?'réparation':q.service==='repaint'?'peinture':'amélioration'} du véhicule ${q.vehicle.plate}. Prix: ${q.price} $.`);}catch{memorySaved=false;}
   return {ok:true,completed:true,service:q.service,vehicle:q.vehicle.plate,paid:q.price,memorySaved};
  }catch(error){if(payment)await this.economy.refund(payment.id,error.message);throw error;}finally{this.busy.delete(ctx.session);this.active.delete(ctx.session);}
 }
 forget(session){for(const [id,q]of this.quotes)if(q.session===session)this.quotes.delete(id);const active=this.active.get(session);if(active)active.cancelled=true;}
}
// Tool results may arrive asynchronously; resume the voice only once all
// results are delivered and the previous model response has ended.
class ToolTurnCoordinator {
 constructor(resume){this.resume=resume;this.pending=0;this.finished=false;this.outputs=false;}
 created(){this.finished=false;}
 done(){this.finished=true;this.flush();}
 begin(){this.pending++;}
 complete(){this.pending--;this.outputs=true;this.flush();}
 flush(){if(this.finished&&this.pending===0&&this.outputs){this.finished=false;this.outputs=false;this.resume();}}
}
module.exports={JobRegistry,MechanicJob,COLOURS,ToolTurnCoordinator,normalizePlate,selectVehicle};
