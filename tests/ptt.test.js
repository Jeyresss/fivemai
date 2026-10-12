const {test}=require('node:test');
const assert=require('node:assert/strict');
const PushToTalk=require('../web/app');
function setup(){
 const sent=[],track={enabled:true},tasks=new Map();let time=0,id=0;
 const ptt=new PushToTalk({send:e=>sent.push(e),track,status:()=>{},now:()=>time,schedule:fn=>{tasks.set(++id,fn);return id;},cancel:id=>tasks.delete(id)});
 return {ptt,sent,track,advance:ms=>time+=ms,flush:()=>{for(const [id,fn]of [...tasks]){tasks.delete(id);fn();}}};
}
test('microphone is muted until connected and key is held',()=>{
 const s=setup();assert.equal(s.track.enabled,false);s.ptt.setHeld(true);assert.equal(s.track.enabled,false);s.ptt.connected();assert.equal(s.track.enabled,true);assert.deepEqual(s.sent,[{type:'input_audio_buffer.clear'}]);s.ptt.setHeld(false);assert.equal(s.track.enabled,false);
});
test('release commits audio then requests a response only after commit acknowledgement',()=>{
 const s=setup();s.ptt.connected();s.ptt.setHeld(true);s.advance(1000);s.ptt.setHeld(false);assert.equal(s.track.enabled,false);assert.equal(s.sent.length,1);s.flush();assert.equal(s.sent.at(-1).type,'input_audio_buffer.commit');assert.equal(s.sent.some(e=>e.type==='response.create'),false);s.ptt.event({type:'input_audio_buffer.committed'});assert.equal(s.sent.at(-1).type,'response.create');s.ptt.event({type:'input_audio_buffer.committed'});assert.equal(s.sent.filter(e=>e.type==='response.create').length,1);
});
test('short press and release before connection do not request an empty response',()=>{
 const s=setup();s.ptt.setHeld(true);s.ptt.setHeld(false);s.ptt.connected();assert.equal(s.track.enabled,false);assert.equal(s.sent.length,0);s.ptt.setHeld(true);s.advance(100);s.ptt.setHeld(false);s.flush();assert.equal(s.sent.some(e=>e.type==='input_audio_buffer.commit'),false);
});
test('new speech interrupts response and clears playback',()=>{
 const s=setup();s.ptt.connected();s.ptt.event({type:'response.created'});s.ptt.event({type:'output_audio_buffer.started'});s.ptt.setHeld(true);assert.deepEqual(s.sent.map(e=>e.type),['response.cancel','output_audio_buffer.clear','input_audio_buffer.clear']);assert.equal(s.track.enabled,true);
});
test('closing during release cancels pending audio and leaves microphone off',()=>{
 const s=setup();s.ptt.connected();s.ptt.setHeld(true);s.advance(800);s.ptt.setHeld(false);s.ptt.dispose();s.flush();assert.equal(s.sent.some(e=>e.type==='input_audio_buffer.commit'),false);assert.equal(s.track.enabled,false);
});

test('microphone stats distinguish real input from transport and missing statistics',()=>{
 assert.deepEqual(PushToTalk.audioStats(new Map()),{level:null,bytes:null});
 assert.deepEqual(PushToTalk.audioStats(new Map([['mic',{type:'media-source',kind:'audio',audioLevel:0}],['rtp',{type:'outbound-rtp',kind:'audio',bytesSent:2500}]])),{level:0,bytes:2500});
 assert.deepEqual(PushToTalk.audioStats(new Map([['mic',{type:'media-source',kind:'audio',audioLevel:0.25}],['rtp',{type:'outbound-rtp',kind:'audio',bytesSent:3000}],['video',{type:'outbound-rtp',kind:'video',bytesSent:500000}]])),{level:0.25,bytes:3000});
});

test('proximity volume fades, mutes at range and restores when returning',()=>{
 assert.equal(PushToTalk.proximityVolume(2),1);assert.equal(PushToTalk.proximityVolume(18),0);assert.equal(PushToTalk.proximityVolume(40),0);
 assert.ok(PushToTalk.proximityVolume(6)>PushToTalk.proximityVolume(12));assert.equal(PushToTalk.proximityVolume(2),1);assert.equal(PushToTalk.proximityVolume(NaN),0);
});
