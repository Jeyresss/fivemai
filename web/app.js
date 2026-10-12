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
