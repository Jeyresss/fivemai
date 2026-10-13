'use strict';
const {openAIError}=require('./core');

/** Audio-provider boundary: gameplay never depends on provider credentials or SDK. */
class OpenAIRealtimeProvider {
 constructor({key,WebSocket,fetchImpl=globalThis.fetch,model='gpt-realtime'}){Object.assign(this,{key,WebSocket,fetchImpl,model});this.id='openai';}
 available(){return Boolean(this.key());}
 async open(sdp,session){
  const body=new FormData();body.set('sdp',sdp);body.set('session',JSON.stringify(session));
  const response=await this.fetchImpl('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:`Bearer ${this.key()}`},body,signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw await openAIError(response,this.key());
  const answer=await response.text(),callId=(response.headers.get('location')||'').split('/').pop();
  if(!/^rtc_[A-Za-z0-9_-]+$/.test(callId))throw new Error('Identifiant appel OpenAI absent');
  return {answer,callId};
 }
 socket(callId){return new this.WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,{headers:{Authorization:`Bearer ${this.key()}`},handshakeTimeout:10000});}
 async close(callId){
  if(!/^rtc_[A-Za-z0-9_-]+$/.test(callId||''))return;
  const response=await this.fetchImpl(`https://api.openai.com/v1/realtime/calls/${callId}/hangup`,{method:'POST',headers:{Authorization:`Bearer ${this.key()}`},signal:AbortSignal.timeout(10000)});
  if(response.ok===false)throw await openAIError(response,this.key());
 }
}

class ProviderRegistry {
 constructor(initial){this.providers=new Map();if(initial)this.register(initial);}
 register(provider){if(!provider||typeof provider.id!=='string'||!['available','open','socket','close'].every(name=>typeof provider[name]==='function'))throw new Error('Fournisseur vocal invalide');if(this.providers.has(provider.id))throw new Error('Fournisseur déjà enregistré');this.providers.set(provider.id,provider);}
 get(id='openai'){const provider=this.providers.get(id);if(!provider)throw new Error(`Fournisseur vocal indisponible : ${id}`);return provider;}
}
module.exports={OpenAIRealtimeProvider,ProviderRegistry};
