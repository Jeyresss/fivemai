// These hooks are registered by trusted server resources. No client or model
// can register an adapter, specify a balance, or provide payment evidence.
class AdapterRegistry{
 constructor(){this.adapters=new Map();}
 register(name,adapter){if(typeof name!=='string'||!name||name.length>64||!adapter||typeof adapter!=='object'||Array.isArray(adapter))throw new Error('Adaptateur invalide');if(this.adapters.has(name))throw new Error('Adaptateur déjà enregistré');const functions=Object.entries(adapter).filter(([key])=>key!=='description');if(!functions.length||functions.some(([,fn])=>typeof fn!=='function'))throw new Error('Les hooks doivent être des fonctions serveur');this.adapters.set(name,adapter);return true;}
 has(name,hook){return typeof this.adapters.get(name)?.[hook]==='function';}
 async call(name,hook,...args){const fn=this.adapters.get(name)?.[hook];if(typeof fn!=='function')throw new Error('Hook serveur indisponible');return fn(...args);}
 list(){return [...this.adapters].map(([name,adapter])=>({name,hooks:Object.keys(adapter).filter(k=>typeof adapter[k]==='function'),description:adapter.description||''}));}
}
module.exports={AdapterRegistry};
