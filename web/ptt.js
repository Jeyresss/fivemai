// Manual audio turns: no transcription, no automatic VAD response.
(function(root){
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
if(typeof module!=='undefined' && module.exports)module.exports=PushToTalk;
else root.PushToTalk=PushToTalk;
})(globalThis);
