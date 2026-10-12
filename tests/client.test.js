const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=require('fengari');
const fixture=`
commands,events,callbacks,threads,timers,sent,network,logs = {},{},{},{},{},{},{},{}
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
function AddEventHandler()end
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
function GetEntityCoords(ped)return ped==99 and vector3(0,0,0) or vector3(2,0,0)end
function DoesEntityExist()return true end
function IsPedAPlayer(ped)return ped==99 end
function IsPedHuman()return true end
function IsEntityDead()return false end
function NetworkGetEntityIsNetworked()return true end
function NetworkRegisterEntityAsNetworked()end
function NetworkGetNetworkIdFromEntity()return 101 end
`;
function run(assertions){
 const L=lauxlib.luaL_newstate();lualib.luaL_openlibs(L);
 const source=fixture+'\n'+fs.readFileSync(path.join(__dirname,'../client/main.lua'),'utf8')+'\nthreads[1]()\n'+assertions;
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
