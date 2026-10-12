const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function browser(){
 const elements=new Map(),messages=[],requests=[],captures=[];let handler,peer;
 const track={enabled:true,stopped:false,stop(){this.stopped=true;}};
 const stream={getAudioTracks:()=>[track],getTracks:()=>[track]};
 const context={console,setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,clearInterval:()=>{},Date,JSON,Boolean,
 document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{hidden:true,textContent:'',play:()=>Promise.resolve()});return elements.get(id);}},
 window:{addEventListener:(_,fn)=>handler=fn},navigator:{mediaDevices:{getUserMedia:async options=>{captures.push(options);return stream;},enumerateDevices:async()=>[{kind:'audioinput',deviceId:'default',label:'Windows default'},{kind:'audioinput',deviceId:'headset-id',label:'USB headset'}]}},
 GetParentResourceName:()=> 'fivemai',fetch:async(url,options)=>{requests.push([url,JSON.parse(options.body)]);return {};},
 RTCPeerConnection:class{
 constructor(){peer=this;this.channel={readyState:'connecting',send:data=>messages.push(JSON.parse(data)),close(){}};}
 addTrack(){}createDataChannel(){return this.channel;}createOffer(){return Promise.resolve({type:'offer',sdp:'v=0\r\n'});}setLocalDescription(){return Promise.resolve();}setRemoteDescription(){return Promise.resolve();}close(){}
 }};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8'),context);
 return {track,messages,requests,captures,elements,event:data=>handler({data}),get peer(){return peer;}};
}
test('FiveM press starts a connection without a menu and only unmutes after data channel opens',async()=>{
 const s=browser();await s.event({type:'open',npc:{id:'marcel_dubois',name:'Marcel'}});await s.event({type:'ptt',held:true});await tick();
 assert.equal(s.track.enabled,false);assert.equal(s.requests.some(r=>r[0]==='https://fivemai/offer'),true);
 s.peer.channel.readyState='open';s.peer.channel.onopen();assert.equal(s.track.enabled,true);assert.equal(s.messages[0].type,'input_audio_buffer.clear');
 await s.event({type:'ptt',held:false});assert.equal(s.track.enabled,false);await s.event({type:'closed'});assert.equal(s.track.stopped,true);
});
test('releasing during connection keeps the microphone muted when connection opens',async()=>{
 const s=browser();await s.event({type:'open',npc:{id:'marcel_dubois',name:'Marcel'}});await s.event({type:'ptt',held:true});await s.event({type:'ptt',held:false});await tick();
 s.peer.channel.readyState='open';s.peer.channel.onopen();assert.equal(s.track.enabled,false);assert.deepEqual(s.messages,[]);
});

test('selected microphone is requested explicitly, not silently replaced with the default',async()=>{
 const s=browser();await s.event({type:'open',npc:{id:'marcel_dubois',name:'Marcel'},microphone:'headset-id'});await tick();
 assert.equal(s.captures[0].audio.deviceId.exact,'headset-id');
});
test('F8 microphone selection saves the chosen device and stops temporary capture',async()=>{
 const s=browser();await s.event({type:'microphones',index:2});await tick();
 const selection=s.requests.find(r=>r[0]==='https://fivemai/microphone');
 assert.equal(selection[1].deviceId,'headset-id');assert.equal(s.track.stopped,true);
});

test('walking out of hearing range mutes playback without closing the audio stream',async()=>{
 const s=browser();await s.event({type:'open',npc:{id:'marcel_dubois',name:'Marcel'}});await tick();
 await s.event({type:'proximity',distance:30,fullDistance:3,maxDistance:18});assert.equal(s.elements.get('voice').volume,0);assert.equal(s.track.stopped,false);
 await s.event({type:'proximity',distance:2,fullDistance:3,maxDistance:18});assert.equal(s.elements.get('voice').volume,1);assert.equal(s.requests.some(r=>r[0]==='https://fivemai/close'),false);
});
