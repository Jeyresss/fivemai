const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SharedVoiceRelay}=require('../server/voice');
const PushToTalk=require('../web/app');
const {SharedVoiceAudio}=PushToTalk;
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');

function relay(){
  let time=1000;const events=[],players=['7','8','9','10'],near=new Map([[7,true],[8,true],[9,false],[10,false]]),npc={id:'marcel',netId:101};
  const voice=new SharedVoiceRelay({getPlayers:()=>players,nearby:(src)=>near.get(src)===true,position:()=>({x:1,y:2,z:3}),emit:(...event)=>events.push(event),now:()=>time});
  const token=voice.add(7,npc,'voice-test');
  return {voice,events,near,players,npc,token,advance:ms=>time+=ms,frame:(seq=0)=>({token,seq,sampleRate:24000,audio:SharedVoiceAudio.encode(new Float32Array(2400).fill(0.25))})};
}
test('one owner waveform reaches only nearby observers without another call',()=>{
  const f=relay();assert.equal(f.voice.acceptFrame(7,f.frame()),true);
  assert.deepEqual(f.events.map(e=>[e[0],e[1]]),[['fivemai:voiceListen',8],['fivemai:voiceAudio',8]]);
  assert.equal(f.events[1][2].audio,f.frame().audio);assert.equal(f.voice.sessions.size,1);
  f.near.set(8,false);f.near.set(9,true);f.advance(100);assert.equal(f.voice.acceptFrame(7,f.frame(1)),true);
  assert.equal(f.events.at(-1)[1],9);assert.ok(f.events.some(e=>e[0]==='fivemai:voiceLeave'&&e[1]===8));
  assert.ok(!f.events.some(e=>e[0]==='fivemai:voiceAudio'&&e[1]===7));
});
test('voice frames reject other owners, stale tokens, replay and unsupported audio',()=>{
  const f=relay();assert.equal(f.voice.acceptFrame(8,f.frame()),false);assert.equal(f.voice.acceptFrame(7,{...f.frame(),token:'wrong'}),false);
  for(const changed of [{sampleRate:48000},{seq:NaN},{seq:-1},{audio:'invalid'},{audio:Buffer.alloc(4802).toString('base64')},{audio:Buffer.alloc(3).toString('base64')}])assert.equal(f.voice.acceptFrame(7,{...f.frame(),...changed}),false);
  assert.equal(f.events.length,0);assert.equal(f.voice.acceptFrame(7,f.frame()),true);assert.equal(f.voice.acceptFrame(7,f.frame()),false);
  f.voice.remove(f.token);assert.equal(f.voice.acceptFrame(7,f.frame(1)),false);
});
test('relay bounds a burst and allows only the real-time PCM byte rate',()=>{
  const f=relay();for(let i=0;i<3;i++)assert.equal(f.voice.acceptFrame(7,f.frame(i)),true);
  assert.equal(f.voice.acceptFrame(7,f.frame(3)),false);f.advance(100);assert.equal(f.voice.acceptFrame(7,f.frame(3)),true);
});
test('listener movement and routing authorization apply to cancellation too',()=>{
  const f=relay();f.voice.tick();f.events.length=0;f.near.set(8,false);f.near.set(9,true);f.voice.clear(f.token);
  assert.ok(!f.events.some(e=>e[0]==='fivemai:voiceClear'&&e[1]===8));assert.ok(f.events.some(e=>e[0]==='fivemai:voiceClear'&&e[1]===9));
  assert.throws(()=>f.voice.add(8,f.npc,'another-token'),/déjà/);f.voice.remove(f.token);assert.equal(f.voice.sessions.size,0);assert.equal(f.voice.owners.size,0);
});
test('cancellation rejects in-flight packets from the preceding audio epoch',()=>{
  const f=relay();f.voice.acceptFrame(7,f.frame());f.voice.clear(f.token);f.advance(100);
  assert.equal(f.voice.acceptFrame(7,f.frame(1)),false);assert.equal(f.voice.acceptFrame(7,{...f.frame(1),epoch:1}),true);
  const control=f.events.find(e=>e[0]==='fivemai:voiceClear'&&e[1]===7);assert.equal(control[2].epoch,1);
});
test('small packets cannot evade the packet frequency bound',()=>{
  const f=relay(),small=SharedVoiceAudio.encode(new Float32Array(1));
  for(let seq=0;seq<4;seq++)assert.equal(f.voice.acceptFrame(7,{...f.frame(seq),audio:small}),true);
  assert.equal(f.voice.acceptFrame(7,{...f.frame(4),audio:small}),false);
});

function audioHarness(){
  const sources=[],processors=[],sent=[];let sourceStream;
  const context={sampleRate:48000,currentTime:1,state:'running',destination:{},resume:async()=>{},
    createGain:()=>({gain:{value:0},connect(){},disconnect(){}}),
    createBuffer:(channels,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),
    createBufferSource:()=>{const s={connect(){},disconnect(){this.disconnected=true;},start(at){this.started=at;},stop(){this.stopped=true;}};sources.push(s);return s;},
    createMediaStreamSource:stream=>{sourceStream=stream;return {connect(){},disconnect(){}};},
    createScriptProcessor:()=>{const p={connect(){},disconnect(){}};processors.push(p);return p;}};
  const audio=new SharedVoiceAudio({createContext:()=>context,send:p=>{sent.push(p);},now:()=>1000});
  return {audio,context,sources,processors,sent,get sourceStream(){return sourceStream;}};
}
test('PCM conversion preserves the remote waveform and rejects malformed packets',()=>{
  const values=Float32Array.from([-1,-0.5,0,0.5,1]);const actual=SharedVoiceAudio.decode(SharedVoiceAudio.encode(values));
  for(let i=0;i<values.length;i++)assert.ok(Math.abs(values[i]-actual[i])<0.00004);
  assert.equal(SharedVoiceAudio.decode('invalid'),null);assert.equal(SharedVoiceAudio.decode(Buffer.alloc(3).toString('base64')),null);
});
test('observer playback schedules one stream and clear cancels buffered audio',()=>{
  const f=audioHarness(),packet={token:'shared',seq:1,sampleRate:24000,audio:SharedVoiceAudio.encode(new Float32Array(2400))};
  f.audio.listen({token:'shared'});f.audio.proximity({token:'shared',distance:2,fullDistance:3,maxDistance:18});
  assert.equal(f.audio.listeners.get('shared').gain.gain.value,1);assert.equal(f.audio.play(packet),true);assert.equal(f.sources[0].started,1.04);assert.equal(f.audio.play(packet),false);
  assert.equal(f.audio.play({...packet,seq:2}),true);assert.ok(f.sources[1].started>=1.14);
  f.audio.clear('shared');assert.ok(f.sources.every(s=>s.stopped));f.audio.leave('shared');assert.equal(f.audio.listeners.size,0);
});
test('stalled observers cannot accumulate seconds of old dialogue',()=>{
  const f=audioHarness();f.audio.listen({token:'shared'});
  for(let seq=0;seq<7;seq++)f.audio.play({token:'shared',seq,sampleRate:24000,audio:SharedVoiceAudio.encode(new Float32Array(2400))});
  assert.ok(f.sources.some(s=>s.stopped));assert.ok(f.audio.listeners.get('shared').next<=f.context.currentTime+0.45);
});
test('owner capture uses only its remote media stream and resamples it once',async()=>{
  const f=audioHarness(),remote={role:'OpenAI remote output'};f.audio.captureRemote(remote,'shared',23);
  assert.equal(f.sourceStream,remote);const processor=f.processors[0],input=new Float32Array(4800).fill(0.5);
  processor.onaudioprocess({inputBuffer:{getChannelData:()=>input}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sent.length,1);assert.equal(f.sent[0].token,'shared');assert.equal(f.sent[0].sessionId,23);assert.equal(f.sent[0].sampleRate,24000);
  assert.equal(SharedVoiceAudio.decode(f.sent[0].audio).length,2400);assert.ok(SharedVoiceAudio.decode(f.sent[0].audio).every(v=>Math.abs(v-0.5)<0.00004));
  f.audio.stopCapture();assert.equal(processor.onaudioprocess,null);
});
test('late owner token enables relay without reopening a microphone',async()=>{
  const f=audioHarness();f.audio.captureRemote({},null,4);f.audio.owner('late-token',4);
  f.processors[0].onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4800).fill(0.2)}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sent[0].token,'late-token');
});
test('clear discards capture backlog and observers reject preceding epochs',async()=>{
  const f=audioHarness();f.audio.captureRemote({},'shared',4);f.audio.cancelCapture('shared',1);
  const event={inputBuffer:{getChannelData:()=>new Float32Array(4800).fill(0.2)}};
  f.processors[0].onaudioprocess(event);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sent.length,0);
  f.audio.speaking(true);f.processors[0].onaudioprocess(event);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sent[0].epoch,1);
  f.audio.listen({token:'shared'});f.audio.clear('shared',1);
  assert.equal(f.audio.play({...f.sent[0],epoch:0}),false);assert.equal(f.audio.play(f.sent[0]),true);
  f.audio.clear('shared',0);assert.equal(f.sources.at(-1).stopped,undefined);
});
test('PTT error before delayed release prevents a stale audio commit',()=>{
  const tasks=new Map(),sent=[],track={enabled:true};let now=0,id=0;
  const ptt=new PushToTalk({send:e=>sent.push(e),track,status:()=>{},now:()=>now,schedule:fn=>{tasks.set(++id,fn);return id;},cancel:key=>tasks.delete(key)});
  ptt.connected();ptt.setHeld(true);now=1000;ptt.setHeld(false);ptt.event({type:'error'});for(const fn of tasks.values())fn();
  assert.equal(sent.some(e=>e.type==='input_audio_buffer.commit'),false);assert.equal(track.enabled,false);
});

function nuiHarness({play=()=>Promise.resolve()}={}){
  const audio=audioHarness(),elements=new Map(),peers=[],tracks=[],requests=[];let handler;
  const context={console,Date,JSON,Boolean,atob:raw=>Buffer.from(raw,'base64').toString('binary'),btoa:raw=>Buffer.from(raw,'binary').toString('base64'),setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},
    document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{hidden:true,textContent:'',play});return elements.get(id);}},
    window:{AudioContext:function(){return audio.context;},addEventListener:(_,fn)=>handler=fn},GetParentResourceName:()=> 'fivemai',
    navigator:{mediaDevices:{getUserMedia:async()=>{const track={enabled:true,stop(){this.stopped=true;}};tracks.push(track);return {getAudioTracks:()=>[track],getTracks:()=>[track]};}}},
    fetch:async(url,options)=>{requests.push([url,JSON.parse(options.body)]);return {};},
    RTCPeerConnection:class{constructor(){this.channel={readyState:'connecting',send(){},close(){}};peers.push(this);}addTrack(){}createDataChannel(){return this.channel;}createOffer(){return Promise.resolve({sdp:'v=0\r\n'});}setLocalDescription(){return Promise.resolve();}setRemoteDescription(){return Promise.resolve();}close(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8'),context);
  return {audio,peers,tracks,requests,elements,event:data=>handler({data})};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('nearby listeners play shared audio without capturing a microphone or offering SDP',async()=>{
  const f=nuiHarness();await f.event({type:'voiceListen',token:'shared'});await f.event({type:'voiceProximity',token:'shared',distance:2,fullDistance:3,maxDistance:18});
  await f.event({type:'voiceAudio',token:'shared',seq:0,sampleRate:24000,audio:SharedVoiceAudio.encode(new Float32Array(2400))});
  assert.equal(f.tracks.length,0);assert.equal(f.peers.length,0);assert.equal(f.audio.sources.length,1);assert.ok(!f.requests.some(r=>r[0].endsWith('/offer')));
});
test('a repeated open preserves a held PTT key and ignores stale RTC tracks',async()=>{
  const f=nuiHarness();await f.event({type:'open',sessionId:1,npc:{id:'one',name:'One'}});await settle();await f.event({type:'ptt',held:true});
  f.peers[0].channel.readyState='open';f.peers[0].channel.onopen();assert.equal(f.tracks[0].enabled,true);
  await f.event({type:'open',sessionId:2,npc:{id:'two',name:'Two'}});await settle();
  f.peers[1].channel.readyState='open';f.peers[1].channel.onopen();assert.equal(f.tracks[1].enabled,true);assert.equal(f.tracks[0].stopped,true);
  f.peers[0].ontrack({streams:[{}]});assert.equal(f.elements.get('voice').srcObject,null);assert.equal(f.audio.processors.length,0);
  await f.event({type:'closed',sessionId:1});assert.equal(f.tracks[1].stopped,undefined);
});
test('a stale audio play rejection cannot close a newer conversation',async()=>{
  let rejectPlay;const f=nuiHarness({play:()=>new Promise((_,reject)=>rejectPlay=reject)});
  await f.event({type:'open',sessionId:1,npc:{id:'one',name:'One'}});await settle();f.peers[0].ontrack({streams:[{}]});
  await f.event({type:'open',sessionId:2,npc:{id:'two',name:'Two'}});await settle();rejectPlay(new Error('old autoplay failure'));await settle();
  assert.equal(f.tracks[1].stopped,undefined);assert.ok(!f.requests.some(r=>r[0].endsWith('/close')));
});
