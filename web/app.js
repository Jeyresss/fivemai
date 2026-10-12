const $=id=>document.getElementById(id);
let npc,pc,stream,channel,timer,muted=false,generation=0;
const post=(name,data={})=>fetch(`https://${GetParentResourceName()}/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function cleanup(){generation++;clearTimeout(timer);channel?.close();pc?.close();stream?.getTracks().forEach(t=>t.stop());pc=stream=channel=null;$('voice').srcObject=null;$('mute').disabled=true;}
async function close(){cleanup();$('panel').hidden=true;await post('close');}
$('close').onclick=close;
document.addEventListener('keydown',e=>{if(e.key==='Escape') void close();});
$('mute').onclick=()=>{muted=!muted;stream?.getAudioTracks().forEach(t=>t.enabled=!muted);$('mute').textContent=muted?'Réactiver mon micro':'Couper mon micro';};
$('start').onclick=async()=>{
  $('start').disabled=true;
  const run=++generation;
  try {
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Le microphone WebRTC est indisponible dans cette NUI FiveM.');
    const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    if(run!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;muted=false;$('mute').textContent='Couper mon micro';
    pc=new RTCPeerConnection();
    pc.ontrack=e=>{$('voice').srcObject=e.streams[0];$('voice').play().catch(()=>{$('status').textContent='Cliquez ici pour autoriser la lecture audio.';$('status').onclick=()=>void $('voice').play();});};
    stream.getTracks().forEach(t=>pc.addTrack(t,stream));
    channel=pc.createDataChannel('oai-events');
    channel.onopen=()=>{clearTimeout(timer);$('status').textContent='À vous de parler…';$('mute').disabled=false;};
    channel.onmessage=({data})=>{
      const e=JSON.parse(data);
      if(e.type==='error'){$('status').textContent='Erreur audio OpenAI : '+(e.error?.message||'inconnue');}
      if(e.type==='input_audio_buffer.speech_started') $('status').textContent='Le PNJ vous écoute…';
      if(e.type==='response.output_audio.delta') $('status').textContent='Le PNJ répond…';
      if(e.type==='response.done') $('status').textContent='À vous de parler…';
    };
    pc.onconnectionstatechange=()=>{if(pc && ['failed','disconnected','closed'].includes(pc.connectionState)){cleanup();$('status').textContent='Conversation interrompue.';void post('close');}};
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    $('status').textContent='Connexion vocale…';
    timer=setTimeout(()=>{cleanup();$('status').textContent='Connexion expirée.';void post('close');},30000);
    await post('offer',{npcId:npc.id,sdp:offer.sdp});
  }catch(e){cleanup();$('status').textContent=e.message;$('start').disabled=false;void post('close');}
};
window.addEventListener('message',async({data})=>{
  if(data.type==='open'){cleanup();npc=data.npc;$('name').textContent=npc.name;$('job').textContent=npc.job;$('status').dataset.error='';$('status').textContent='Prêt à discuter';$('start').disabled=false;$('panel').hidden=false;}
  if(data.type==='answer' && pc){try{await pc.setRemoteDescription({type:'answer',sdp:data.sdp});}catch{cleanup();$('status').textContent='Réponse WebRTC invalide.';void post('close');}}
  if(data.type==='error'){cleanup();$('status').textContent=data.message;$('status').dataset.error='yes';$('start').disabled=false;}
  if(data.type==='closed'){cleanup();if(!$('status').dataset.error) $('status').textContent='Conversation terminée. Échap pour fermer.';}
});
