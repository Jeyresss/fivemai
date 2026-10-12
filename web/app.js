// Keep the push-to-talk controller and its consumer in the same NUI script.
class PushToTalk {
  constructor({send,track,status,now=()=>Date.now(),schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}) {
    Object.assign(this,{send,track,status,now,schedule,cancel});
    this.ready=false;this.held=false;this.recording=false;this.pending=false;this.generating=false;this.playing=false;this.releaseTimer=null;this.ackTimer=null;
    track.enabled=false;
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
let pc,stream,channel,ptt,timer,hideTimer,generation=0,held=false;
const post=(name,data={})=>fetch(`https://${GetParentResourceName()}/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function status(message){$('hud').hidden=false;$('status').textContent=message;}
function diagnostic(message){void post('diagnostic',{message}).catch(()=>{});}
function cleanup(){
  generation++;clearTimeout(timer);ptt?.dispose();
  const old=pc;pc=null;channel?.close();old?.close();
  stream?.getTracks().forEach(t=>t.stop());stream=channel=ptt=null;held=false;$('voice').srcObject=null;
}
function fail(message){cleanup();status(message);diagnostic(message);void post('close').catch(()=>{});}
async function connect(npc){
  cleanup();clearTimeout(hideTimer);$('name').textContent=npc.name;status('Connexion… Attendez avant de parler.');
  const run=generation;
  timer=setTimeout(()=>{if(run===generation)fail('Connexion expirée. Vérifiez le réseau WebRTC et consultez F8.');},30000);
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Le microphone WebRTC est indisponible dans cette NUI FiveM.');
    const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    if(run!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;const track=stream.getAudioTracks()[0];track.enabled=false;
    track.onended=()=>{if(run===generation)fail('Microphone déconnecté. Vérifiez votre périphérique audio.');};
    const peer=new RTCPeerConnection();pc=peer;
    peer.ontrack=e=>{
      $('voice').srcObject=e.streams[0] || new MediaStream([e.track]);
      $('voice').play().catch(()=>fail('Lecture audio refusée par FiveM. Consultez F8.'));
    };
    peer.addTrack(track,stream);channel=peer.createDataChannel('oai-events');
    ptt=new PushToTalk({send:e=>{if(channel?.readyState==='open')channel.send(JSON.stringify(e));},track,status});
    ptt.setHeld(held);
    channel.onopen=()=>{if(run!==generation)return;clearTimeout(timer);ptt.connected();};
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
  if(data.type==='open')void connect(data.npc);
  if(data.type==='ptt'){held=Boolean(data.held);ptt?.setHeld(held);}
  if(data.type==='answer' && pc){const run=generation;try{await pc.setRemoteDescription({type:'answer',sdp:data.sdp});}catch{if(run===generation)fail('Réponse WebRTC invalide.');}}
  if(data.type==='error')fail(data.message);
  if(data.type==='closed'){cleanup();hideTimer=setTimeout(()=>{$('hud').hidden=true;},8000);}
});

}
