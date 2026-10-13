const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PersistentDatabase}=require('../server/database');
const {RequestLimiter,VoiceBudget,finitePosition,safeArguments}=require('../server/security');
const {OpenAIRealtimeProvider,ProviderRegistry}=require('../server/provider');
const {sessionConfig}=require('../server/core');
const config=require('../config.json');

test('request limits isolate owners and event kinds, expire and clear disconnected players',()=>{
  let time=1000;const limiter=new RequestLimiter({now:()=>time,maxEntries:4}),quota={count:2,windowMs:1000};
  assert.equal(limiter.take(7,'voice',quota),true);assert.equal(limiter.take(7,'voice',quota),true);assert.equal(limiter.take(7,'voice',quota),false);
  assert.equal(limiter.take(8,'voice',quota),true);assert.equal(limiter.take(7,'actions',quota),true);
  time+=1000;assert.equal(limiter.take(7,'voice',quota),true);limiter.forget(7);assert.ok([...limiter.entries.keys()].every(key=>!key.startsWith('7:')));
  for(let src=10;src<30;src++)limiter.take(src,'voice');assert.ok(limiter.entries.size<=4);
});
test('voice budget reserves the maximum duration before a call and keeps it after a crash',()=>{
  const db=new PersistentDatabase(':memory:');try{
    let time=Date.parse('2026-10-13T10:00:00Z');const options={db,now:()=>time,config:{maxCallsPerDay:3,maxAudioSecondsPerDay:180}};
    const first=new VoiceBudget(options),reservation=first.reserve(180);assert.equal(db.get('voice_budget','2026-10-13').seconds,180);
    const restarted=new VoiceBudget(options);assert.throws(()=>restarted.reserve(1),/Budget/);
    time+=45000;restarted.finish(reservation);assert.deepEqual(db.get('voice_budget','2026-10-13'),{calls:1,seconds:45});
    restarted.finish(reservation);assert.equal(db.get('voice_budget','2026-10-13').seconds,45);
    assert.throws(()=>restarted.reserve(136),/Budget/);assert.equal(db.get('voice_budget','2026-10-13').calls,1);
  }finally{db.close();}
});
test('a call ending after midnight adjusts its original day and cannot exceed its reservation',()=>{
  const db=new PersistentDatabase(':memory:');try{
    let time=Date.parse('2026-10-13T23:59:50Z');const budget=new VoiceBudget({db,now:()=>time,config:{maxCallsPerDay:1,maxAudioSecondsPerDay:30}});
    const before=budget.reserve(30);assert.throws(()=>budget.reserve(1),/Budget/);
    time+=20000;const after=budget.reserve(10);budget.finish(before);assert.deepEqual(db.get('voice_budget','2026-10-13'),{calls:1,seconds:20});
    time+=90000;budget.finish(after);assert.deepEqual(db.get('voice_budget','2026-10-14'),{calls:1,seconds:10});
    for(const value of [0,-1,NaN,Infinity])assert.throws(()=>budget.reserve(value),/Durée/);
  }finally{db.close();}
});
test('tool boundaries reject oversized input, prototype keys and invalid game coordinates',()=>{
  assert.deepEqual(safeArguments('{"action":"hands_up"}'),{action:'hands_up'});
  for(const value of ['[]','null','{"__proto__":{}}','{"constructor":{}}','{"prototype":{}}','a'.repeat(8193)])assert.throws(()=>safeArguments(value));
  assert.equal(finitePosition({x:1,y:-100,z:39}),true);assert.equal(finitePosition({x:Infinity,y:0,z:0}),false);assert.equal(finitePosition({x:20000,y:0,z:0}),false);
});
test('provider negotiates native WebRTC audio once with credentials only in server headers',async()=>{
  const requests=[],secret='sk-private-never-client';
  const provider=new OpenAIRealtimeProvider({key:()=>secret,WebSocket:class{},fetchImpl:async(url,options)=>{requests.push({url,options});return {ok:true,text:async()=> 'v=0\r\nanswer',headers:{get:()=> 'https://api.openai.com/v1/realtime/calls/rtc_test'}};}});
  const session=sessionConfig(config,config.npcs[0],[]),result=await provider.open('v=0\r\noffer',session);
  assert.deepEqual(result,{answer:'v=0\r\nanswer',callId:'rtc_test'});assert.equal(requests.length,1);assert.equal(requests[0].url,'https://api.openai.com/v1/realtime/calls');
  const settings=JSON.parse(requests[0].options.body.get('session'));assert.deepEqual(settings.output_modalities,['audio']);assert.equal(settings.audio.input.transcription,undefined);assert.equal(settings.audio.input.turn_detection,null);
  assert.doesNotMatch(JSON.stringify(result)+requests[0].options.body.get('session')+requests[0].options.body.get('sdp'),/sk-private/);
  assert.equal(requests[0].options.headers.Authorization,`Bearer ${secret}`);
});
test('provider failures redact API secrets and reject untrusted call IDs',async()=>{
  const secret='private-provider-key',requests=[];
  const provider=new OpenAIRealtimeProvider({key:()=>secret,WebSocket:class{},fetchImpl:async(url)=>{requests.push(url);return {ok:false,status:400,json:async()=>({error:{message:`${secret} sk-abc123\nresponse rejected`,code:'invalid_request_error'}})};}});
  await assert.rejects(provider.open('v=0',{}),error=>{assert.match(error.message,/HTTP 400.*invalid_request_error/);assert.doesNotMatch(error.message,/private-provider-key|sk-abc123|\n/);return true;});
  await provider.close('../../other');assert.equal(requests.length,1);
  const registry=new ProviderRegistry(provider);assert.equal(registry.get(),provider);assert.throws(()=>registry.register(provider),/déjà/);assert.throws(()=>registry.get('missing'),/indisponible/);
});
