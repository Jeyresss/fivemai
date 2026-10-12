const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=require('fengari');
const fixture=`
commands,events,callbacks,threads,timers,sent,network,logs,gameHandlers = {},{},{},{},{},{},{},{},{}
clock, target = 1000, 10
local mt = {}
mt.__sub=function(a,b)return setmetatable({x=a.x-b.x,y=a.y-b.y,z=a.z-b.z},mt)end
mt.__len=function(a)return math.sqrt(a.x*a.x+a.y*a.y+a.z*a.z)end
function vector3(x,y,z)return setmetatable({x=x,y=y,z=z},mt)end
configForTest={interactionDistance=3,ambientNPCs=true,npcs={{id='marcel_dubois',firstName='Marcel',lastName='Dubois',model='mechanic',coords={x=2,y=0,z=0,heading=0}}}}
json={decode=function()return configForTest end}
function GetCurrentResourceName()return 'fivemai'end
function LoadResourceFile()return ''end
function CreateThread(fn)table.insert(threads,fn)end
function SetTimeout(ms,fn)table.insert(timers,{ms=ms,fn=fn})end
function RegisterCommand(name,fn)commands[name]=fn end
function RegisterNetEvent(name,fn)events[name]=fn end
function RegisterNUICallback(name,fn)callbacks[name]=fn end
function RegisterKeyMapping()end
function AddEventHandler(name,handler)gameHandlers[name]=handler end
function print(message)table.insert(logs,message)end
function SendNUIMessage(message)table.insert(sent,message)end
function TriggerServerEvent(name,data)table.insert(network,{name=name,data=data})end
function GetResourceKvpString()return nil end
function DeleteResourceKvp()end
function SetResourceKvp()end
function joaat()return 123 end
function RequestModel()end
function HasModelLoaded()return true end
function GetGameTimer()return clock end
function Wait(ms)clock=clock+ms end
function CreatePed()return 10 end
function SetEntityInvincible()end
function FreezeEntityPosition()end
function SetBlockingOfNonTemporaryEvents()end
function SetModelAsNoLongerNeeded()end
function PlayerPedId()return 99 end
function GetGamePool()return {target}end
function GetEntityCoords(ped)
 if ped==99 then return vector3(0,0,0)end
 if ped==10 and target~=10 then return vector3(100,0,0)end
 return vector3(2,0,0)
end
function DoesEntityExist()return true end
function IsPedAPlayer(ped)return ped==99 end
function IsPedHuman()return true end
function IsEntityDead()return false end
function GetEntityModel(ped)return ped==10 and 123 or 124 end
function NetworkGetEntityIsNetworked()return true end
function NetworkRegisterEntityAsNetworked()end
function NetworkGetNetworkIdFromEntity()return 101 end
`;
function run(assertions,{ready=true,setup=''}={}){
 const L=lauxlib.luaL_newstate();lualib.luaL_openlibs(L);
 const source=fixture+'\n'+setup+'\n'+fs.readFileSync(path.join(__dirname,'../client/main.lua'),'utf8')+'\nthreads[1]()\n'+(ready?'callbacks.ready({},function()end)\n':'')+assertions;
 try{const code=lauxlib.luaL_dostring(L,to_luastring(source));assert.equal(code,lua.LUA_OK,code===lua.LUA_OK?undefined:to_jsstring(lua.lua_tostring(L,-1)));}finally{lua.lua_close(L);}
}
test('fixed NPC voice opens immediately without a resolver request',()=>run(`
commands['+fivemai_talk']()
assert(#network==0,'Fixed NPC must not wait for server resolution')
assert(sent[1].type=='open' and sent[1].npc.id=='marcel_dubois')
assert(sent[2].type=='ptt' and sent[2].held==true)
commands['-fivemai_talk']()
assert(sent[3].held==false)
`));
test('ambient resolution opens voice only for the matching request and preserves released key',()=>run(`
target=20
commands['+fivemai_talk']()
threads[3]()
assert(network[1].name=='fivemai:resolve')
local req=network[1].data.requestId
commands['-fivemai_talk']()
events['fivemai:resolved']({requestId=req+1,ok=true,profile={id='wrong'}})
assert(#sent==1,'Stale profile must not open a connection')
events['fivemai:resolved']({requestId=req,ok=true,profile={id='npc_1',firstName='Alex',lastName='Morel',coords={x=2,y=0,z=0}}})
assert(sent[2].type=='open' and sent[2].npc.id=='npc_1')
assert(sent[3].type=='ptt' and sent[3].held==false)
`));
test('unsynchronized ambient resolution retries then stops with a clear diagnostic',()=>run(`
target=20
commands['+fivemai_talk']()
threads[3]()
local req=network[1].data.requestId
for attempt=1,2 do
 events['fivemai:resolved']({requestId=req,ok=false,retryable=true,error='PNJ pas encore synchronisé'})
 timers[#timers].fn()
end
assert(#network==3,'Exactly three profile attempts expected')
events['fivemai:resolved']({requestId=req,ok=false,retryable=true,error='PNJ pas encore synchronisé'})
assert(sent[#sent].type=='closed')
assert(string.find(logs[#logs],'Profil indisponible'))
`));

test('holding the key before NUI readiness queues the open instead of losing it',()=>run(`
commands['+fivemai_talk']()
assert(#sent==0,'Do not send an open to an unloaded NUI')
callbacks.ready({},function()end)
assert(sent[1].type=='open')
assert(sent[2].type=='ptt' and sent[2].held==true)
`,{ready:false}));
test('release before NUI readiness does not accidentally reactivate the microphone',()=>run(`
commands['+fivemai_talk']()
commands['-fivemai_talk']()
callbacks.ready({},function()end)
assert(sent[2].type=='open')
assert(sent[3].type=='ptt' and sent[3].held==false)
`,{ready:false}));
test('acknowledged UI opens once and subsequent key presses only toggle speech',()=>run(`
commands['+fivemai_talk']()
local session=sent[1].sessionId
callbacks.opened({sessionId=session},function()end)
commands['-fivemai_talk']()
commands['+fivemai_talk']()
local opens=0
for _,message in ipairs(sent)do if message.type=='open' then opens=opens+1 end end
assert(opens==1,'Do not restart the working microphone on every press')
assert(sent[#sent].type=='ptt' and sent[#sent].held==true)
`));
test('configured NPC remains selectable when ambient population scanning fails',()=>run(`
GetGamePool=function()error('Population unavailable')end
commands['+fivemai_talk']()
assert(sent[1].type=='open' and sent[1].npc.id=='marcel_dubois')
`));
test('press outside range reports why and a later press near the NPC still opens',()=>run(`
local originalCoords=GetEntityCoords
GetEntityCoords=function(ped)return ped==99 and vector3(1000,0,0) or originalCoords(ped)end
commands['+fivemai_talk']()
assert(sent[1].type=='notice')
GetEntityCoords=originalCoords
commands['+fivemai_talk']()
assert(sent[2].type=='open')
`));

test('native ped enumeration finds a close NPC missing from the game pool snapshot',()=>run(`
target=20
GetGamePool=function()return {}end
FindFirstPed=function()return 12,20 end
FindNextPed=function()return false,0 end
local ended=false
EndFindPed=function(handle)assert(handle==12)ended=true end
commands['+fivemai_talk']()
threads[3]()
assert(network[1].name=='fivemai:resolve')
assert(ended,'Native enumeration handle must be released')
`));
test('configured mechanic can be recognized from its model and spawn coordinates',()=>run(`
target=20
GetEntityModel=function()return 123 end
commands['+fivemai_talk']()
assert(#network==0)
assert(sent[1].type=='open' and sent[1].npc.id=='marcel_dubois')
`));
test('player character standing nearby is diagnosed rather than treated as an NPC',()=>run(`
target=20
IsPedAPlayer=function(ped)return ped==20 end
commands['+fivemai_talk']()
assert(sent[1].type=='notice')
assert(string.find(logs[#logs-1],'joueur=true'))
`));

const movementFixture=`
local positions={[10]=vector3(2,0,0),[300]=vector3(0,0,0)}
local savedCoords=GetEntityCoords
GetEntityCoords=function(ped)return positions[ped] or savedCoords(ped)end
local steps, frozen, repairs, hood, engine = {}, true, 0, 0, 500
NetworkDoesEntityExistWithNetworkId=function(id)return id==44 end
NetToVeh=function()return 300 end
NetworkHasControlOfEntity=function()return true end
GetEntityHeading=function()return 0 end
GetModelDimensions=function()return vector3(-1,-2,-0.5),vector3(1,2,0.5)end
GetOffsetFromEntityInWorldCoords=function(_,x,y,z)return vector3(x,y,z)end
GetGroundZFor_3dCoord=function()return true,0 end
GetHeadingFromVector_2d=function()return 180 end
GetEntitySpeed=function()return 0 end
FreezeEntityPosition=function(_,state)frozen=state end
ClearPedTasks=function()table.insert(steps,'clear')end
TaskFollowNavMeshToCoord=function(ped,x,y,z)
 assert(not frozen,'Mechanic must be unfrozen before walking')
 table.insert(steps,'walk');positions[ped]=vector3(x,y,z)
end
TaskAchieveHeading=function()table.insert(steps,'face')end
RequestAnimDict=function()end
HasAnimDictLoaded=function()return true end
TaskPlayAnim=function()table.insert(steps,'animate')end
GetPedInVehicleSeat=function()return 0 end
GetIsDoorValid=function()return true end
GetVehicleDoorAngleRatio=function()return hood end
SetVehicleDoorOpen=function(_,door)assert(door==4)hood=1 table.insert(steps,'hood')end
SetVehicleDoorShut=function(_,door)assert(door==4)hood=0 table.insert(steps,'shut')end
SetVehicleDeformationFixed=function()end
SetVehicleEngineHealth=function(_,value)engine=value end
SetVehicleBodyHealth=function()end
GetVehicleEngineHealth=function()return engine end
SetVehicleFixed=function()repairs=repairs+1 end
TriggerServerEvent=function(name,data,... )table.insert(network,{name=name,data=data,args={...}})end
commands['+fivemai_talk']()
events['fivemai:jobStart']({token='job-a',netId=44,npcId='marcel_dubois',service='repair'})
`;
test('mechanic walks beyond the vehicle front, faces the hood and animates before acknowledging arrival',()=>run(movementFixture+`
threads[3]()
assert(steps[2]=='walk' and steps[3]=='face' and steps[4]=='hood' and steps[5]=='animate')
assert(math.abs(positions[10].y-2.7)<0.001,'Stand outside the front bounding box')
assert(network[#network].name=='fivemai:jobArrived' and network[#network].args[1]==true)
assert(repairs==0,'Arrival must not itself repair the vehicle')
`));
test('mechanic refuses arrival if the car is moving and does not start work',()=>run(movementFixture+`
GetEntitySpeed=function()return 1 end
threads[3]()
assert(network[#network].name=='fivemai:jobArrived' and network[#network].args[1]==false)
for _,step in ipairs(steps)do assert(step~='animate')end
assert(repairs==0)
`));
test('repair cannot apply before the mechanic reaches the hood',()=>run(movementFixture+`
events['fivemai:jobApply']({token='job-a',netId=44,npcId='marcel_dubois',service='repair'})
threads[4]()
assert(repairs==0)
assert(network[#network].name=='fivemai:jobResult' and network[#network].args[1]~=true)
`));

test('parked vehicle repairs successfully with the player outside and the hood opened first',()=>run(movementFixture+`
threads[3]()
assert(hood==1 and network[#network].args[1]==true)
events['fivemai:jobApply']({token='job-a',netId=44,npcId='marcel_dubois',service='repair'})
threads[4]()
assert(repairs==1 and engine==1000)
assert(network[#network].name=='fivemai:jobResult' and network[#network].args[1]==true)
events['fivemai:jobEnd']({token='job-a'})
assert(hood==0,'Close the hood we opened when service finishes')
`));

test('ped root above the ground target still allows hood animation and actual repair',()=>run(movementFixture+`
TaskFollowNavMeshToCoord=function(ped,x,y,z)
 table.insert(steps,'walk');positions[ped]=vector3(x,y,z+1.0)
end
threads[3]()
assert(network[#network].name=='fivemai:jobArrived' and network[#network].args[1]==true)
assert(hood==1)
events['fivemai:jobApply']({token='job-a',netId=44,npcId='marcel_dubois',service='repair'})
threads[4]()
assert(repairs==1,'A ped standing on the floor must not fail the 3D root check')
`));
test('a ped on another floor cannot report arrival or apply the repair',()=>run(movementFixture+`
TaskFollowNavMeshToCoord=function(ped,x,y,z)positions[ped]=vector3(x,y,z+4.0)end
threads[3]()
assert(network[#network].args[1]==false)
assert(repairs==0)
`));
test('missing bonnet animation does not prevent a valid parked vehicle repair',()=>run(movementFixture+`
GetIsDoorValid=function()return false end
threads[3]()
assert(network[#network].name=='fivemai:jobArrived' and network[#network].args[1]==true)
events['fivemai:jobApply']({token='job-a',netId=44,npcId='marcel_dubois',service='repair'})
threads[4]()
assert(repairs==1)
`));
test('native error after approach reports failure instead of stranding the job',()=>run(movementFixture+`
GetIsDoorValid=function()error('hood native failed')end
threads[3]()
assert(network[#network].name=='fivemai:jobArrived' and network[#network].args[1]==false and network[#network].args[2]=='script')
assert(repairs==0)
`));

test('calm conversation stops movement, faces the player and maintains eye contact',()=>run(`
local actions={}
NetworkHasControlOfEntity=function()return true end
TaskTurnPedToFaceEntity=function(ped,player)assert(ped==10 and player==99)table.insert(actions,'face')end
TaskLookAtEntity=function(ped,player)assert(player==99)table.insert(actions,'look')end
TaskStandStill=function()table.insert(actions,'stand')end
commands['+fivemai_talk']()
assert(actions[1]=='face' and actions[2]=='look')
clock=clock+1000
FivemAIBehavior.pose(10,99,true,true,false)
assert(actions[3]=='stand' and actions[4]=='look')
`));
test('a fleeing NPC keeps running during opening and closing of conversation',()=>run(`
IsPedFleeing=function()return true end
TaskTurnPedToFaceEntity=function()error('Must not turn a fleeing NPC')end
TaskLookAtEntity=function()error('Must not hold a fleeing NPC')end
TaskStandStill=function()error('Must not stop a fleeing NPC')end
TaskWanderStandard=function()error('Must not replace a flee task')end
commands['+fivemai_talk']()
assert(FivemAIBehavior.observe(10,99)=='afraid')
events['fivemai:closed']()
`));
test('a fighting NPC is angry and never receives a conversation standstill task',()=>run(`
IsPedInCombat=function(_,target)return target==99 end
TaskTurnPedToFaceEntity=function()error('Must not interrupt combat')end
TaskStandStill=function()error('Must not stop combat')end
commands['+fivemai_talk']()
assert(FivemAIBehavior.observe(10,99)=='angry')
local mood
TriggerServerEvent=function(name,_,_,state)if name=='fivemai:offer' then mood=state end end
callbacks.offer({npcId='marcel_dubois',sdp='v=0'},function()end)
assert(mood=='angry')
`));
test('transition from calm to fear releases attention without overriding the flee task',()=>run(`
NetworkHasControlOfEntity=function()return true end
TaskTurnPedToFaceEntity=function()end
TaskLookAtEntity=function()end
commands['+fivemai_talk']()
assert(FivemAIBehavior.held[10])
IsPedFleeing=function()return true end
TaskStandStill=function()error('Must not overwrite fleeing')end
TaskWanderStandard=function()error('Must not overwrite fleeing')end
FivemAIBehavior.pose(10,99,true,true,false)
assert(not FivemAIBehavior.held[10])
events['fivemai:closed']()
`));
test('conversation attention does not overwrite mechanic movement or animation',()=>run(`
NetworkHasControlOfEntity=function()return true end
TaskTurnPedToFaceEntity=function()error('Do not turn a working mechanic')end
TaskStandStill=function()error('Do not stop a working mechanic')end
assert(FivemAIBehavior.pose(10,99,true,true,true)=='calm')
`));
test('job completion while a NPC is afraid never clears its flee task',()=>run(movementFixture+`
threads[3]()
IsPedFleeing=function()return true end
ClearPedTasks=function()error('Do not clear a flee task')end
events['fivemai:jobEnd']({token='job-a'})
`));

test('conversation opens at 3.45 meters with the updated four-meter interaction range',()=>run(`
configForTest.interactionDistance=4
GetEntityCoords=function(ped)return ped==99 and vector3(0,0,0) or vector3(3.45,0,0)end
commands['+fivemai_talk']()
assert(sent[1].type=='open' and sent[1].npc.id=='marcel_dubois')
callbacks.close({},function()end)
assert(sent[#sent].type=='closed')
`));
test('entry script does not depend on a global behavior object for open and close',()=>run(`
assert(_G.FivemAIBehavior==nil,'Behavior helpers must stay local to the entry script')
commands['+fivemai_talk']()
callbacks.close({},function()end)
commands['+fivemai_talk']()
assert(sent[#sent].type=='ptt' and sent[#sent].held==true)
`));

test('a hit from the player is linked to a subsequent flee before conversation opens',()=>run(`
gameHandlers.gameEventTriggered('CEventNetworkEntityDamage',{10,99})
IsPedFleeing=function()return true end
TaskStandStill=function()error('Do not stop the flee')end
local state,cause=FivemAIBehavior.observe(10,99)
assert(state=='afraid_player' and cause=='hit')
commands['+fivemai_talk']()
local packet
TriggerServerEvent=function(name,...)if name=='fivemai:offer' then packet={...}end end
callbacks.offer({npcId='marcel_dubois',sdp='v=0'},function()end)
assert(packet[3]=='afraid_player' and packet[5]=='hit')
`));
test('a weapon threat is remembered before the NPC flees and the player lowers the gun',()=>run(`
local aiming=true
GetEntityPlayerIsFreeAimingAt=function()return true,10 end
IsPlayerFreeAimingAtEntity=function()return aiming end
IsPedArmed=function(_,mask)return mask==6 end
FivemAIBehavior.scan(99)
aiming=false
IsPedFleeing=function()return true end
clock=clock+5000
local state,cause=FivemAIBehavior.observe(10,99)
assert(state=='afraid_player' and cause=='aim')
`));
test('targeting a NPC with a melee weapon triggers anger before blows are exchanged',()=>run(`
IsPlayerTargettingEntity=function(_,ped)return ped==10 end
IsPedArmed=function(_,mask)return mask==1 end
local state,cause=FivemAIBehavior.observe(10,99)
assert(state=='angry' and cause=='melee')
`));
test('unarmed fighting stance is detected even when weapon hash has signed representation',()=>run(`
IsPlayerTargettingEntity=function(_,ped)return ped==10 end
joaat=function(name)return name=='WEAPON_UNARMED' and 2725352035 or 123 end
GetSelectedPedWeapon=function()return -1569615261 end
local state,cause=FivemAIBehavior.observe(10,99)
assert(state=='angry' and cause=='melee')
`));
test('an unrelated flee or jogging does not identify the player as aggressor',()=>run(`
IsPedFleeing=function()return true end
IsPedShooting=function()return true end
local state,cause=FivemAIBehavior.observe(10,99)
assert(state=='afraid' and cause=='none')
IsPedFleeing=function()return false end
IsPedRunning=function()return true end
assert(FivemAIBehavior.observe(10,99)=='calm')
`));
test('damage caused by another actor is not blamed on the player',()=>run(`
gameHandlers.gameEventTriggered('CEventNetworkEntityDamage',{10,98})
IsPedFleeing=function()return true end
assert(FivemAIBehavior.observe(10,99)=='afraid')
`));
test('vehicle damage can identify the player driving the offending vehicle',()=>run(`
IsEntityAVehicle=function(entity)return entity==300 end
GetPedInVehicleSeat=function(vehicle,seat)assert(vehicle==300 and seat==-1)return 99 end
gameHandlers.gameEventTriggered('CEventNetworkEntityDamage',{10,300})
IsPedFleeing=function()return true end
local state,cause=FivemAIBehavior.observe(10,99)
assert(state=='afraid_player' and cause=='hit')
`));
test('old aggression expires after the NPC stops fleeing',()=>run(`
gameHandlers.gameEventTriggered('CEventNetworkEntityDamage',{10,99})
clock=clock+21000
FivemAIBehavior.scan(99)
assert(FivemAIBehavior.observe(10,99)=='calm')
`));
test('a recreated NPC with a different model does not inherit aggression attribution',()=>run(`
gameHandlers.gameEventTriggered('CEventNetworkEntityDamage',{10,99})
GetEntityModel=function()return 999 end
IsPedFleeing=function()return true end
assert(FivemAIBehavior.observe(10,99)=='afraid')
`));

const actionFixture=`
local played,raised,cleared,fleeing=false,0,0,false
NetworkHasControlOfEntity=function()return true end
IsPlayerFreeAimingAtEntity=function(_,ped)return ped==10 end
IsPedArmed=function(ped,mask)return ped==99 and mask==6 end
ClearPedTasks=function()cleared=cleared+1 played=false end
RequestAnimDict=function()end
HasAnimDictLoaded=function()return true end
TaskHandsUp=function()raised=raised+1 played=true fleeing=false end
TaskPlayAnim=function()played=true end
IsEntityPlayingAnim=function()return played end
IsPedFleeing=function()return fleeing end
TriggerServerEvent=function(name,...)table.insert(network,{name=name,args={...}})end
commands['+fivemai_talk']()
commands['-fivemai_talk']()
events['fivemai:actionStart']({token='action-a',action='hands_up',npcId='marcel_dubois',durationSeconds=30,maxDistance=30,releaseAfterThreatSeconds=8})
`;
test('hands-up is animated and verified before action success and preserves surrender against conversation poses',()=>run(actionFixture+`
threads[3]()
assert(raised==1 and FivemAIBehavior.surrendered[10])
assert(network[#network].name=='fivemai:actionResult' and network[#network].args[2]==true)
TaskStandStill=function()error('Do not overwrite surrender')end
assert(FivemAIBehavior.pose(10,99,true,true,false)=='surrendered')
`));
test('a lowered weapon before execution prevents surrender and never confirms success',()=>run(actionFixture+`
IsPlayerFreeAimingAtEntity=function()return false end
threads[3]()
assert(raised==0 and not FivemAIBehavior.surrendered[10])
assert(network[#network].name=='fivemai:actionResult' and network[#network].args[2]==false and network[#network].args[3]=='weapon')
`));
test('surrender ends after the player lowers the weapon and the configured grace period passes',()=>run(actionFixture+`
threads[3]()
IsPlayerFreeAimingAtEntity=function()return false end
clock=clock+9000
maintainAction()
assert(currentAction==nil and not FivemAIBehavior.surrendered[10])
assert(network[#network].name=='fivemai:actionEnded' and network[#network].args[2]=='released')
`));
test('surrender is refused when the target is armed and policy disallows it',()=>run(actionFixture+`
IsPedArmed=function()return true end
threads[3]()
assert(raised==0)
assert(network[#network].args[2]==false and network[#network].args[3]=='refused')
`));
test('native animation errors produce a failed action result and release the pending task',()=>run(actionFixture+`
TaskHandsUp=function()error('Native failed')end
threads[3]()
assert(currentAction==nil)
assert(network[#network].name=='fivemai:actionResult' and network[#network].args[2]==false and network[#network].args[3]=='script')
`));
test('a cancellation during animation loading cannot later apply or confirm surrender',()=>run(actionFixture+`
HasAnimDictLoaded=function()return false end
Wait=function(ms)clock=clock+ms events['fivemai:actionCancel']({token='action-a'})end
threads[3]()
assert(currentAction==nil and raised==0)
for _,message in ipairs(network)do assert(not(message.name=='fivemai:actionResult' and message.args[2]==true))end
`));
test('native speech is suppressed only for the active actor and restored on close',()=>run(`
configForTest.reactions={enabled=true,radius=3}
local stops,pain={},{}
StopPedSpeaking=function(ped,stop)table.insert(stops,{ped,stop})end
DisablePedPainAudio=function(ped,stop)table.insert(pain,{ped,stop})end
commands['+fivemai_talk']()
assert(stops[1][1]==10 and stops[1][2]==true)
callbacks.close({},function()end)
assert(stops[#stops][1]==10 and stops[#stops][2]==false)
assert(pain[#pain][2]==false)
`));
test('nearby threat can open spontaneous audio without N and keeps push-to-talk released',()=>run(`
configForTest.reactions={enabled=true,radius=3,autoCooldownSeconds=15,cooldownSeconds=8}
IsPlayerFreeAimingAtEntity=function(_,ped)return ped==10 end
IsPedArmed=function(ped,mask)return ped==99 and mask==6 end
local co=coroutine.create(threads[2])
Wait=function(ms)clock=clock+ms coroutine.yield()end
assert(coroutine.resume(co))
assert(coroutine.resume(co))
assert(sent[1].type=='open' and sent[2].type=='ptt' and sent[2].held==false)
local offered
TriggerServerEvent=function(name,...)if name=='fivemai:offer' then offered={...}end end
callbacks.offer({npcId='marcel_dubois',sdp='v=0'},function()end)
assert(offered[6].automatic==true and offered[6].reaction=='aim')
assert(not pressed)
`));
test('spontaneous scan ignores distant reactions and has no idle greeting',()=>run(`
configForTest.reactions={enabled=true,radius=1}
IsPlayerFreeAimingAtEntity=function()return true end
IsPedArmed=function()return true end
assert(spontaneousTarget()==nil)
configForTest.reactions.radius=3
IsPlayerFreeAimingAtEntity=function()return false end
IsPedArmed=function()return false end
assert(spontaneousTarget()==nil)
`));
test('ambient sex hint follows the actual ped native',()=>run(`
target=20
IsPedMale=function()return false end
commands['+fivemai_talk']()
threads[3]()
assert(network[1].data.sex=='female')
`));
test('following confirms a running GTA task rather than claiming movement merely from a calm state',()=>run(`
NetworkHasControlOfEntity=function()return true end
local status=7
ClearPedTasks=function()end
TaskFollowToOffsetOfEntity=function()end
GetScriptTaskStatus=function()return status end
TriggerServerEvent=function(name,...)table.insert(network,{name=name,args={...}})end
commands['+fivemai_talk']()
events['fivemai:actionStart']({token='follow-a',action='follow',npcId='marcel_dubois',durationSeconds=60})
threads[3]()
assert(network[#network].name=='fivemai:actionResult' and network[#network].args[2]==false)
`));

test('network demos are streamed from the server and never duplicated or deleted by the client',()=>run(`
assert(network[1].name=='fivemai:demoRequest')
NetworkDoesEntityExistWithNetworkId=function()return true end
NetToPed=function()return 10 end
NetworkHasControlOfEntity=function()return true end
DeleteEntity=function()error('Shared demo must only be deleted by server')end
events['fivemai:demos']({marcel_dubois=800})
local co=coroutine.create(threads[2])
Wait=function(ms)clock=clock+ms coroutine.yield()end
assert(coroutine.resume(co))
assert(coroutine.resume(co))
assert(peds.marcel_dubois==10)
gameHandlers.onResourceStop('fivemai')
`,{setup:"configForTest.demoNetwork=true\nCreatePed=function()error('Never create a duplicate network demo on client')end"}));

const vehicleActionFixture=movementFixture.slice(0,movementFixture.indexOf("events['fivemai:jobStart']"))+`
frozen=false
local entered,driven,occupants=0,0,{}
GetVehicleMaxNumberOfPassengers=function()return 3 end
IsVehicleSeatFree=function(_,seat)return occupants[seat]==nil end
GetPedInVehicleSeat=function(_,seat)return occupants[seat] or 0 end
TaskEnterVehicle=function(ped,vehicle,timeout,seat)entered=entered+1 occupants[seat]=ped end
GetVehiclePedIsIn=function()return 300 end
TaskVehicleDriveToCoordLongrange=function()driven=driven+1 end
GetScriptTaskStatus=function()return 1 end
TaskVehicleTempAction=function()end
`;
test('requested passenger boarding chooses a free seat and verifies the actual occupant',()=>run(vehicleActionFixture+`
occupants[0]=98
events['fivemai:actionStart']({token='board',action='enter_vehicle',npcId='marcel_dubois',vehicleNetId=44,durationSeconds=60})
threads[3]()
assert(entered==1 and occupants[0]==98 and occupants[1]==10)
assert(network[#network].name=='fivemai:actionResult' and network[#network].args[1]==true)
`));
test('a full vehicle refuses boarding without ejecting any occupants',()=>run(vehicleActionFixture+`
occupants[0]=98 occupants[1]=97 occupants[2]=96
events['fivemai:actionStart']({token='board',action='enter_vehicle',npcId='marcel_dubois',vehicleNetId=44,durationSeconds=60})
threads[3]()
assert(entered==0 and network[#network].args[1]==false)
`));
test('chauffeur departure requires driver ownership, player boarding and a running driving task',()=>run(vehicleActionFixture+`
events['fivemai:actionStart']({token='drive',action='drive',npcId='marcel_dubois',vehicleNetId=44,durationSeconds=150,destination={x=100,y=100,z=0}})
threads[3]()
assert(entered==1 and occupants[-1]==10 and driven==1)
assert(network[#network].name=='fivemai:actionResult' and network[#network].args[1]==true)
GetVehiclePedIsIn=function()return 0 end
maintainAction()
assert(currentAction==nil and network[#network].name=='fivemai:actionEnded')
`));
test('chauffeur never takes an occupied driver seat',()=>run(vehicleActionFixture+`
occupants[-1]=99
events['fivemai:actionStart']({token='drive',action='drive',npcId='marcel_dubois',vehicleNetId=44,durationSeconds=150,destination={x=100,y=100,z=0}})
threads[3]()
assert(entered==0 and driven==0 and occupants[-1]==99)
assert(network[#network].args[1]==false)
`));
test('chauffeur waits for the player and refuses to drive away alone',()=>run(vehicleActionFixture+`
GetVehiclePedIsIn=function()return 0 end
events['fivemai:actionStart']({token='drive',action='drive',npcId='marcel_dubois',vehicleNetId=44,durationSeconds=150,destination={x=100,y=100,z=0}})
threads[3]()
assert(driven==0 and network[#network].args[1]==false)
`));
test('approaching a vehicle confirms only when the NPC actually reaches its side',()=>run(vehicleActionFixture+`
events['fivemai:actionStart']({token='approach',action='approach_vehicle',npcId='marcel_dubois',vehicleNetId=44,durationSeconds=60})
threads[3]()
assert(network[#network].name=='fivemai:actionResult' and network[#network].args[1]==true)
assert(positions[10].x==2 and positions[10].y==0 and entered==0)
`));

test('conversation inside a vehicle never replaces the occupants tasks with standing or turning',()=>run(`
IsPedInAnyVehicle=function()return true end
TaskStandStill=function()error('Never stand a driver up')end
TaskTurnPedToFaceEntity=function()error('Never replace driving with a turn')end
assert(FivemAIBehavior.pose(10,99,true,true,false)=='calm')
`));
test('another mechanic near the demo spawn keeps its own ambient identity with shared demos',()=>run(`
configForTest.demoNetwork=true
target=20
GetEntityModel=function()return 123 end
commands['+fivemai_talk']()
threads[3]()
assert(network[1].name=='fivemai:resolve')
`));
