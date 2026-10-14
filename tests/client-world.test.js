const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=require('fengari');
// Reuse the existing native fixture so these regressions exercise the same entry script.
const existing=fs.readFileSync(path.join(__dirname,'client.test.js'),'utf8');
const start=existing.indexOf('const fixture=`')+'const fixture=`'.length;
const fixture=existing.slice(start,existing.indexOf('`;\nfunction run',start));
const mechanicStart=existing.indexOf('const movementFixture=`')+'const movementFixture=`'.length;
const mechanicFixture=existing.slice(mechanicStart,existing.indexOf('`;\ntest(',mechanicStart));
function evaluate(code,{world=false,setup=''}={}){
  const L=lauxlib.luaL_newstate();lualib.luaL_openlibs(L);
  const src=fixture+'\n'+setup+'\n'+fs.readFileSync(path.join(__dirname,'../client/'+(world?'world.lua':'main.lua')),'utf8')+'\n'+(!world?'threads[1]()\ncallbacks.ready({},function()end)\n':'')+code;
  try{const status=lauxlib.luaL_dostring(L,to_luastring(src));assert.equal(status,lua.LUA_OK,status===lua.LUA_OK?undefined:to_jsstring(lua.lua_tostring(L,-1)));}finally{lua.lua_close(L);}
}
const natives=`
local positions={[10]=vector3(2,0,0),[99]=vector3(0,0,0),[300]=vector3(0,0,0)}
GetEntityCoords=function(entity)return positions[entity] or vector3(0,0,0)end
NetworkHasControlOfEntity=function()return true end
NetworkDoesEntityExistWithNetworkId=function(id)return id==44 or id==101 end
NetToPed=function()return 10 end
NetToVeh=function()return 300 end
TriggerServerEvent=function(name,...)table.insert(network,{name=name,args={...}})end
GetEntitySpeed=function()return 0 end
ClearPedTasks=function()end
GetVehiclePedIsIn=function()return 0 end
GetPedInVehicleSeat=function()return 0 end
TaskStandStill=function()end
GetScriptTaskStatus=function()return 1 end
`;
test('stale browser callbacks and waveform tokens cannot modify a new voice session',()=>evaluate(natives+`
commands['+fivemai_talk']()
local session=sent[1].sessionId
local before=#network
callbacks.offer({npcId='marcel_dubois',sdp='stale',sessionId=session-1},function(r)assert(not r.ok)end)
callbacks.close({sessionId=session-1},function()end)
assert(#network==before and currentNpc)
events['fivemai:voiceOwner']({token='voice-a',sessionId=session,npcId='marcel_dubois'})
callbacks.voiceFrame({token='fake',sessionId=session},function(r)assert(not r.ok)end)
assert(#network==before)
callbacks.voiceFrame({token='voice-a',sessionId=session,epoch=2,seq=3,audio='AAAA',sampleRate=24000},function(r)assert(r.ok)end)
assert(network[#network].name=='fivemai:voiceFrame' and network[#network].args[1].epoch==2)
events['fivemai:voiceClear']({token='voice-a',epoch=3})
assert(sent[#sent].type=='voiceClear' and sent[#sent].epoch==3)
events['fivemai:answer']({sdp='old',sessionId=session-1})
assert(sent[#sent].type=='voiceClear')
`));
test('a nearby observer receives distance and audio while keeping the microphone closed',()=>evaluate(natives+`
local muted=false
StopPedSpeaking=function(_,state)muted=state end
DisablePedPainAudio=function()end
events['fivemai:voiceListen']({token='nearby',netId=101,coords={x=100,y=0,z=0},fullDistance=3,maxDistance=18,epoch=4})
assert(sent[1].type=='voiceListen' and sent[2].type=='voiceProximity' and sent[2].distance==2)
assert(muted and not talking)
events['fivemai:voiceAudio']({token='nearby',audio='AAAA',seq=1,sampleRate=24000,epoch=4})
assert(sent[#sent].type=='voiceAudio' and sent[#sent].epoch==4)
events['fivemai:voiceLeave']({token='nearby'})
assert(not muted and sent[#sent].type=='voiceLeave')
for _,message in ipairs(sent) do assert(message.type~='open') end
`));
test('waiting succeeds only when GTA confirms the standing task and ends at its deadline',()=>evaluate(natives+`
commands['+fivemai_talk']()
GetScriptTaskStatus=function()return 7 end
events['fivemai:actionStart']({token='failed-wait',npcId='marcel_dubois',action='wait',durationSeconds=2}) threads[3]()
assert(network[#network].args[2]==false)
GetScriptTaskStatus=function()return 1 end
events['fivemai:actionStart']({token='wait',npcId='marcel_dubois',action='wait',durationSeconds=2}) threads[4]()
assert(network[#network].args[2]==true)
clock=clock+2200 maintainAction()
assert(currentAction==nil and network[#network].args[2]=='completed')
`));
test('navigation verifies actual destination and excludes the wrong floor',()=>evaluate(natives+`
commands['+fivemai_talk']()
TaskFollowNavMeshToCoord=function(ped,x,y,z)positions[ped]=vector3(x,y,z+4)end
events['fivemai:actionStart']({token='walk',npcId='marcel_dubois',action='go_to',destination={x=4,y=4,z=0},durationSeconds=60}) threads[3]()
assert(network[#network].args[2]==false)
TaskFollowNavMeshToCoord=function(ped,x,y,z)positions[ped]=vector3(x,y,z+1)end
events['fivemai:actionStart']({token='walk-ok',npcId='marcel_dubois',action='go_to',destination={x=4,y=4,z=0},durationSeconds=60}) threads[4]()
assert(network[#network].args[2]==true)
`));
test('exiting a vehicle waits for the ped to actually leave and refuses a moving car',()=>evaluate(natives+`
commands['+fivemai_talk']()
local inside=true
IsPedInAnyVehicle=function()return inside end
GetVehiclePedIsIn=function()return inside and 300 or 0 end
local exits=0
TaskLeaveVehicle=function()exits=exits+1 inside=false end
GetEntitySpeed=function()return 2 end
events['fivemai:actionStart']({token='exit-moving',npcId='marcel_dubois',action='exit_vehicle',durationSeconds=60}) threads[3]()
assert(exits==0 and network[#network].args[2]==false)
GetEntitySpeed=function()return 0 end
events['fivemai:actionStart']({token='exit',npcId='marcel_dubois',action='exit_vehicle',durationSeconds=60}) threads[4]()
assert(exits==1 and network[#network].args[2]==true)
`));
const drive=`
local occupants,speed,reroutes={},0,0
IsVehicleSeatFree=function(_,seat)return occupants[seat]==nil end
GetVehicleMaxNumberOfPassengers=function()return 3 end
GetPedInVehicleSeat=function(_,seat)return occupants[seat] or 0 end
GetVehiclePedIsIn=function(ped)return ped==99 and 300 or (occupants[-1]==ped and 300 or 0)end
TaskEnterVehicle=function(ped,_,_,seat)occupants[seat]=ped end
TaskVehicleDriveToCoordLongrange=function()reroutes=reroutes+1 end
TaskVehicleTempAction=function()end
GetEntitySpeed=function()return speed end
commands['+fivemai_talk']()
events['fivemai:actionStart']({token='trip',npcId='marcel_dubois',action='drive',vehicleNetId=44,destination={x=100,y=0,z=0},durationSeconds=150}) threads[3]()
assert(currentAction and network[#network].args[2]==true)
`;
test('voice close preserves a trip and arrival requires a real stationary vehicle',()=>evaluate(natives+drive+`
callbacks.close({},function()end)
assert(currentAction and not currentNpc)
positions[300]=vector3(100,0,0) speed=12 maintainAction()
assert(currentAction,'Passing through the destination at speed is not an arrival')
speed=0 maintainAction() clock=clock+900 maintainAction()
assert(currentAction==nil and network[#network].name=='fivemai:actionEnded' and network[#network].args[2]=='arrived')
assert(network[#network].args[3].driver and network[#network].args[3].playerInside)
`));
test('a blocked trip retries navigation twice, reports failure, and never teleports occupants',()=>evaluate(natives+drive+`
SetEntityCoords=function()error('Never teleport a trip')end
SetPedIntoVehicle=function()error('Never warp an occupant')end
for index=1,3 do clock=clock+10500 maintainAction() end
assert(reroutes==3 and currentAction==nil and network[#network].args[2]=='stuck')
`));
const worldNatives=natives+`
GetPlayerFromServerId=function(id)return id==7 and 0 or -1 end
GetPlayerPed=function()return 99 end
PlayerId=function()return 0 end
GetEntityHealth=function()return 150 end
SetBlockingOfNonTemporaryEvents=function()end
TaskGoToEntity=function(ped,target,timeout,range)positions[ped]=vector3(range,0,0)end
TaskTurnPedToFaceEntity=function()end
TaskLookAtEntity=function()end
RequestAnimDict=function()end
HasAnimDictLoaded=function()return true end
local animations={}
TaskPlayAnim=function(ped,dict,anim)animations[ped]=dict..':'..anim end
IsEntityPlayingAnim=function(ped,dict,anim)return animations[ped]==dict..':'..anim end
StopAnimTask=function(ped)animations[ped]=nil end
local cuffs=false
SetEnableHandcuffs=function(_,enabled)cuffs=enabled end
IsPedCuffed=function()return cuffs end
`;
test('routine movement reports failure if the actual NPC never reaches the point',()=>evaluate(worldNatives+`
TaskFollowNavMeshToCoord=function()end
events['fivemai:routine']({token='schedule',npcNetId=101,task='walk',destination={x=30,y=0,z=0},durationSeconds=2}) threads[3]()
assert(network[#network].name=='fivemai:routineResult' and network[#network].args[2]==false and network[#network].args[3]=='path')
`,{world:true}));
test('conversation priority prevents routine tasks and cannot clear the actor',()=>evaluate(worldNatives+`
FivemAIClient={busy=function()return true end}
ClearPedTasks=function()error('Do not replace the higher priority task')end
events['fivemai:routine']({token='schedule',npcNetId=101,task='idle'})
assert(network[#network].args[2]==false and network[#network].args[3]=='priority')
`,{world:true}));
test('police approaches and animates before requesting a separate target restraint',()=>evaluate(worldNatives+`
events['fivemai:policeTask']({token='case',npcNetId=101,targetServerId=7,action='cuff'}) threads[3]()
assert(not cuffs,'An executor cannot cuff a remote player directly')
assert(network[#network].name=='fivemai:policeResult' and network[#network].args[2]==true and network[#network].args[3]=='restraint_ready')
assert(network[#network].args[4].distance<=2.5)
`,{world:true}));
test('cuffing a running player fails without native restraints or a successful arrest result',()=>evaluate(worldNatives+`
GetEntitySpeed=function()return 3 end
events['fivemai:policeTask']({token='case',npcNetId=101,targetServerId=7,action='arrest'}) threads[3]()
assert(not cuffs and network[#network].args[2]==false and network[#network].args[3]=='resisting')
`,{world:true}));
test('target restraint requires native cuff state and animation and releases at its deadline',()=>evaluate(worldNatives+`
events['fivemai:policeRestraint']({token='case',enabled=true,durationSeconds=1}) threads[3]()
assert(cuffs and network[#network].args[2]==true and network[#network].args[3]=='cuffed')
clock=clock+1100
local co=coroutine.create(threads[1])
Wait=function(ms)clock=clock+ms coroutine.yield()end
assert(coroutine.resume(co)) assert(coroutine.resume(co))
assert(not cuffs and animations[99]==nil and network[#network].args[3]=='expired')
`,{world:true}));
test('a cancelled restraint never later enables handcuffs when an animation finishes loading',()=>evaluate(worldNatives+`
HasAnimDictLoaded=function()return false end
events['fivemai:policeRestraint']({token='case',enabled=true})
Wait=function(ms)clock=clock+ms events['fivemai:policeRestraint']({token='case',enabled=false})end
threads[3]()
assert(not cuffs)
for _,packet in ipairs(network)do assert(not(packet.name=='fivemai:policeRestraintResult' and packet.args[3]=='cuffed'))end
`,{world:true}));
test('server-requested police speech opens automatic audio with the mic released and carries its one-use token',()=>evaluate(natives+`
events['fivemai:policeSpeech']({npcId='marcel_dubois',npcNetId=101,requestToken='authorized-speech'})
assert(sent[1].type=='open' and sent[2].held==false)
callbacks.offer({npcId='marcel_dubois',sdp='v=0',sessionId=sent[1].sessionId},function(r)assert(r.ok)end)
local offered=network[#network].args[6]
assert(offered.automatic==true and offered.reaction=='police' and offered.speechToken=='authorized-speech')
`));
test('medicine acknowledges only actual player health after a confirmed animation and never applies a duplicate twice',()=>evaluate(worldNatives+`
local health,applications=120,0
GetEntityHealth=function()return health end
SetEntityHealth=function(ped,value)assert(ped==99)health=value applications=applications+1 end
events['fivemai:inventoryEffect']({token='medicine',effect='heal',targetHealth=160}) threads[3]()
assert(health==160 and network[#network].name=='fivemai:inventoryResult' and network[#network].args[2]==true)
events['fivemai:inventoryEffect']({token='medicine',effect='heal',targetHealth=200})
assert(applications==1 and health==160)
`,{world:true}));
test('cancelled medicine cannot apply health after its animation load resumes',()=>evaluate(worldNatives+`
local applied=false
SetEntityHealth=function()applied=true end
HasAnimDictLoaded=function()return false end
events['fivemai:inventoryEffect']({token='medicine',effect='heal',targetHealth=160})
Wait=function(ms)clock=clock+ms events['fivemai:inventoryCancel']({token='medicine'})end
threads[3]()
assert(not applied)
`,{world:true}));
test('repair kits require the player occupied vehicle and actual engine verification',()=>evaluate(worldNatives+`
local engine,body,applied=400,500,0
GetVehiclePedIsIn=function()return 300 end
NetworkGetNetworkIdFromEntity=function(entity)return entity==300 and 44 or 101 end
GetVehicleEngineHealth=function()return engine end
GetVehicleBodyHealth=function()return body end
SetVehicleEngineHealth=function(_,value)engine=value applied=applied+1 end
SetVehicleBodyHealth=function(_,value)body=value end
events['fivemai:inventoryEffect']({token='wrong-kit',effect='repair',vehicleNetId=45,minimumEngineHealth=900}) threads[3]()
assert(applied==0 and network[#network].args[2]==false)
events['fivemai:inventoryEffect']({token='kit',effect='repair',vehicleNetId=44,minimumEngineHealth=900}) threads[4]()
assert(engine==900 and body==900 and network[#network].args[2]==true)
`,{world:true}));
test('an authorized performance upgrade changes the actual native mod after voice has closed',()=>evaluate(mechanicFixture+`
threads[3]()
callbacks.close({},function()end)
assert(workingJob and not currentNpc)
local mods={}
SetVehicleModKit=function(_,kit)assert(kit==0)end
GetNumVehicleMods=function()return 3 end
GetVehicleMod=function(_,kind)return mods[kind] or -1 end
SetVehicleMod=function(_,kind,index)mods[kind]=index end
events['fivemai:jobApply']({token='job-a',netId=44,npcId='marcel_dubois',service='upgrade',upgrade={slot=11,level=1}}) threads[4]()
assert(mods[11]==1 and network[#network].args[1]==true and network[#network].args[2][1].index==1)
`));
test('unsupported upgrades are rejected before any package part changes and failed native upgrades roll back',()=>evaluate(mechanicFixture+`
threads[3]()
local mods,applied={},0
SetVehicleModKit=function()end
GetNumVehicleMods=function(_,kind)return kind==11 and 3 or 0 end
GetVehicleMod=function(_,kind)return mods[kind] or -1 end
SetVehicleMod=function(_,kind,index)applied=applied+1 mods[kind]=index end
events['fivemai:jobApply']({token='job-a',netId=44,npcId='marcel_dubois',service='upgrade',modifications={{type=11,index=1},{type=12,index=1}}}) threads[4]()
assert(applied==0 and network[#network].args[1]==false)
SetVehicleMod=function(_,kind,index)applied=applied+1 end
events['fivemai:jobApply']({token='job-a',netId=44,npcId='marcel_dubois',service='upgrade',upgrade={slot=11,level=1}}) threads[5]()
assert(applied==2 and network[#network].args[1]==false,'Failed mod must attempt its previous value')
`));
test('a repair native error returns a failed application immediately',()=>evaluate(mechanicFixture+`
threads[3]()
SetVehicleFixed=function()error('native failure')end
events['fivemai:jobApply']({token='job-a',netId=44,npcId='marcel_dubois',service='repair'}) threads[4]()
assert(network[#network].name=='fivemai:jobResult' and network[#network].args[1]==false)
`));
