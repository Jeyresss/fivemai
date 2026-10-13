const {randomUUID}=require('node:crypto');

// One OpenAI call owns one waveform. Only its owner may relay that waveform;
// listeners receive playback packets and never acquire another AI session.
class SharedVoiceRelay {
  constructor({getPlayers,nearby,position,emit,now=()=>Date.now(),maxDistance=18,fullDistance=3,maxListeners=64,ownerValid=()=>true}){
    Object.assign(this,{getPlayers,nearby,position,emit,now,maxDistance,fullDistance,maxListeners,ownerValid});
    this.sessions=new Map();this.owners=new Map();
  }
  add(owner,npc,token=randomUUID()){
    owner=Number(owner);
    if(!Number.isInteger(owner)||owner<=0||!npc?.id||typeof token!=='string'||token.length>100||this.sessions.has(token))throw new Error('Session vocale partagée invalide');
    for(const s of this.sessions.values())if(s.npc.id===npc.id)throw new Error('Ce PNJ possède déjà une voix partagée');
    if(this.owners.has(owner))this.remove(this.owners.get(owner));
    this.sessions.set(token,{token,owner,npc,listeners:new Set(),seq:-1,epoch:0,credit:16800,packetCredit:4,at:this.now()});this.owners.set(owner,token);
    return token;
  }
  metadata(s){return {token:s.token,epoch:s.epoch,npcId:s.npc.id,netId:s.npc.netId,coords:this.position(s.npc),fullDistance:this.fullDistance,maxDistance:this.maxDistance};}
  discover(s){
    const recipients=new Set(),joined=new Set();
    for(const value of this.getPlayers()){
      const src=Number(value);
      if(!Number.isInteger(src)||src<=0||src===s.owner||recipients.size>=this.maxListeners||!this.nearby(src,s.npc,this.maxDistance))continue;
      recipients.add(src);
      if(!s.listeners.has(src)){joined.add(src);this.emit('fivemai:voiceListen',src,this.metadata(s));}
    }
    for(const src of s.listeners)if(!recipients.has(src))this.emit('fivemai:voiceLeave',src,{token:s.token});
    s.listeners=recipients;return joined;
  }
  tick(){
    for(const s of [...this.sessions.values()]){
      if(!this.ownerValid(s.owner,s.npc,s.token)||!this.position(s.npc)){this.remove(s.token);continue;}
      const joined=this.discover(s);
      for(const src of s.listeners)if(!joined.has(src))this.emit('fivemai:voiceListen',src,this.metadata(s));
    }
  }
  acceptFrame(src,data){
    const s=data&&this.sessions.get(data.token);
    if(!s||s.owner!==Number(src)||!this.ownerValid(s.owner,s.npc,s.token)||!this.position(s.npc))return false;
    if(!Number.isSafeInteger(data.seq)||data.seq<0||data.seq>2147483647||data.seq<=s.seq||data.sampleRate!==24000||(data.epoch??0)!==s.epoch)return false;
    if(typeof data.audio!=='string'||data.audio.length<4||data.audio.length>6400||data.audio.length%4||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.audio))return false;
    const pcm=Buffer.from(data.audio,'base64');
    if(!pcm.length||pcm.length>4800||pcm.length%2||pcm.toString('base64')!==data.audio)return false;
    const now=this.now(),elapsed=Math.max(0,now-s.at);s.credit=Math.min(16800,s.credit+elapsed*48);s.packetCredit=Math.min(4,s.packetCredit+elapsed/100);s.at=now;
    if(pcm.length>s.credit||s.packetCredit<1)return false;
    s.credit-=pcm.length;s.packetCredit-=1;s.seq=data.seq;
    this.discover(s);
    const packet={token:s.token,epoch:s.epoch,seq:data.seq,sampleRate:24000,audio:data.audio};
    for(const target of s.listeners)this.emit('fivemai:voiceAudio',target,packet);
    return true;
  }
  clear(token){
    const s=this.sessions.get(token);if(!s)return false;
    s.epoch++;
    // Filter again: recipients may have moved or changed routing buckets.
    this.discover(s);
    this.emit('fivemai:voiceClear',s.owner,{token,epoch:s.epoch});
    for(const src of s.listeners)this.emit('fivemai:voiceClear',src,{token,epoch:s.epoch});
    return true;
  }
  remove(token){
    const s=this.sessions.get(token);if(!s)return false;
    for(const src of s.listeners){this.emit('fivemai:voiceClear',src,{token});this.emit('fivemai:voiceLeave',src,{token});}
    this.sessions.delete(token);if(this.owners.get(s.owner)===token)this.owners.delete(s.owner);return true;
  }
}
module.exports={SharedVoiceRelay};
