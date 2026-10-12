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
   if(tool.type!=='function'||!tool.name||tool.name==='remember_memory')throw new Error('Outil métier invalide');
   for(const current of this.jobs.values())if(current.tools.some(t=>t.name===tool.name))throw new Error('Nom outil déjà enregistré');
  }
  this.jobs.set(job.id,job);
 }
 tools(jobId){return this.jobs.get(jobId)?.tools||[];}
 async execute(jobId,name,context,args){const job=this.jobs.get(jobId);if(!job?.tools.some(t=>t.name===name))throw new Error('Ce métier ne permet pas cette action');return job.execute(name,context,args);}
}
class MechanicJob {
 constructor({inspect,apply,remember,now=()=>Date.now()}){Object.assign(this,{inspect,apply,remember,now});this.id='mechanic';this.label='Mécanicien';this.quotes=new Map();this.busy=new WeakSet();
  this.tools=[
   {type:'function',name:'mechanic_quote',description:'Proposer un devis gratuit pour un véhicule proche, même si le joueur est à pied. Sans plaque, choisir le seul véhicule présent; si plusieurs sont présents, demander la plaque au joueur puis rappeler cet outil. Demander son accord avant toute intervention.',parameters:{type:'object',properties:{plate:{type:'string',description:'Plaque fournie par le joueur si plusieurs véhicules sont présents. Ne pas inventer de plaque.'},service:{type:'string',enum:['repair','repaint']},colour:{type:'string',enum:Object.keys(COLOURS)}},required:['service'],additionalProperties:false}},
   {type:'function',name:'mechanic_perform',description:'Exécuter un devis seulement après accord explicite du joueur. Ne jamais annoncer une réussite avant le résultat de cet outil.',parameters:{type:'object',properties:{quoteId:{type:'string'},confirmed:{type:'boolean'}},required:['quoteId','confirmed'],additionalProperties:false}}
  ];
 }
 async execute(name,ctx,args){
  if(this.busy.has(ctx.session))throw new Error('Une intervention est déjà en cours');
  if(name==='mechanic_quote'){
   if(!['repair','repaint'].includes(args.service))throw new Error('Service inconnu');
   if(args.service==='repaint'&&!Object.hasOwn(COLOURS,args.colour))throw new Error('Couleur requise: rouge, bleu, noir, blanc, vert, jaune, orange ou violet');
   for(const [id,q]of this.quotes)if(q.session===ctx.session||q.expires<=this.now())this.quotes.delete(id);
   const vehicle=this.inspect(ctx,{plate:args.plate});
   if(vehicle.needsPlate)return {ok:false,...vehicle};
   const quote={id:crypto.randomUUID(),src:ctx.src,session:ctx.session,vehicle,service:args.service,colour:args.service==='repaint'?COLOURS[args.colour]:null,expires:this.now()+60000};
   this.quotes.set(quote.id,quote);
   return {ok:true,quoteId:quote.id,service:quote.service,colour:args.colour,price:0,currency:'service gratuit (prototype sans économie)',expiresInSeconds:60,vehicle:vehicle.plate,requiresExplicitAgreement:true};
  }
  if(name!=='mechanic_perform')throw new Error('Action inconnue');
  const q=this.quotes.get(args.quoteId);
  if(!q||q.src!==ctx.src||q.session!==ctx.session||q.expires<=this.now())throw new Error('Devis invalide ou expiré');
  if(args.confirmed!==true)throw new Error('Accord du joueur nécessaire');
  if(this.inspect(ctx,{selected:q.vehicle}).netId!==q.vehicle.netId)throw new Error('Le véhicule a changé');
  this.quotes.delete(q.id);
  this.busy.add(ctx.session);
  try{
  const result=await this.apply(ctx,q);
  if(!result.ok)return result;
  this.remember(ctx,`Service terminé: ${q.service==='repair'?'réparation':'peinture'} du véhicule ${q.vehicle.plate}. Intervention gratuite.`);
  return {ok:true,completed:true,service:q.service,vehicle:q.vehicle.plate};
  }finally{this.busy.delete(ctx.session);}
 }
 forget(session){for(const [id,q]of this.quotes)if(q.session===session)this.quotes.delete(id);}
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
