// Keep the push-to-talk controller and its consumer in the same NUI script.
class PushToTalk {
  constructor({send,track,status,now=()=>Date.now(),schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}) {
    Object.assign(this,{send,track,status,now,schedule,cancel});
    this.ready=false;this.held=false;this.recording=false;this.pending=false;this.generating=false;this.playing=false;this.releaseTimer=null;this.ackTimer=null;
    track.enabled=false;
  }
  static captureError(error){
    if(error?.name==='NotAllowedError')return 'Accès microphone refusé par FiveM/Windows.';
    if(error?.name==='NotReadableError')return 'Microphone inaccessible (NotReadableError) : vérifiez son utilisation par les autres applications.';
    if(typeof error==='string'&&error.trim())return error;
    if(typeof error?.message==='string'&&error.message.trim())return error.message;
    return `Erreur de capture audio : ${error?.name||'cause inconnue'}${error?.constraint ? ' ('+error.constraint+')' : ''}.`;
  }
  static proximityVolume(distance,full=3,max=18){
    if(!Number.isFinite(distance) || !Number.isFinite(full) || !Number.isFinite(max) || max<=full)return 0;
    if(distance<=full)return 1;
    if(distance>=max)return 0;
    return Math.pow((max-distance)/(max-full),2);
  }
  static audioStats(report){
    let level=null,bytes=null;
    for(const item of report.values()){
      if(item.type==='media-source' && item.kind==='audio' && Number.isFinite(item.audioLevel)) level=Math.max(level||0,item.audioLevel);
      if(item.type==='outbound-rtp' && (item.kind==='audio'||item.mediaType==='audio') && Number.isFinite(item.bytesSent))bytes=(bytes||0)+item.bytesSent;
    }
    return {level,bytes};
  }
  connected(){this.ready=true;this.status('Connecté. Maintenez votre touche pour parler.');if(this.held)this.begin();}
  setHeld(held){if(held===this.held)return;this.held=held;if(held)this.begin();else this.end();}
  begin(){
    if(!this.ready)return;
    if(this.pending){this.status('Envoi de votre voix… Relâchez puis réessayez.');return;}
    if(this.generating){this.send({type:'response.cancel'});this.generating=false;}
    if(this.playing){this.send({type:'output_audio_buffer.clear'});this.playing=false;}
    this.send({type:'input_audio_buffer.clear'});
    this.started=this.now();this.recording=true;this.track.enabled=true;
    this.status('Le PNJ vous écoute… Relâchez pour obtenir sa réponse.');
  }
  end(){
    this.track.enabled=false;
    if(!this.recording)return;
    this.recording=false;
    if(this.now()-this.started<300){this.send({type:'input_audio_buffer.clear'});this.status('Prise de parole trop courte. Maintenez la touche et parlez.');return;}
    this.pending=true;this.status('Envoi de votre voix…');
    // Let the last RTP audio packets arrive before committing over the data channel.
    this.releaseTimer=this.schedule(()=>{
      this.releaseTimer=null;if(!this.ready)return;
      this.send({type:'input_audio_buffer.commit'});
      this.ackTimer=this.schedule(()=>{this.ackTimer=null;this.pending=false;this.status('OpenAI ne confirme pas la réception audio. Relâchez puis réessayez.');},8000);
    },250);
  }
  event(e){
    if(e.type==='input_audio_buffer.committed' && this.pending){if(this.ackTimer!==null)this.cancel(this.ackTimer);this.ackTimer=null;this.pending=false;this.generating=true;this.send({type:'response.create'});this.status('Le PNJ prépare sa réponse…');}
    if(e.type==='response.created')this.generating=true;
    if(e.type==='output_audio_buffer.started'){this.playing=true;this.status('Le PNJ répond…');}
    if(e.type==='output_audio_buffer.stopped' || e.type==='output_audio_buffer.cleared'){this.playing=false;if(!this.recording)this.status('Maintenez votre touche pour parler.');}
    if(e.type==='response.done'){this.generating=false;if(e.response?.status==='failed')this.status('Réponse OpenAI échouée. Consultez F8.');}
    if(e.type==='error'){this.pending=false;if(this.releaseTimer!==null)this.cancel(this.releaseTimer);this.releaseTimer=null;if(this.ackTimer!==null)this.cancel(this.ackTimer);this.ackTimer=null;}
  }
  dispose(){this.ready=false;this.held=false;this.recording=false;this.pending=false;this.track.enabled=false;if(this.releaseTimer!==null)this.cancel(this.releaseTimer);this.releaseTimer=null;if(this.ackTimer!==null)this.cancel(this.ackTimer);this.ackTimer=null;}
}

// PCM is captured from the OpenAI remote track, never from the player's mic.
// FiveM carries the same waveform to observers without another AI call.
class SharedVoiceAudio {
  static encode(samples){
    const bytes=new Uint8Array(samples.length*2),view=new DataView(bytes.buffer);
    for(let i=0;i<samples.length;i++){const v=Math.max(-1,Math.min(1,Number.isFinite(samples[i])?samples[i]:0));view.setInt16(i*2,Math.round(v*(v<0?32768:32767)),true);}
    if(typeof Buffer!=='undefined')return Buffer.from(bytes).toString('base64');
    let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw);
  }
  static decode(audio){
    if(typeof audio!=='string'||audio.length<4||audio.length>6400||audio.length%4||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio))return null;
    let bytes;
    try{bytes=typeof Buffer!=='undefined'?Buffer.from(audio,'base64'):Uint8Array.from(atob(audio),c=>c.charCodeAt(0));}catch{return null;}
    if(!bytes.length||bytes.length>4800||bytes.length%2)return null;
    const result=new Float32Array(bytes.length/2),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let i=0;i<result.length;i++)result[i]=view.getInt16(i*2,true)/32768;
    return result;
  }
  constructor({createContext,send,diagnostic=()=>{},now=()=>Date.now()}){
    Object.assign(this,{createContext,send,diagnostic,now});this.listeners=new Map();this.capture=null;this.context=null;
  }
  audioContext(){
    if(!this.context)this.context=this.createContext();
    if(this.context.state==='suspended')void this.context.resume().catch(()=>{});
    return this.context;
  }
  listen(data){
    if(typeof data?.token!=='string'||!data.token||data.token.length>100)return;
    if(this.listeners.has(data.token)){const s=this.listeners.get(data.token);if(Number.isSafeInteger(data.epoch)&&data.epoch>s.epoch)this.clear(data.token,data.epoch);return;}
    try{
      const context=this.audioContext(),gain=context.createGain();gain.gain.value=0;gain.connect(context.destination);
      this.listeners.set(data.token,{gain,epoch:data.epoch??0,seq:-1,next:0,sources:new Set()});
    }catch{this.diagnostic('Lecture de proximité indisponible : Web Audio non disponible dans FiveM.');}
  }
  proximity(data){const s=this.listeners.get(data.token);if(s)s.gain.gain.value=PushToTalk.proximityVolume(data.distance,data.fullDistance,data.maxDistance);}
  play(data){
    const s=this.listeners.get(data?.token);
    if(!s||data.sampleRate!==24000||(data.epoch??0)!==s.epoch||!Number.isSafeInteger(data.seq)||data.seq<0||data.seq<=s.seq)return false;
    const samples=SharedVoiceAudio.decode(data.audio);if(!samples)return false;
    const context=this.audioContext();s.seq=data.seq;
    if(context.state==='suspended'){s.next=0;return false;}
    // Never accumulate seconds of delayed dialogue if CEF/network stalls.
    if(s.next>context.currentTime+0.4)this.clear(data.token);
    const buffer=context.createBuffer(1,samples.length,24000);buffer.getChannelData(0).set(samples);
    const source=context.createBufferSource();source.buffer=buffer;source.connect(s.gain);
    const start=Math.max(context.currentTime+0.04,s.next);s.next=start+buffer.duration;s.sources.add(source);
    source.onended=()=>{s.sources.delete(source);source.disconnect();};source.start(start);return true;
  }
  clear(token,epoch){const s=this.listeners.get(token);if(!s||Number.isSafeInteger(epoch)&&epoch<s.epoch)return;for(const source of s.sources){try{source.stop();source.disconnect();}catch{}}s.sources.clear();s.next=0;if(Number.isSafeInteger(epoch)&&epoch>=s.epoch)s.epoch=epoch;}
  leave(token){this.clear(token);const s=this.listeners.get(token);if(s)s.gain.disconnect();this.listeners.delete(token);}
  owner(token,sessionId){if(this.capture){this.capture.token=token;this.capture.sessionId=sessionId;}}
  speaking(playing){if(this.capture){this.capture.until=playing?Infinity:this.now()+500;if(playing)this.capture.suppressed=false;}}
  cancelCapture(token,epoch){const c=this.capture;if(!c||token&&c.token!==token||Number.isSafeInteger(epoch)&&epoch<c.epoch)return;c.suppressed=true;c.until=0;c.queue.length=0;c.frame=[];c.input=[];c.phase=0;if(Number.isSafeInteger(epoch)&&epoch>=c.epoch)c.epoch=epoch;}
  captureRemote(stream,token,sessionId){
    this.stopCapture();
    try{
      const context=this.audioContext(),source=context.createMediaStreamSource(stream),processor=context.createScriptProcessor(4096,1,1),mute=context.createGain();
      mute.gain.value=0;source.connect(processor);processor.connect(mute);mute.connect(context.destination);
      const c={source,processor,mute,token,sessionId,epoch:0,seq:0,until:0,suppressed:false,input:[],phase:0,frame:[],queue:[],busy:false,closed:false};this.capture=c;
      processor.onaudioprocess=e=>{
        if(c.closed||c.suppressed)return;
        const incoming=e.inputBuffer.getChannelData(0);
        for(const sample of incoming)c.input.push(sample);
        const ratio=context.sampleRate/24000;
        while(c.phase<c.input.length-1){
          const i=Math.floor(c.phase),part=c.phase-i;c.frame.push(c.input[i]*(1-part)+c.input[i+1]*part);c.phase+=ratio;
          if(c.frame.length===2400){
            const frame=c.frame;c.frame=[];
            const audible=frame.some(v=>Math.abs(v)>0.0001);
            if(audible)c.until=Math.max(c.until,this.now()+500);
            if(c.token&&(audible||this.now()<c.until)){
              const packet={token:c.token,sessionId:c.sessionId,epoch:c.epoch,seq:c.seq++,sampleRate:24000,audio:SharedVoiceAudio.encode(frame)};
              if(c.queue.length===3)c.queue.shift();c.queue.push(packet);this.drain(c);
            }
          }
        }
        const used=Math.floor(c.phase);c.input=c.input.slice(used);c.phase-=used;
      };
    }catch{this.diagnostic('Relais audio de proximité indisponible : vérifiez la version CEF de FiveM.');}
  }
  drain(c){
    if(c.closed||c.busy||!c.queue.length)return;
    const packet=c.queue.shift();c.busy=true;
    Promise.resolve().then(()=>{if(!c.closed)return this.send(packet);}).catch(()=>{}).finally(()=>{c.busy=false;this.drain(c);});
  }
  stopCapture(){
    const c=this.capture;if(!c)return;c.closed=true;c.queue.length=0;c.processor.onaudioprocess=null;
    for(const node of [c.source,c.processor,c.mute])try{node.disconnect();}catch{}
    this.capture=null;
  }
}
PushToTalk.SharedVoiceAudio=SharedVoiceAudio;

if(typeof module !== 'undefined' && module.exports) module.exports=PushToTalk;
if(typeof document !== 'undefined') {
const $=id=>document.getElementById(id);
let pc,stream,channel,ptt,timer,hideTimer,generation=0,held=false,meterTimer=null,meterBusy=false,turnHealth=null,uiSession=null,voiceToken=null;
const post=(name,data={})=>fetch(`https://${GetParentResourceName()}/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function status(message){$('hud').hidden=false;$('status').textContent=typeof message==='string'&&message.trim()?message:'Erreur audio sans détail. Consultez F8.';}
function diagnostic(message){void post('diagnostic',{message:typeof message==='string'&&message.trim()?message:'Erreur audio sans détail. Consultez F8.'}).catch(()=>{});}
const sharedVoice=new SharedVoiceAudio({createContext:()=>{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error('Web Audio indisponible');return new Audio();},send:packet=>post('voiceFrame',packet),diagnostic});
async function inspectAudio(peer,run){
  if(meterBusy || run!==generation || !ptt?.recording || !peer.getStats)return;
  meterBusy=true;
  try{
    const sample=PushToTalk.audioStats(await peer.getStats());
    if(run!==generation || !ptt?.recording || !turnHealth)return;
    turnHealth.samples++;
    if(sample.level!==null){turnHealth.measured=true;turnHealth.peak=Math.max(turnHealth.peak,sample.level);$('level').textContent=`Micro : ${Math.round(Math.min(1,sample.level)*100)} %`;}
    else $('level').textContent='Niveau micro non disponible';
    if(sample.bytes!==null){turnHealth.firstBytes ??= sample.bytes;turnHealth.lastBytes=sample.bytes;}
  }catch{ /* Some CEF builds do not expose audio stats. */ }
  finally{meterBusy=false;}
}
function reportTurn(){
  if(!turnHealth)return;
  const t=turnHealth;turnHealth=null;$('level').textContent='';
  if(t.samples<2)return;
  const bytes=t.firstBytes!==null ? t.lastBytes-t.firstBytes : null;
  diagnostic(`Micro: niveau maximum=${t.measured ? (t.peak*100).toFixed(2)+'%' : 'indisponible'}, audio envoyé=${bytes===null ? 'indisponible' : bytes+' octets'}.`);
  if(t.measured && t.peak<0.001){$('level').textContent='Micro silencieux : vérifiez Windows ou lancez pnjmicro dans F8.';diagnostic('Aucun signal micro détecté pendant la prise de parole.');}
  else if(bytes===0){$('level').textContent='Aucun paquet audio envoyé. Vérifiez le réseau WebRTC; consultez F8.';}
}
async function microphones(index){
  let temporary;
  try{
    if(!navigator.mediaDevices?.enumerateDevices)throw new Error('Liste des microphones indisponible dans FiveM.');
    if(!stream)temporary=await navigator.mediaDevices.getUserMedia({audio:true});
    const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
    if(index!==undefined){
      const device=devices[index-1];if(!device)throw new Error('Numéro de microphone invalide. Lancez pnjmicro dans F8.');
      await post('microphone',{deviceId:device.deviceId,label:device.label||`Micro ${index}`});
    }else{
      diagnostic('Microphones Windows disponibles (sélection: pnjmicro NUMERO):');
      devices.forEach((d,i)=>diagnostic(`${i+1}. ${d.label || 'Microphone'}${d.deviceId==='default' ? ' [défaut Windows]' : ''}`));
    }
  }catch(e){diagnostic(e.message);}
  finally{temporary?.getTracks().forEach(t=>t.stop());}
}
function cleanup(resetHeld=true){
  generation++;clearTimeout(timer);clearInterval(meterTimer);meterTimer=null;turnHealth=null;$('level').textContent='';ptt?.dispose();
  const old=pc;pc=null;channel?.close();old?.close();
  sharedVoice.stopCapture();stream?.getTracks().forEach(t=>t.stop());stream=channel=ptt=null;if(resetHeld)held=false;$('voice').srcObject=null;
}
function fail(message){const sessionId=uiSession;cleanup();status(message);diagnostic(message);void post('close',{sessionId}).catch(()=>{});}
async function connect(npc,microphone,sessionId,token){
  cleanup(false);uiSession=sessionId;voiceToken=token||null;clearTimeout(hideTimer);$('name').textContent=npc.name;status('Connexion… Attendez avant de parler.');
  const run=generation;
  timer=setTimeout(()=>{if(run===generation)fail('Connexion expirée. Vérifiez le réseau WebRTC et consultez F8.');},30000);
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Le microphone WebRTC est indisponible dans cette NUI FiveM.');
    let media;
    const audio={echoCancellation:true,noiseSuppression:true,autoGainControl:true};
    try{media=await navigator.mediaDevices.getUserMedia({audio:{...audio,...(microphone ? {deviceId:{exact:microphone}} : {})}});}
    catch(error){
      if(!microphone || !['OverconstrainedError','NotFoundError'].includes(error?.name))throw error;
      if(run!==generation)return;
      diagnostic('Microphone enregistré indisponible : utilisation du microphone Windows par défaut. Resélectionnez-le avec pnjmicro si nécessaire.');
      media=await navigator.mediaDevices.getUserMedia({audio});
      if(run===generation)void post('microphoneFallback',{deviceId:microphone}).catch(()=>{});
    }
    if(run!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;const track=stream.getAudioTracks()[0];track.enabled=false;
    diagnostic(`Microphone utilisé : ${track.label || 'périphérique Windows par défaut'}; état=${track.readyState || 'inconnu'}.`);
    track.onmute=()=>diagnostic('Le système a suspendu la capture du microphone.');
    track.onended=()=>{if(run===generation)fail('Microphone déconnecté. Vérifiez votre périphérique audio.');};
    const peer=new RTCPeerConnection();pc=peer;
    peer.ontrack=e=>{
      if(run!==generation)return;
      const remote=e.streams[0] || new MediaStream([e.track]);$('voice').srcObject=remote;
      sharedVoice.captureRemote(remote,voiceToken,uiSession);
      $('voice').play().catch(()=>{if(run===generation)fail('Lecture audio refusée par FiveM. Consultez F8.');});
    };
    peer.addTrack(track,stream);channel=peer.createDataChannel('oai-events');
    ptt=new PushToTalk({send:e=>{if(channel?.readyState==='open')channel.send(JSON.stringify(e));},track,status});
    ptt.setHeld(held);
    channel.onopen=()=>{if(run!==generation)return;clearTimeout(timer);ptt.connected();void post('voiceReady',{npcId:npc.id,sessionId:uiSession}).catch(()=>{});if(ptt.recording)turnHealth={samples:0,measured:false,peak:0,firstBytes:null,lastBytes:null};meterTimer=setInterval(()=>void inspectAudio(peer,run),200);};
    channel.onclose=()=>{if(run===generation)fail('Canal vocal fermé. Relâchez puis réessayez.');};
    channel.onmessage=({data})=>{
      if(run!==generation)return;
      try{
        const e=JSON.parse(data);ptt.event(e);
        if(e.type==='output_audio_buffer.started')sharedVoice.speaking(true);
        if(e.type==='output_audio_buffer.stopped'||e.type==='output_audio_buffer.cleared')sharedVoice.speaking(false);
        if(e.type==='output_audio_buffer.cleared')sharedVoice.cancelCapture();
        if(e.type==='error'){
          const message=e.error?.message||'Erreur inconnue';
          status('Erreur audio OpenAI : '+message);diagnostic('OpenAI : '+message);
        }
        if(e.type==='response.done' && e.response?.status==='failed')diagnostic('Réponse échouée : '+JSON.stringify(e.response.status_details));
      }catch{diagnostic('Événement audio illisible.');}
    };
    peer.onconnectionstatechange=()=>{if(run===generation && ['failed','disconnected'].includes(peer.connectionState))fail('Connexion WebRTC interrompue. Consultez F8.');};
    const offer=await peer.createOffer();if(run!==generation)return;
    await peer.setLocalDescription(offer);if(run!==generation)return;
    await post('offer',{npcId:npc.id,sdp:offer.sdp,sessionId:uiSession});
  }catch(e){if(run===generation)fail(PushToTalk.captureError(e));}
}
window.addEventListener('message',async({data})=>{
  if(data.type==='open'){void post('opened',{sessionId:data.sessionId}).catch(()=>{});void connect(data.npc,data.microphone,data.sessionId,data.voiceToken);}
  if(data.type==='voiceOwner'&&(data.sessionId===undefined||data.sessionId===uiSession)){voiceToken=data.token;sharedVoice.owner(data.token,uiSession);}
  if(data.type==='voiceListen')sharedVoice.listen(data);
  if(data.type==='voiceAudio')sharedVoice.play(data);
  if(data.type==='voiceProximity')sharedVoice.proximity(data);
  if(data.type==='voiceClear'){sharedVoice.clear(data.token,data.epoch);sharedVoice.cancelCapture(data.token,data.epoch);}
  if(data.type==='voiceLeave')sharedVoice.leave(data.token);
  if(data.type==='notice'){status(data.message);clearTimeout(hideTimer);hideTimer=setTimeout(()=>{$('hud').hidden=true;},4000);}
  if(data.type==='proximity')$('voice').volume=PushToTalk.proximityVolume(data.distance,data.fullDistance,data.maxDistance);
  if(data.type==='microphones')void microphones(data.index);
  if(data.type==='ptt'){
    held=Boolean(data.held);
    if(!held)reportTurn();
    ptt?.setHeld(held);
    if(held && ptt?.recording)turnHealth={samples:0,measured:false,peak:0,firstBytes:null,lastBytes:null};
  }
  const current=data.sessionId===undefined||data.sessionId===uiSession;
  if(data.type==='answer' && pc && current){const run=generation;try{await pc.setRemoteDescription({type:'answer',sdp:data.sdp});}catch{if(run===generation)fail('Réponse WebRTC invalide.');}}
  if(data.type==='error' && current)fail(data.message);
  if(data.type==='closed' && current){cleanup();voiceToken=null;hideTimer=setTimeout(()=>{$('hud').hidden=true;},8000);}
});
// Announce readiness after the message handler exists so early key presses
// cannot leave Lua waiting on a UI that silently dropped its open message.
function announceReady(){void post('ready').catch(()=>setTimeout(announceReady,500));}
announceReady();

}
