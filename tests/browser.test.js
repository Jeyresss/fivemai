const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function browser(){
 const elements=new Map(),messages=[],requests=[];let handler,peer;
 const track={enabled:true,stopped:false,stop(){this.stopped=true;}};
 const stream={getAudioTracks:()=>[track],getTracks:()=>[track]};
 const context={console,setTimeout:()=>0,clearTimeout:()=>{},Date,JSON,Boolean,
 document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{hidden:true,textContent:'',play:()=>Promise.resolve()});return elements.get(id);}},
 window:{addEventListener:(_,fn)=>handler=fn},navigator:{mediaDevices:{getUserMedia:async()=>stream}},
 GetParentResourceName:()=> 'fivemai',fetch:async(url,options)=>{requests.push([url,JSON.parse(options.body)]);return {};},
 RTCPeerConnection:class{
 constructor(){peer=this;this.channel={readyState:'connecting',send:data=>messages.push(JSON.parse(data)),close(){}};}
 addTrack(){}createDataChannel(){return this.channel;}createOffer(){return Promise.resolve({type:'offer',sdp:'v=0\r\n'});}setLocalDescription(){return Promise.resolve();}setRemoteDescription(){return Promise.resolve();}close(){}
 }};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8'),context);
 return {track,messages,requests,elements,event:data=>handler({data}),get peer(){return peer;}};
}
test('FiveM press starts a connection without a menu and only unmutes after data channel opens',async()=>{
 const s=browser();await s.event({type:'open',npc:{id:'marcel_dubois',name:'Marcel'}});await s.event({type:'ptt',held:true});await tick();
 assert.equal(s.track.enabled,false);assert.equal(s.requests[0][0],'https://fivemai/offer');
 s.peer.channel.readyState='open';s.peer.channel.onopen();assert.equal(s.track.enabled,true);assert.equal(s.messages[0].type,'input_audio_buffer.clear');
 await s.event({type:'ptt',held:false});assert.equal(s.track.enabled,false);await s.event({type:'closed'});assert.equal(s.track.stopped,true);
});
test('releasing during connection keeps the microphone muted when connection opens',async()=>{
 const s=browser();await s.event({type:'open',npc:{id:'marcel_dubois',name:'Marcel'}});await s.event({type:'ptt',held:true});await s.event({type:'ptt',held:false});await tick();
 s.peer.channel.readyState='open';s.peer.channel.onopen();assert.equal(s.track.enabled,false);assert.deepEqual(s.messages,[]);
});
