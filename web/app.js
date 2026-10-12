// Keep the push-to-talk controller and its consumer in the same NUI script.
class PushToTalk {
  constructor({send,track,status,now=()=>Date.now(),schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}) {
    Object.assign(this,{send,track,status,now,schedule,cancel});
    this.ready=false;this.held=false;this.recording=false;this.pending=false;this.generating=false;this.playing=false;this.releaseTimer=null;this.ackTimer=null;
    track.enabled=false;
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
    if(e.type==='error'){this.pending=false;if(this.ackTimer!==null)this.cancel(this.ackTimer);this.ackTimer=null;}
  }
  dispose(){this.ready=false;this.held=false;this.recording=false;this.pending=false;this.track.enabled=false;if(this.releaseTimer!==null)this.cancel(this.releaseTimer);this.releaseTimer=null;if(this.ackTimer!==null)this.cancel(this.ackTimer);this.ackTimer=null;}
}

if(typeof module !== 'undefined' && module.exports) module.exports=PushToTalk;
if(typeof document !== 'undefined') {
const $=id=>document.getElementById(id);
let pc,stream,channel,ptt,timer,hideTimer,generation=0,held=false,meterTimer=null,meterBusy=false,turnHealth=null;
const post=(name,data={})=>fetch(`https://${GetParentResourceName()}/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function status(message){$('hud').hidden=false;$('status').textContent=message;}
function diagnostic(message){void post('diagnostic',{message}).catch(()=>{});}
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
function cleanup(){
  generation++;clearTimeout(timer);clearInterval(meterTimer);meterTimer=null;turnHealth=null;$('level').textContent='';ptt?.dispose();
  const old=pc;pc=null;channel?.close();old?.close();
  stream?.getTracks().forEach(t=>t.stop());stream=channel=ptt=null;held=false;$('voice').srcObject=null;
}
function fail(message){cleanup();status(message);diagnostic(message);void post('close').catch(()=>{});}
async function connect(npc,microphone){
  cleanup();clearTimeout(hideTimer);$('name').textContent=npc.name;status('Connexion… Attendez avant de parler.');
  const run=generation;
  timer=setTimeout(()=>{if(run===generation)fail('Connexion expirée. Vérifiez le réseau WebRTC et consultez F8.');},30000);
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Le microphone WebRTC est indisponible dans cette NUI FiveM.');
    const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,...(microphone ? {deviceId:{exact:microphone}} : {})}});
    if(run!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;const track=stream.getAudioTracks()[0];track.enabled=false;
    diagnostic(`Microphone utilisé : ${track.label || 'périphérique Windows par défaut'}; état=${track.readyState || 'inconnu'}.`);
    track.onmute=()=>diagnostic('Le système a suspendu la capture du microphone.');
    track.onended=()=>{if(run===generation)fail('Microphone déconnecté. Vérifiez votre périphérique audio.');};
    const peer=new RTCPeerConnection();pc=peer;
    peer.ontrack=e=>{
      $('voice').srcObject=e.streams[0] || new MediaStream([e.track]);
      $('voice').play().catch(()=>fail('Lecture audio refusée par FiveM. Consultez F8.'));
    };
    peer.addTrack(track,stream);channel=peer.createDataChannel('oai-events');
    ptt=new PushToTalk({send:e=>{if(channel?.readyState==='open')channel.send(JSON.stringify(e));},track,status});
    ptt.setHeld(held);
    channel.onopen=()=>{if(run!==generation)return;clearTimeout(timer);ptt.connected();if(ptt.recording)turnHealth={samples:0,measured:false,peak:0,firstBytes:null,lastBytes:null};meterTimer=setInterval(()=>void inspectAudio(peer,run),200);};
    channel.onclose=()=>{if(run===generation)fail('Canal vocal fermé. Relâchez puis réessayez.');};
    channel.onmessage=({data})=>{
      if(run!==generation)return;
      try{
        const e=JSON.parse(data);ptt.event(e);
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
    await post('offer',{npcId:npc.id,sdp:offer.sdp});
  }catch(e){if(run===generation)fail(e.name==='NotAllowedError'?'Accès microphone refusé par FiveM/Windows. Consultez F8.':e.message);}
}
window.addEventListener('message',async({data})=>{
  if(data.type==='open'){void post('opened',{sessionId:data.sessionId}).catch(()=>{});void connect(data.npc,data.microphone);}
  if(data.type==='notice'){status(data.message);clearTimeout(hideTimer);hideTimer=setTimeout(()=>{$('hud').hidden=true;},4000);}
  if(data.type==='proximity')$('voice').volume=PushToTalk.proximityVolume(data.distance,data.fullDistance,data.maxDistance);
  if(data.type==='microphones')void microphones(data.index);
  if(data.type==='ptt'){
    held=Boolean(data.held);
    if(!held)reportTurn();
    ptt?.setHeld(held);
    if(held && ptt?.recording)turnHealth={samples:0,measured:false,peak:0,firstBytes:null,lastBytes:null};
  }
  if(data.type==='answer' && pc){const run=generation;try{await pc.setRemoteDescription({type:'answer',sdp:data.sdp});}catch{if(run===generation)fail('Réponse WebRTC invalide.');}}
  if(data.type==='error')fail(data.message);
  if(data.type==='closed'){cleanup();hideTimer=setTimeout(()=>{$('hud').hidden=true;},8000);}
});
// Announce readiness after the message handler exists so early key presses
// cannot leave Lua waiting on a UI that silently dropped its open message.
function announceReady(){void post('ready').catch(()=>setTimeout(announceReady,500));}
announceReady();

}
